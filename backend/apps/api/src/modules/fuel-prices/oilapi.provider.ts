import { Decimal } from '@prisma/client/runtime/client';
import { z } from 'zod';
import { HttpError } from '../../types/http-error.js';
import { dateSchema } from './fuel-prices.validation.js';

export const intendedFuels = ['gasoline_95', 'diesel'] as const;
export const providerUrl = 'https://api.oilapi.net/v1/prices/retail?country=lb';
// Explicit LB product/unit pairs confirmed by OilAPI country metadata, 2026-11-17.
const mappings = {
  gasoline_95: { fuel: 'gasoline_95', unit: 'litre', divisor: 1 },
  diesel: { fuel: 'diesel', unit: 'litre', divisor: 1 },
  gasoline_95_20l: { fuel: 'gasoline_95', unit: '20_litres', divisor: 20 },
  diesel_20l: { fuel: 'diesel', unit: '20_litres', divisor: 20 },
} as const;
// Decimal's default 20 significant digits would round large fractional quotes during division.
const ExactDecimal = Decimal.clone({ precision: 64 });
const rowSchema = z.object({
  fuel: z.enum(['gasoline_95', 'diesel', 'gasoline_95_20l', 'diesel_20l']),
  price: z.object({ lexeme: z.string() }),
  currency: z.literal('LBP'),
  unit: z.enum(['litre', '20_litres']),
  date: dateSchema,
  kind: z.enum(['set', 'average']),
  interval: z.enum(['day', 'week', 'month', 'year']),
  series: z.string().min(1).max(240).nullish(),
  freshness: z.string().max(64).nullish(),
});
export type ReferenceQuote = {
  provider: 'oilapi';
  market: 'LB';
  fuelCode: (typeof intendedFuels)[number];
  price: string;
  providerFuelCode: string;
  providerPrice: string;
  providerUnit: string;
  conversionDivisor: number;
  currency: 'LBP';
  unit: 'litre';
  effectiveAt: Date;
  seriesKey: string;
  providerSeriesId: string | null;
  kind: string;
  interval: string;
  freshness: string | null;
};

// Numeric token source prevents JSON.parse's binary Number conversion losing price digits.
// Node >=22 is required; fail closed when source context is unavailable.
export function parseOilApi(text: string): ReferenceQuote[] {
  try {
    const body: unknown = JSON.parse(
      text,
      (key: string, value: unknown, context?: { source?: string }) =>
        key === 'price' && typeof value === 'number'
          ? { lexeme: context?.source }
          : value,
    );
    const envelope = z
      .object({
        data: z.object({
          country: z.literal('LB'),
          fuels: z.array(z.unknown()).max(200),
        }),
      })
      .parse(body);
    const quotes: ReferenceQuote[] = [];
    const identities = new Set<string>();
    for (const raw of envelope.data.fuels) {
      const code = z.object({ fuel: z.string() }).parse(raw).fuel;
      if (!Object.hasOwn(mappings, code)) continue;
      const row = rowSchema.parse(raw);
      const mapping = mappings[row.fuel];
      if (row.unit !== mapping.unit) throw new Error();
      const originalPrice = new ExactDecimal(row.price.lexeme);
      if (
        !originalPrice.isFinite() ||
        originalPrice.lessThanOrEqualTo(0) ||
        originalPrice.decimalPlaces() > 12 ||
        originalPrice.greaterThanOrEqualTo('1e18')
      )
        throw new Error();
      const price = originalPrice.dividedBy(mapping.divisor);
      if (price.decimalPlaces() > 14) throw new Error();
      const effectiveAt = new Date(`${row.date}T00:00:00Z`);
      if (effectiveAt > new Date()) throw new Error();
      const originalSeriesKey = row.series
        ? `provider:${row.series}`
        : `derived:${row.kind}:${row.interval}`;
      const seriesKey =
        mapping.divisor === 1
          ? originalSeriesKey
          : `${originalSeriesKey}:${row.fuel}:${row.unit}`;
      if (seriesKey.length > 256) throw new Error();
      const identity = `${row.fuel}:${seriesKey}:${row.date}`;
      if (identities.has(identity)) throw new Error();
      identities.add(identity);
      quotes.push({
        provider: 'oilapi',
        market: 'LB',
        fuelCode: mapping.fuel,
        price: price.toFixed(),
        providerFuelCode: row.fuel,
        providerPrice: originalPrice.toFixed(),
        providerUnit: row.unit,
        conversionDivisor: mapping.divisor,
        currency: 'LBP',
        unit: 'litre',
        effectiveAt,
        seriesKey,
        providerSeriesId: row.series ?? null,
        kind: row.kind,
        interval: row.interval,
        freshness: row.freshness ?? null,
      });
    }
    if (intendedFuels.some((fuel) => !quotes.some((q) => q.fuelCode === fuel)))
      throw new HttpError(
        'OilAPI response lacks required Lebanon gasoline_95/diesel per-litre coverage',
        502,
      );
    return quotes;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError('Invalid OilAPI reference-price response', 502);
  }
}

export async function fetchOilApi(
  apiKey: string,
  fetcher = fetch,
  timeoutMs = 8000,
): Promise<ReferenceQuote[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetcher(providerUrl, {
      headers: { 'X-API-Key': apiKey },
      signal: controller.signal,
      redirect: 'error',
    });
    if (response.status === 429)
      throw new HttpError('OilAPI quota or rate limit exceeded', 429);
    if ([401, 403].includes(response.status))
      throw new HttpError('OilAPI credentials or plan rejected', 502);
    if (!response.ok) throw new HttpError('OilAPI is unavailable', 502);
    if (
      !response.headers.get('content-type')?.includes('application/json') ||
      Number(response.headers.get('content-length') ?? 0) > 262144 ||
      !response.body
    )
      throw new HttpError('Invalid OilAPI reference-price response', 502);
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 262144)
        throw new HttpError('OilAPI response exceeds size limit', 502);
      chunks.push(part.value);
    }
    return parseOilApi(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (controller.signal.aborted)
      throw new HttpError('OilAPI request timed out', 504);
    if (error instanceof HttpError) throw error;
    throw new HttpError('OilAPI request failed', 502);
  } finally {
    clearTimeout(timer);
    try {
      await reader?.cancel();
    } catch {
      /* Response already closed. */
    }
  }
}

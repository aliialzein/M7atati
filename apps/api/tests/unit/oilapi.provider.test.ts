import {
  fetchOilApi,
  parseOilApi,
  providerUrl,
} from '../../src/modules/fuel-prices/oilapi.provider.js';
import { historySchema } from '../../src/modules/fuel-prices/fuel-prices.validation.js';
import { oilApiFixture } from '../fixtures/oilapi.js';

describe('OilAPI documented-shape synthetic fixtures; no external requests', () => {
  const twentyLitreFixture = oilApiFixture
    .replaceAll('"gasoline_95"', '"gasoline_95_20l"')
    .replaceAll('"diesel"', '"diesel_20l"')
    .replaceAll('"litre"', '"20_litres"');
  it('maps confirmed 20-litre grades explicitly and preserves exact conversion provenance', () => {
    const quotes = parseOilApi(twentyLitreFixture);
    expect(quotes[0]).toMatchObject({
      fuelCode: 'gasoline_95',
      price: '3637.5061728394506',
      unit: 'litre',
      providerFuelCode: 'gasoline_95_20l',
      providerPrice: '72750.123456789012',
      providerUnit: '20_litres',
      conversionDivisor: 20,
      market: 'LB',
      currency: 'LBP',
      freshness: 'late',
    });
    expect(quotes[1]).toMatchObject({
      fuelCode: 'diesel',
      price: '3500.00061728394505',
      providerFuelCode: 'diesel_20l',
      conversionDivisor: 20,
    });
  });
  it('does not round a 30-digit provider quote during division', () => {
    const quote = parseOilApi(
      twentyLitreFixture.replace(
        '72750.123456789012',
        '999999999999999999.123456789012',
      ),
    )[0];
    expect(quote.price).toBe('49999999999999999.9561728394506');
  });
  it('keeps stable quote identity for repeats and distinct corrected values', () => {
    const first = parseOilApi(twentyLitreFixture)[0];
    expect(parseOilApi(twentyLitreFixture)[0]).toEqual(first);
    const corrected = parseOilApi(
      twentyLitreFixture.replace('72750.123456789012', '72751.123456789012'),
    )[0];
    expect(corrected.seriesKey).toBe(first.seriesKey);
    expect(corrected.effectiveAt).toEqual(first.effectiveAt);
    expect(corrected.price).not.toBe(first.price);
    expect(corrected.providerPrice).not.toBe(first.providerPrice);
    expect(first.seriesKey).not.toBe(parseOilApi(oilApiFixture)[0].seriesKey);
  });
  it('requires the confirmed code/unit pairing and never substitutes 98 RON', () => {
    for (const invalid of [
      twentyLitreFixture.replace('"20_litres"', '"litre"'),
      twentyLitreFixture.replace('"20_litres"', '"20_liters"'),
      twentyLitreFixture.replace('gasoline_95_20l', 'gasoline_98_20l'),
      twentyLitreFixture.replace('72750.123456789012', 'null'),
    ])
      expect(() => parseOilApi(invalid)).toThrow();
  });
  it('preserves numeric token precision, native unit, grade and period', () => {
    const q = parseOilApi(oilApiFixture);
    expect(q).toHaveLength(2);
    expect(q[0]).toMatchObject({
      price: '72750.123456789012',
      market: 'LB',
      fuelCode: 'gasoline_95',
      currency: 'LBP',
      unit: 'litre',
      seriesKey: 'derived:set:week',
    });
    expect(q[0].effectiveAt.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });
  it.each([
    ['wrong market', '"LB"', '"US"'],
    ['wrong currency', '"LBP"', '"USD"'],
    ['wrong unit', '"litre"', '"20_litres"'],
    ['grade substitution', '"gasoline_95"', '"gasoline_98"'],
    ['null price', '72750.123456789012', 'null'],
    ['zero price', '72750.123456789012', '0'],
    ['negative price', '72750.123456789012', '-1'],
    ['excess scale', '72750.123456789012', '1.1234567890123'],
    ['overflow', '72750.123456789012', '1000000000000000000'],
    ['bad date', '2026-11-01', '2026-02-30'],
  ])('rejects %s', (_label, from, to) =>
    expect(() => parseOilApi(oilApiFixture.replace(from, to))).toThrow(),
  );
  it('rejects empty, malformed, partial and ambiguous batches', () => {
    for (const text of [
      'oops',
      '{}',
      '{"data":{"country":"LB","fuels":[]}}',
      oilApiFixture.replace(/,\s*\{"fuel":"diesel"[^}]*\}/, ''),
    ])
      expect(() => parseOilApi(text)).toThrow();
    const raw = JSON.parse(oilApiFixture);
    raw.data.fuels.push(raw.data.fuels[0]);
    expect(() => parseOilApi(JSON.stringify(raw))).toThrow();
  });
  it('retains provider series identity when present', () => {
    expect(
      parseOilApi(
        oilApiFixture.replace(
          '"fuel":"diesel"',
          '"series":"lb-diesel-weekly","fuel":"diesel"',
        ),
      )[1].providerSeriesId,
    ).toBe('lb-diesel-weekly');
  });
  it('uses only the fixed host and server-side header', async () => {
    const fetcher = jest.fn().mockResolvedValue(
      new Response(oilApiFixture, {
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(fetchOilApi('test-only-key', fetcher)).resolves.toHaveLength(
      2,
    );
    expect(fetcher.mock.calls[0][0]).toBe(providerUrl);
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      headers: { 'X-API-Key': 'test-only-key' },
      redirect: 'error',
    });
  });
  it.each([
    [401, 502],
    [403, 502],
    [429, 429],
    [500, 502],
  ])('sanitizes upstream HTTP %i', async (status, expected) => {
    const fetcher = jest
      .fn()
      .mockResolvedValue(new Response('private upstream details', { status }));
    await expect(fetchOilApi('test-only-key', fetcher)).rejects.toMatchObject({
      statusCode: expected,
    });
  });
  it('rejects invalid JSON/content types and oversized responses', async () => {
    for (const response of [
      new Response('invalid', {
        headers: { 'content-type': 'application/json' },
      }),
      new Response(oilApiFixture),
      new Response('x'.repeat(262145), {
        headers: { 'content-type': 'application/json' },
      }),
      new Response('{}', {
        headers: {
          'content-type': 'application/json',
          'content-length': '300000',
        },
      }),
    ]) {
      await expect(
        fetchOilApi('test-only-key', jest.fn().mockResolvedValue(response)),
      ).rejects.toMatchObject({ statusCode: 502 });
    }
  });
  it('bounds request duration', async () => {
    const fetcher: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) =>
        init!.signal!.addEventListener('abort', () =>
          reject(new Error('aborted')),
        ),
      );
    await expect(
      fetchOilApi('test-only-key', fetcher, 5),
    ).rejects.toMatchObject({ statusCode: 504 });
  });
  it('validates dates, ranges, filters and pagination', () => {
    expect(
      historySchema.parse({
        fuel: 'diesel',
        from: '2026-01-01',
        to: '2026-02-01',
        page: '2',
        limit: '1',
      }).page,
    ).toBe(2);
    for (const query of [
      { from: '2026-02-30' },
      { from: '2026-02-01', to: '2026-01-01' },
      { fuel: 'gasoline_98' },
      { page: '0' },
      { limit: '101' },
      { extra: 'x' },
    ])
      expect(historySchema.safeParse(query).success).toBe(false);
  });
});

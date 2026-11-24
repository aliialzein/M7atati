import type { Prisma } from '../../generated/prisma/client.js';

export const priceSelect = {
  id: true,
  provider: true,
  market: true,
  fuelCode: true,
  price: true,
  providerFuelCode: true,
  providerPrice: true,
  providerUnit: true,
  conversionDivisor: true,
  currency: true,
  unit: true,
  effectiveAt: true,
  fetchedAt: true,
  lastSeenAt: true,
  seriesKey: true,
  providerSeriesId: true,
  kind: true,
  interval: true,
  freshness: true,
} satisfies Prisma.FuelPriceSelect;
export type PriceRecord = Prisma.FuelPriceGetPayload<{
  select: typeof priceSelect;
}>;
export function referencePrice(row: PriceRecord) {
  const ageDays = row.effectiveAt
    ? Math.max(
        0,
        Math.floor((Date.now() - row.effectiveAt.getTime()) / 86400000),
      )
    : null;
  const staleAfter =
    { day: 2, week: 14, month: 75, year: 400 }[row.interval ?? ''] ?? 0;
  return {
    ...row,
    price: row.price?.toFixed() ?? null,
    providerPrice: row.providerPrice?.toFixed() ?? null,
    effectiveAt: row.effectiveAt?.toISOString().slice(0, 10) ?? null,
    ageDays,
    stale: ageDays === null || ageDays > staleAfter,
  };
}

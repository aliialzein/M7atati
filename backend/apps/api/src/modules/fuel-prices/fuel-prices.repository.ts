import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../database/prisma.js';
import type { ReferenceQuote } from './oilapi.provider.js';
import { priceSelect } from './fuel-prices.types.js';
import type {
  HistoryInput,
  Currency,
  sellingPriceQuery,
} from './fuel-prices.validation.js';

import type { z } from 'zod';

const scope = {
  provenance: 'external_reference',
  provider: 'oilapi',
  market: 'LB',
};

export const sellingPriceSelect = {
  id: true,
  fuelTypeId: true,
  currency: true,
  unitPriceMinor: true,
  effectiveAt: true,
  createdAt: true,
} satisfies Prisma.SellingPriceSelect;

export const sellingPricesRepository = {
  fuelType(id: number, tx: Prisma.TransactionClient) {
    return tx.fuelType.findUnique({ where: { id }, select: { id: true } });
  },
  create(
    data: Prisma.SellingPriceUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ) {
    return tx.sellingPrice.create({ data, select: sellingPriceSelect });
  },
  async history(
    input: z.infer<typeof sellingPriceQuery>,
    tx: Prisma.TransactionClient,
  ) {
    const where = {
      ...(input.fuelTypeId ? { fuelTypeId: input.fuelTypeId } : {}),
      ...(input.currency ? { currency: input.currency } : {}),
    };
    const [rows, total] = await Promise.all([
      tx.sellingPrice.findMany({
        where,
        select: sellingPriceSelect,
        orderBy: [{ effectiveAt: 'desc' }, { id: 'desc' }],
        skip: (input.page - 1) * input.limit,
        take: input.limit,
      }),
      tx.sellingPrice.count({ where }),
    ]);
    return { rows, total };
  },
  current(fuelTypeId: number, currency: Currency) {
    return prisma.sellingPrice.findFirst({
      where: { fuelTypeId, currency, effectiveAt: { lte: new Date() } },
      select: sellingPriceSelect,
      orderBy: [{ effectiveAt: 'desc' }, { id: 'desc' }],
    });
  },
};
const orderBy = [
  { effectiveAt: 'desc' },
  { lastSeenAt: 'desc' },
  { id: 'desc' },
] satisfies Prisma.FuelPriceOrderByWithRelationInput[];
export const fuelPricesRepository = {
  async claimRefresh(now: Date) {
    const key = 'oilapi:LB';
    await prisma.fuelPriceRefresh.createMany({
      data: [{ key, nextAllowedAt: new Date(0) }],
      skipDuplicates: true,
    });
    const nextAllowedAt = new Date(now.getTime() + 3600000);
    const result = await prisma.fuelPriceRefresh.updateMany({
      where: { key, nextAllowedAt: { lte: now } },
      data: { nextAllowedAt },
    });
    return { claimed: result.count === 1, nextAllowedAt };
  },
  async ingest(quotes: ReferenceQuote[], fetchedAt: Date) {
    const ordered = [...quotes].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );
    return prisma.$transaction(async (tx) => {
      await tx.fuelType.createMany({
        data: [
          { code: 'gasoline_95', name: 'Petrol 95 RON' },
          { code: 'diesel', name: 'Road diesel' },
        ],
        skipDuplicates: true,
      });
      const types = await tx.fuelType.findMany({
        where: { code: { in: ['gasoline_95', 'diesel'] } },
        select: { id: true, code: true },
      });
      const rows = ordered.map((quote) => ({
        ...quote,
        provenance: 'external_reference',
        source: 'oilapi',
        fuelTypeId: types.find((t) => t.code === quote.fuelCode)!.id,
        fetchedAt,
        lastSeenAt: fetchedAt,
      }));
      const result = await tx.fuelPrice.createMany({
        data: rows,
        skipDuplicates: true,
      });
      // Exact repeated observations retain IDs and first fetch; corrections append a distinct price.
      for (const quote of ordered) {
        const { freshness, providerSeriesId: _series, ...identity } = quote;
        void _series;
        await tx.fuelPrice.updateMany({
          where: { ...identity, lastSeenAt: { lte: fetchedAt } },
          data: { lastSeenAt: fetchedAt, freshness },
        });
      }
      return { inserted: result.count, skipped: quotes.length - result.count };
    });
  },
  current() {
    return prisma.fuelPrice.findMany({
      where: scope,
      select: priceSelect,
      orderBy,
      distinct: [
        'provider',
        'market',
        'fuelCode',
        'seriesKey',
        'currency',
        'unit',
      ],
    });
  },
  async history(input: HistoryInput) {
    const where: Prisma.FuelPriceWhereInput = {
      ...scope,
      ...(input.fuel ? { fuelCode: input.fuel } : {}),
      ...(input.from || input.to
        ? {
            effectiveAt: {
              ...(input.from
                ? { gte: new Date(`${input.from}T00:00:00Z`) }
                : {}),
              ...(input.to ? { lte: new Date(`${input.to}T00:00:00Z`) } : {}),
            },
          }
        : {}),
    };
    return prisma.$transaction(
      async (tx) => {
        const [prices, total] = await Promise.all([
          tx.fuelPrice.findMany({
            where,
            select: priceSelect,
            orderBy,
            skip: (input.page - 1) * input.limit,
            take: input.limit,
          }),
          tx.fuelPrice.count({ where }),
        ]);
        return { prices, total };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  },
};

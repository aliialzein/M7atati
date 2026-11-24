import { HttpError } from '../../types/http-error.js';
import {
  fuelPricesRepository,
  sellingPricesRepository,
  sellingPriceSelect,
} from './fuel-prices.repository.js';
import { fetchOilApi } from './oilapi.provider.js';
import { referencePrice } from './fuel-prices.types.js';
import {
  type HistoryInput,
  currencySchema,
  type Currency,
  type sellingPriceSchema,
  type sellingPriceQuery,
} from './fuel-prices.validation.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { AuthContext } from '../auth/auth.types.js';
import { employeeOrdersRepository } from '../orders/orders.repository.js';
import { moneyMinor, moneyString } from '../orders/orders.pricing.js';
import type { z } from 'zod';

const metadata = {
  provider: 'oilapi',
  market: 'LB',
  purpose: 'external_reference',
  feedDelay:
    'Plan-dependent; free feed is delayed by one UTC day. Effective dates are authoritative.',
};
export class FuelPricesService {
  constructor(
    private readonly repository = fuelPricesRepository,
    private readonly provider = fetchOilApi,
  ) {}
  async refresh() {
    const key = process.env.OILAPI_API_KEY?.trim();
    if (!key)
      throw new HttpError('OilAPI pricing credentials are not configured', 503);
    const claim = await this.repository.claimRefresh(new Date());
    if (!claim.claimed)
      throw new HttpError(
        'Reference-price refresh cooldown is active; retry later',
        429,
      );
    // Complete network validation before opening the ingestion transaction.
    const quotes = await this.provider(key);
    const fetchedAt = new Date();
    const counts = await this.repository.ingest(quotes, fetchedAt);
    return {
      ...counts,
      metadata: {
        ...metadata,
        fetchedAt,
        nextAllowedAt: claim.nextAllowedAt,
        quotes: quotes.length,
      },
    };
  }
  async current() {
    return {
      prices: (await this.repository.current()).map(referencePrice),
      metadata,
    };
  }
  async history(input: HistoryInput) {
    const { prices, total } = await this.repository.history(input);
    return {
      prices: prices.map(referencePrice),
      pagination: {
        page: input.page,
        limit: input.limit,
        total,
        totalPages: Math.ceil(total / input.limit),
      },
      metadata,
    };
  }
}
export const fuelPricesService = new FuelPricesService();

export function sellingPriceJson(
  row: Prisma.SellingPriceGetPayload<{ select: typeof sellingPriceSelect }>,
) {
  return {
    ...row,
    unitPrice: moneyString(
      row.unitPriceMinor,
      currencySchema.parse(row.currency),
    ),
    unit: 'LITER' as const,
  };
}
export const sellingPricesService = {
  async create(
    context: AuthContext,
    input: z.infer<typeof sellingPriceSchema>,
  ) {
    const unitPriceMinor = moneyMinor(input.unitPrice, input.currency);
    try {
      return await employeeOrdersRepository.writeTransaction(async (tx) => {
        await employeeOrdersRepository.lockEmployee(context.user.id, tx);
        const actor = await employeeOrdersRepository.employee(
          context.user.id,
          tx,
        );
        if (!actor?.isActive) throw new HttpError('Unauthenticated', 401);
        if (
          actor.role.name !== 'ADMIN' ||
          !actor.role.permissions.some(
            ({ permission }) => permission.key === 'pricing.update',
          )
        )
          throw new HttpError('Insufficient permissions', 403);
        if (!(await sellingPricesRepository.fuelType(input.fuelTypeId, tx)))
          throw new HttpError('Fuel type not found', 404);
        return sellingPriceJson(
          await sellingPricesRepository.create(
            {
              fuelTypeId: input.fuelTypeId,
              currency: input.currency,
              effectiveAt: input.effectiveAt,
              unitPriceMinor,
              createdBy: actor.id,
            },
            tx,
          ),
        );
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2002'
      )
        throw new HttpError(
          'A selling price already exists for that effective date',
          409,
        );
      throw error;
    }
  },
  async history(input: z.infer<typeof sellingPriceQuery>) {
    return employeeOrdersRepository.transaction(async (tx) => {
      const { rows, total } = await sellingPricesRepository.history(input, tx);
      return {
        prices: rows.map(sellingPriceJson),
        pagination: {
          page: input.page,
          limit: input.limit,
          total,
          totalPages: Math.ceil(total / input.limit),
        },
      };
    });
  },
  async current(fuelTypeId: number, currency: Currency) {
    const row = await sellingPricesRepository.current(fuelTypeId, currency);
    if (!row)
      throw new HttpError('No effective selling price is configured', 404);
    return sellingPriceJson(row);
  },
};

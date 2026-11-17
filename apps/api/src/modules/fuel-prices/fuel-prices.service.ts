import { HttpError } from '../../types/http-error.js';
import { fuelPricesRepository } from './fuel-prices.repository.js';
import { fetchOilApi } from './oilapi.provider.js';
import { referencePrice } from './fuel-prices.types.js';
import type { HistoryInput } from './fuel-prices.validation.js';

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

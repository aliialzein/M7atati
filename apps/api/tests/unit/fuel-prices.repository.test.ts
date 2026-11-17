import { prisma } from '../../src/database/prisma.js';
import { fuelPricesRepository } from '../../src/modules/fuel-prices/fuel-prices.repository.js';
import { parseOilApi } from '../../src/modules/fuel-prices/oilapi.provider.js';
import { oilApiFixture } from '../fixtures/oilapi.js';

jest.mock('../../src/database/prisma.js', () => ({
  prisma: {
    $transaction: jest.fn(),
    fuelType: { createMany: jest.fn(), findMany: jest.fn() },
    fuelPrice: { createMany: jest.fn(), updateMany: jest.fn() },
  },
}));
const db = prisma as unknown as {
  $transaction: jest.Mock;
  fuelType: { createMany: jest.Mock; findMany: jest.Mock };
  fuelPrice: { createMany: jest.Mock; updateMany: jest.Mock };
};
beforeEach(() => {
  jest.clearAllMocks();
  db.$transaction.mockImplementation((work) => work(db));
  db.fuelType.findMany.mockResolvedValue([
    { id: 1, code: 'gasoline_95' },
    { id: 2, code: 'diesel' },
  ]);
  db.fuelPrice.createMany.mockResolvedValue({ count: 2 });
  db.fuelPrice.updateMany.mockResolvedValue({ count: 1 });
});
// Unit-level persistence-call contract only; no PostgreSQL/uniqueness enforcement claim.
describe('reference-price ingestion persistence contract with mocked Prisma', () => {
  const fixture = oilApiFixture
    .replaceAll('"gasoline_95"', '"gasoline_95_20l"')
    .replaceAll('"diesel"', '"diesel_20l"')
    .replaceAll('"litre"', '"20_litres"');
  it('persists original values and normalization metadata in the same quote batch', async () => {
    await fuelPricesRepository.ingest(
      parseOilApi(fixture),
      new Date('2026-11-17'),
    );
    const args = db.fuelPrice.createMany.mock.calls[0][0];
    expect(args.skipDuplicates).toBe(true);
    expect(
      args.data.find((r: { fuelCode: string }) => r.fuelCode === 'gasoline_95'),
    ).toMatchObject({
      fuelTypeId: 1,
      price: '3637.5061728394506',
      providerPrice: '72750.123456789012',
      providerFuelCode: 'gasoline_95_20l',
      providerUnit: '20_litres',
      conversionDivisor: 20,
    });
  });
  it('reports skipped repeated quotes without overwriting original price or first fetch time', async () => {
    const quotes = parseOilApi(fixture);
    const first = new Date('2026-11-17T00:00:00Z');
    expect(await fuelPricesRepository.ingest(quotes, first)).toEqual({
      inserted: 2,
      skipped: 0,
    });
    db.fuelPrice.createMany.mockResolvedValueOnce({ count: 0 });
    expect(
      await fuelPricesRepository.ingest(
        quotes,
        new Date('2026-11-17T01:00:00Z'),
      ),
    ).toEqual({ inserted: 0, skipped: 2 });
    for (const [arg] of db.fuelPrice.updateMany.mock.calls)
      expect(Object.keys(arg.data).sort()).toEqual(['freshness', 'lastSeenAt']);
  });
  it('appends corrected values instead of updating prior observations', async () => {
    await fuelPricesRepository.ingest(parseOilApi(fixture), new Date());
    await fuelPricesRepository.ingest(
      parseOilApi(fixture.replace('72750.123456789012', '72751.123456789012')),
      new Date(),
    );
    const original = db.fuelPrice.createMany.mock.calls[0][0].data.find(
      (r: { fuelCode: string }) => r.fuelCode === 'gasoline_95',
    );
    const corrected = db.fuelPrice.createMany.mock.calls[1][0].data.find(
      (r: { fuelCode: string }) => r.fuelCode === 'gasoline_95',
    );
    expect(corrected.seriesKey).toBe(original.seriesKey);
    expect(corrected.price).not.toBe(original.price);
    expect(corrected.providerPrice).not.toBe(original.providerPrice);
    expect(corrected.providerUnit).toBe(original.providerUnit);
  });
});

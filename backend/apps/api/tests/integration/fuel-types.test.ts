import request from 'supertest';
import { app } from '../../src/app.js';
import { prisma } from '../../src/database/prisma.js';

jest.mock('../../src/database/prisma.js', () => ({
  prisma: { fuelType: { findMany: jest.fn() } },
}));
jest.mock('../../src/utils/logger.js', () => ({
  logger: { error: jest.fn() },
}));

const findMany = jest.mocked(prisma.fuelType.findMany);
beforeEach(() => {
  jest.resetAllMocks();
  findMany.mockResolvedValue([]);
});

describe('GET /api/fuel-types (mocked Prisma)', () => {
  it('returns the global catalog without authentication or CSRF proof', async () => {
    const rows = [
      { id: 83, name: 'Road diesel', code: 'diesel' },
      { id: 7, name: 'Petrol 95 RON', code: 'gasoline_95' },
      { id: 102, name: 'Additional stored grade', code: 'other_grade' },
    ];
    findMany.mockResolvedValue(rows);
    const response = await request(app).get('/api/fuel-types');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ fuelTypes: rows });
    expect(response.headers['cache-control']).toBe('no-store');
    // Verifies database ordering/select contract, not real PostgreSQL collation.
    expect(findMany).toHaveBeenCalledWith({
      select: { id: true, name: true, code: true },
      orderBy: [{ code: 'asc' }, { id: 'asc' }],
    });
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('returns an empty array when no types are stored', async () => {
    const response = await request(app).get('/api/fuel-types');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ fuelTypes: [] });
  });

  it('projects only catalog fields even if persistence returns extra fields', async () => {
    findMany.mockResolvedValue([
      {
        id: 83,
        name: 'Road diesel',
        code: 'diesel',
        prices: [{ source: 'internal', priceMinor: 999 }],
        tanks: [{ stationId: 99 }],
        orders: [{ customerName: 'private' }],
        sellingPrices: [{ createdBy: 1 }],
      } as unknown as { id: number; name: string; code: string },
    ]);
    const response = await request(app).get('/api/fuel-types');
    expect(response.body).toEqual({
      fuelTypes: [{ id: 83, name: 'Road diesel', code: 'diesel' }],
    });
  });

  it.each(['stationId=1', 'active=true', 'page=1'])(
    'rejects unsupported query %s before database access',
    async (query) => {
      const response = await request(app).get(`/api/fuel-types?${query}`);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ message: 'Invalid request' });
      expect(findMany).not.toHaveBeenCalled();
    },
  );

  it('sanitizes unexpected database failures', async () => {
    findMany.mockRejectedValue(new Error('Internal database diagnostic'));
    const response = await request(app).get('/api/fuel-types');
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ message: 'Internal Server Error' });
  });

  it.each(['post', 'patch', 'delete'] as const)(
    'does not provide a %s mutation endpoint',
    async (method) => {
      const client = request(app);
      const response = await client[method]('/api/fuel-types')
        .set('Origin', 'http://localhost:3000')
        .set('X-CSRF-Protection', '1')
        .send({ code: 'new', name: 'New' });
      expect(response.status).toBe(404);
      expect(findMany).not.toHaveBeenCalled();
    },
  );
});

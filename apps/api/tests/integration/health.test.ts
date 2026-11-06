import request from 'supertest';

import { app } from '../../src/app.js';
import { prisma } from '../../src/database/prisma.js';

jest.mock('../../src/database/prisma.js', () => ({
  prisma: { $queryRaw: jest.fn() },
}));

beforeEach(() => {
  jest.resetAllMocks();
});

describe('GET /api/health', () => {
  it('returns the API health status', async () => {
    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('GET /api/health/ready', () => {
  it('returns 200 when the query succeeds', async () => {
    jest.mocked(prisma.$queryRaw).mockResolvedValue([{ '?column?': 1 }]);
    const response = await request(app).get('/api/health/ready');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', database: 'connected' });
    expect(prisma.$queryRaw).toHaveBeenCalledWith(['SELECT 1']);
  });

  it('returns 503 without leaking database errors', async () => {
    jest
      .mocked(prisma.$queryRaw)
      .mockRejectedValue(
        new Error('Connection failed: postgresql://admin:secret@internal/db'),
      );
    const response = await request(app).get('/api/health/ready');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      status: 'error',
      database: 'disconnected',
    });
    expect(response.text).not.toMatch(
      /secret|admin|internal|postgresql|Connection failed/,
    );
  });
});

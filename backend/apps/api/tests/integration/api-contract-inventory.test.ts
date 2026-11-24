import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import request from 'supertest';
import { app } from '../../src/app.js';
import { prisma } from '../../src/database/prisma.js';
import { tokenService } from '../../src/modules/auth/token.service.js';
import { authRouter } from '../../src/modules/auth/auth.routes.js';
import { usersRouter } from '../../src/modules/users/users.routes.js';
import { stationsRouter } from '../../src/modules/stations/stations.routes.js';
import { fuelTypesRouter } from '../../src/modules/fuel-types/fuel-types.routes.js';
import { fuelPricesRouter } from '../../src/modules/fuel-prices/fuel-prices.routes.js';
import { healthRouter } from '../../src/routes/health.js';
import { adminBranchReadsRouter } from '../../src/routes/admin-branch-reads.js';
import {
  employeeOrdersRouter,
  customerOrdersRouter,
  managerOrdersRouter,
} from '../../src/modules/orders/orders.routes.js';
import {
  employeeAttendanceRouter,
  employeeShiftsRouter,
  shiftsRouter,
  attendanceRouter,
  managerAttendanceRouter,
} from '../../src/modules/attendance/attendance.routes.js';
import { managerAnalyticsRouter } from '../../src/modules/analytics/analytics.routes.js';

jest.mock('../../src/database/prisma.js', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    station: { findMany: jest.fn(), findUnique: jest.fn() },
    fuelType: { findMany: jest.fn() },
    fuelPrice: { findMany: jest.fn(), count: jest.fn() },
    $transaction: jest.fn(),
  },
}));
jest.mock('../../src/utils/logger.js', () => ({
  logger: { error: jest.fn() },
}));

interface Layer {
  handle: unknown;
  path?: string;
  match(path: string): boolean;
  route?: { path: string; methods: Record<string, boolean> };
}
const mounts: [string, unknown][] = [
  ['/api', healthRouter],
  ['/api/auth', authRouter],
  ['/api/users', usersRouter],
  ['/api/stations', stationsRouter],
  ['/api/fuel-types', fuelTypesRouter],
  ['/api/fuel-prices', fuelPricesRouter],
  ['/api/shifts', shiftsRouter],
  ['/api/attendance', attendanceRouter],
  ['/api/employee/shifts', employeeShiftsRouter],
  ['/api/employee/attendance', employeeAttendanceRouter],
  ['/api/employee/orders', employeeOrdersRouter],
  ['/api/orders', customerOrdersRouter],
  ['/api/manager', managerOrdersRouter],
  ['/api/manager', managerAnalyticsRouter],
  ['/api/manager', managerAttendanceRouter],
  ['/api/admin', adminBranchReadsRouter],
];

it('documents exactly every explicit route on every mounted router, including loop-generated routes', () => {
  const stack = (app as unknown as { _router: { stack: Layer[] } })._router
    .stack;
  const routerLayers = stack.filter(
    (layer) =>
      typeof layer.handle === 'function' &&
      Array.isArray((layer.handle as unknown as { stack?: unknown }).stack),
  );
  expect(routerLayers).toHaveLength(mounts.length);
  const actual: string[] = [];
  for (const [prefix, router] of mounts) {
    const matches = routerLayers.filter((layer) => layer.handle === router);
    expect(matches).toHaveLength(1);
    expect(matches[0].match(prefix)).toBe(true);
    expect(matches[0].path).toBe(prefix);
    for (const layer of (router as { stack: Layer[] }).stack) {
      if (!layer.route) continue;
      expect(typeof layer.route.path).toBe('string');
      for (const [method, enabled] of Object.entries(layer.route.methods)) {
        if (enabled)
          actual.push(
            `${method.toUpperCase()} ${prefix}${layer.route.path === '/' ? '' : layer.route.path}`,
          );
      }
    }
  }
  const guide = readFileSync(
    resolve('../../docs/frontend-api-guide.md'),
    'utf8',
  );
  const inventory = guide
    .split('<!-- endpoints:start -->')[1]
    .split('<!-- endpoints:end -->')[0];
  const documented = [
    ...inventory.matchAll(/^\| (GET|POST|PATCH|PUT|DELETE) \| `([^`]+)` \|/gm),
  ].map((match) => `${match[1]} ${match[2]}`);
  expect(new Set(actual).size).toBe(actual.length);
  expect(new Set(documented).size).toBe(documented.length);
  expect(documented.sort()).toEqual(actual.sort());
  expect(actual).toHaveLength(55);
});

const db = prisma as unknown as {
  user: { findUnique: jest.Mock };
  station: { findMany: jest.Mock; findUnique: jest.Mock };
  fuelType: { findMany: jest.Mock };
  fuelPrice: { findMany: jest.Mock; count: jest.Mock };
  $transaction: jest.Mock;
};
beforeEach(() => {
  jest.resetAllMocks();
  db.user.findUnique.mockResolvedValue({
    id: 1,
    name: 'Admin',
    email: 'admin@example.invalid',
    isActive: true,
    tokenVersion: 0,
    stationId: null,
    role: {
      name: 'ADMIN',
      permissions: ['stations.read', 'pricing.read', 'pricing.update'].map(
        (key) => ({ permission: { key } }),
      ),
    },
  });
  db.$transaction.mockImplementation((work) => work(db));
  db.station.findMany.mockResolvedValue([]);
  db.fuelType.findMany.mockResolvedValue([]);
  db.fuelPrice.findMany.mockResolvedValue([]);
  db.fuelPrice.count.mockResolvedValue(0);
  db.station.findUnique.mockResolvedValue({
    id: 1,
    name: 'Station',
    address: null,
    latitude: null,
    longitude: null,
    isActive: true,
    managerId: null,
    createdAt: new Date('2026-11-23T00:00:00Z'),
  });
});

it.each([
  ['/api/stations/picker?unexpected=1', 200, false],
  ['/api/stations/1?unexpected=1', 200, true],
  ['/api/auth/me?unexpected=1', 200, true],
  ['/api/fuel-types?unexpected=1', 400, false],
  ['/api/stations?unexpected=1', 400, true],
] as const)(
  'preserves documented parsed versus ignored query behavior: %s',
  async (path, status, authenticated) => {
    const call = request(app).get(path);
    if (authenticated)
      call.set('Cookie', `m7atati_access=${tokenService.issue(1).accessToken}`);
    const response = await call;
    expect(response.status).toBe(status);
    if (status === 400)
      expect(response.body).toEqual({ message: 'Invalid request' });
  },
);

it('preserves nullable station fields and ISO dates in the actual HTTP projection', async () => {
  const response = await request(app)
    .get('/api/stations/1')
    .set('Cookie', `m7atati_access=${tokenService.issue(1).accessToken}`);
  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    station: {
      id: 1,
      name: 'Station',
      address: null,
      latitude: null,
      longitude: null,
      isActive: true,
      managerId: null,
      createdAt: '2026-11-23T00:00:00.000Z',
    },
  });
});

it('preserves global CSRF denial and the JSON error envelope even on guest order writes', async () => {
  const response = await request(app).post('/api/orders/quotes').send({});
  expect(response.status).toBe(403);
  expect(response.body).toEqual({
    message: 'Invalid request origin or CSRF protection header',
  });
  expect(db.$transaction).not.toHaveBeenCalled();
});

it.each(['current', 'history'])(
  'reference price %s returns its actual empty envelope and metadata',
  async (path) => {
    const response = await request(app)
      .get(`/api/fuel-prices/${path}`)
      .set('Cookie', `m7atati_access=${tokenService.issue(1).accessToken}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      prices: [],
      metadata: {
        provider: 'oilapi',
        market: 'LB',
        purpose: 'external_reference',
        feedDelay: expect.any(String),
      },
      ...(path === 'history'
        ? { pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } }
        : {}),
    });
    expect(response.headers['cache-control']).toBe('no-store');
  },
);

it('reference refresh preserves its explicit safe 503 without provider credentials or network access', async () => {
  const previous = process.env.OILAPI_API_KEY;
  delete process.env.OILAPI_API_KEY;
  try {
    const response = await request(app)
      .post('/api/fuel-prices/refresh')
      .set('Cookie', `m7atati_access=${tokenService.issue(1).accessToken}`)
      .set('Origin', 'http://localhost:3000')
      .set('X-CSRF-Protection', '1')
      .send({});
    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      message: 'OilAPI pricing credentials are not configured',
    });
    expect(db.$transaction).not.toHaveBeenCalled();
  } finally {
    if (previous === undefined) delete process.env.OILAPI_API_KEY;
    else process.env.OILAPI_API_KEY = previous;
  }
});

it('reference pricing denies a manager despite a pricing.read grant', async () => {
  db.user.findUnique.mockResolvedValue({
    id: 1,
    isActive: true,
    tokenVersion: 0,
    name: 'Manager',
    email: 'manager@example.invalid',
    stationId: null,
    role: {
      name: 'MANAGER',
      permissions: [{ permission: { key: 'pricing.read' } }],
    },
  });
  const response = await request(app)
    .get('/api/fuel-prices/current')
    .set('Cookie', `m7atati_access=${tokenService.issue(1).accessToken}`);
  expect(response.status).toBe(403);
  expect(response.body).toEqual({ message: 'Insufficient permissions' });
  expect(db.fuelPrice.findMany).not.toHaveBeenCalled();
});

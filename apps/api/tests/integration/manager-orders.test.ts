import request from 'supertest';
import { app } from '../../src/app.js';
import { prisma } from '../../src/database/prisma.js';
import { ACCESS_COOKIE } from '../../src/modules/auth/auth.types.js';
import { tokenService } from '../../src/modules/auth/token.service.js';
import * as demoData from '../../src/modules/orders/orders.demo.js';

jest.mock('../../src/database/prisma.js', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    station: { findFirst: jest.fn() },
  },
}));
jest.mock('../../src/utils/logger.js', () => ({
  logger: { error: jest.fn() },
}));

const db = prisma as unknown as {
  user: { findUnique: jest.Mock };
  station: { findFirst: jest.Mock };
};
let role: string;
let permissions: string[];
let actorId: number;
let stationId: number | null;
let active: boolean;
let stations: {
  id: number;
  managerId: number;
  name: string;
  isActive: boolean;
}[];
const base = '/api/manager/stations/10/orders';

function get(
  query: Record<string, string | number | undefined> = {},
  path = base,
  authenticated = true,
) {
  const pending = request(app).get(path).query(query);
  if (authenticated)
    pending.set(
      'Cookie',
      `${ACCESS_COOKIE}=${tokenService.issue(actorId).accessToken}`,
    );
  return pending;
}

beforeEach(() => {
  jest.restoreAllMocks();
  jest.resetAllMocks();
  role = 'MANAGER';
  permissions = ['orders.read']; // No attendance.read: route permissions are independent.
  actorId = 1;
  stationId = 20; // Affiliation deliberately points at somebody else's station.
  active = true;
  stations = [
    { id: 10, managerId: 1, name: 'Historical station', isActive: false },
    { id: 11, managerId: 1, name: 'Second managed station', isActive: true },
    { id: 20, managerId: 2, name: 'Other manager station', isActive: true },
  ];
  db.user.findUnique.mockImplementation(async () => ({
    id: actorId,
    name: 'Manager',
    email: 'manager@example.invalid',
    isActive: active,
    tokenVersion: 0,
    stationId,
    role: {
      name: role,
      permissions: permissions.map((key) => ({ permission: { key } })),
    },
  }));
  db.station.findFirst.mockImplementation(
    async ({
      where,
    }: {
      where: { AND: [{ id: number }, { managerId: number }] };
    }) =>
      stations.find(
        (station) =>
          station.id === where.AND[0].id &&
          station.managerId === where.AND[1].managerId,
      ) ?? null,
  );
});

describe('manager orders authentication and station ownership', () => {
  it('requires authentication and does not consult demo data', async () => {
    const factory = jest.spyOn(demoData, 'demoOrdersForStation');
    const response = await get({}, base, false);
    expect(response.status).toBe(401);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(db.station.findFirst).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });
  it('rejects a malformed access cookie', async () => {
    expect(
      (await request(app).get(base).set('Cookie', `${ACCESS_COOKIE}=invalid`))
        .status,
    ).toBe(401);
    expect(db.station.findFirst).not.toHaveBeenCalled();
  });
  it('rejects a disabled manager', async () => {
    active = false;
    expect((await get()).status).toBe(401);
    expect(db.station.findFirst).not.toHaveBeenCalled();
  });
  it.each(['ADMIN', 'HR', 'EMPLOYEE', 'SECURITY', 'CUSTOMER'])(
    'rejects %s even with orders.read',
    async (value) => {
      role = value;
      expect((await get()).status).toBe(403);
      expect(db.station.findFirst).not.toHaveBeenCalled();
    },
  );
  it('requires orders.read, not attendance.read or reports.read', async () => {
    permissions = ['attendance.read', 'reports.read'];
    const response = await get();
    expect(response.status).toBe(403);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(db.station.findFirst).not.toHaveBeenCalled();
  });
  it.each([{}, { status: 'COMPLETED', minAmountMinor: 2000000000 }])(
    'returns the same 404 for unknown/unmanaged stations even for empty filters %j',
    async (query) => {
      const factory = jest.spyOn(demoData, 'demoOrdersForStation');
      for (const id of [20, 999]) {
        const response = await get(query, base.replace('/10/', `/${id}/`));
        expect(response.status).toBe(404);
        expect(response.body).toEqual({ message: 'Station not found' });
        expect(response.headers['cache-control']).toBe('no-store');
      }
      expect(factory).not.toHaveBeenCalled();
    },
  );
  it('uses managerId rather than affiliation and includes inactive managed stations', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(db.station.findFirst).toHaveBeenCalledWith({
      where: { AND: [{ id: 10 }, { managerId: 1 }] },
      select: { id: true, name: true, isActive: true },
    });
    expect(
      response.body.orders.every(
        (order: { stationId: number }) => order.stationId === 10,
      ),
    ).toBe(true);
  });
  it('rechecks ownership on every request rather than caching authorized station IDs', async () => {
    expect((await get()).status).toBe(200);
    stations[0].managerId = 2;
    expect((await get()).status).toBe(404);
  });
  it('gives distinct managed stations distinct deterministic orders', async () => {
    const a = await get();
    const b = await get({}, base.replace('/10/', '/11/'));
    expect(b.status).toBe(200);
    expect(
      b.body.orders.map((order: { stationId: number }) => order.stationId),
    ).toEqual(Array(8).fill(11));
    const idsA = a.body.orders.map((order: { id: number }) => order.id);
    const idsB = b.body.orders.map((order: { id: number }) => order.id);
    expect(idsB.some((id: number) => idsA.includes(id))).toBe(false);
    expect(
      a.body.orders.find((order: { id: number }) => order.id === 1003)
        .orderedAmountMinor,
    ).toBe(6000);
    expect(
      b.body.orders.find((order: { id: number }) => order.id === 1103)
        .orderedAmountMinor,
    ).toBe(6100);
    expect((await get()).body).toEqual(a.body);
  });
  it('cannot expose another manager fixture by switching requested station or filters', async () => {
    const station10 = demoData.demoOrdersForStation(10);
    const station20 = demoData.demoOrdersForStation(20);
    // Deliberately return a mixed dataset to ensure selection itself also scopes.
    jest
      .spyOn(demoData, 'demoOrdersForStation')
      .mockReturnValue([...station20, ...station10]);
    const own = await get();
    expect(own.body.pagination.total).toBe(8);
    expect(own.body.orders.map((order: { id: number }) => order.id)).toEqual([
      1008, 1007, 1006, 1005, 1004, 1003, 1002, 1001,
    ]);
    expect(
      (await get({ minAmountMinor: 7000, maxAmountMinor: 7000 })).body.orders,
    ).toEqual([]);
    expect((await get({}, base.replace('/10/', '/20/'))).status).toBe(404);
    actorId = 2;
    const other = await get({}, base.replace('/10/', '/20/'));
    expect(other.status).toBe(200);
    expect(other.body.orders.map((order: { id: number }) => order.id)).toEqual([
      2008, 2007, 2006, 2005, 2004, 2003, 2002, 2001,
    ]);
    expect((await get()).status).toBe(404);
  });
});

describe('manager demo order contract and selection', () => {
  it('returns only the demo contract in USD cents with default pagination', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.dataSource).toBe('demo');
    expect(response.body.pagination).toEqual({
      page: 1,
      limit: 20,
      total: 8,
      totalPages: 1,
    });
    for (const order of response.body.orders) {
      expect(Object.keys(order).sort()).toEqual([
        'createdAt',
        'currency',
        'id',
        'orderedAmountMinor',
        'stationId',
        'status',
      ]);
      expect(order.currency).toBe('USD');
      expect(Number.isSafeInteger(order.orderedAmountMinor)).toBe(true);
      expect(order.orderedAmountMinor).toBeGreaterThanOrEqual(0);
      expect(['PENDING', 'COMPLETED', 'CANCELLED']).toContain(order.status);
    }
    expect(
      response.body.orders.map((order: { id: number }) => order.id),
    ).toEqual([1008, 1007, 1006, 1005, 1004, 1003, 1002, 1001]);
  });
  it('combines station, dates, inclusive amounts and status before counting/pagination', async () => {
    const response = await get({
      from: '2026-11-19T14:00:00+02:00',
      to: '2026-11-20T02:00:00+02:00',
      minAmountMinor: 6000,
      maxAmountMinor: 6000,
      status: 'COMPLETED',
      page: 1,
      limit: 1,
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      dataSource: 'demo',
      orders: [
        {
          id: 1003,
          stationId: 10,
          status: 'COMPLETED',
          createdAt: '2026-11-19T12:00:00.000Z',
          orderedAmountMinor: 6000,
          currency: 'USD',
        },
      ],
      pagination: { page: 1, limit: 1, total: 1, totalPages: 1 },
    });
  });
  it.each([
    [
      { from: '2026-11-19T12:00:00Z', to: '2026-11-20T00:00:00Z' },
      [1004, 1003],
    ],
    [{ from: '2026-11-19T12:00:00.001Z', to: '2026-11-20T00:00:00Z' }, []],
    [
      { from: '2026-11-19T12:00:00Z', to: '2026-11-20T00:00:00.001Z' },
      [1005, 1004, 1003],
    ],
    [{ from: '2026-11-20T00:00:00Z' }, [1008, 1007, 1006, 1005]],
    [{ to: '2026-11-19T12:00:00Z' }, [1002, 1001]],
    [
      { from: '2026-11-19T07:00:00-05:00', to: '2026-11-20T02:00:00+02:00' },
      [1004, 1003],
    ],
    [{ minAmountMinor: 6000, maxAmountMinor: 6000 }, [1004, 1003]],
    [{ minAmountMinor: 6001, maxAmountMinor: 8499 }, []],
    [{ minAmountMinor: 6000 }, [1006, 1005, 1004, 1003]],
    [{ maxAmountMinor: 2250 }, [1008, 1007, 1001]],
    [{ minAmountMinor: 0, maxAmountMinor: 0 }, [1008, 1001]],
    [{ status: 'PENDING' }, [1007, 1004, 1002]],
    [{ status: 'COMPLETED' }, [1008, 1005, 1003]],
    [{ status: 'CANCELLED' }, [1006, 1001]],
  ] as const)(
    'applies half-open dates/inclusive amount/status boundaries %j',
    async (query, expected) => {
      const response = await get(query);
      expect(response.status).toBe(200);
      expect(
        response.body.orders.map((order: { id: number }) => order.id),
      ).toEqual(expected);
      expect(response.body.pagination.total).toBe(expected.length);
    },
  );
  it('paginates after all filters with consistent totals and stable tie ordering', async () => {
    const first = await get({ minAmountMinor: 3500, limit: 2 });
    const second = await get({ minAmountMinor: 3500, limit: 2, page: 2 });
    const third = await get({ minAmountMinor: 3500, limit: 2, page: 3 });
    expect(first.body.orders.map((order: { id: number }) => order.id)).toEqual([
      1006, 1005,
    ]);
    expect(second.body.orders.map((order: { id: number }) => order.id)).toEqual(
      [1004, 1003],
    );
    expect(third.body.orders.map((order: { id: number }) => order.id)).toEqual([
      1002,
    ]);
    for (const [index, response] of [first, second, third].entries())
      expect(response.body.pagination).toEqual({
        page: index + 1,
        limit: 2,
        total: 5,
        totalPages: 3,
      });
  });
  it('returns an empty page without losing the filtered total', async () => {
    const response = await get({ page: 1000000, limit: 100 });
    expect(response.status).toBe(200);
    expect(response.body.orders).toEqual([]);
    expect(response.body.pagination).toEqual({
      page: 1000000,
      limit: 100,
      total: 8,
      totalPages: 1,
    });
  });
  it('returns zero totals for an unmatched selection', async () => {
    const response = await get({ from: '2030-01-01T00:00:00Z' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      dataSource: 'demo',
      orders: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });
  });
  it('allows zero and the maximum supported amount bounds', async () => {
    expect(
      (await get({ minAmountMinor: 0, maxAmountMinor: 2147483647, limit: 100 }))
        .body.pagination.total,
    ).toBe(8);
  });
});

describe('manager orders request validation', () => {
  it.each([
    { from: '2026-11-19' },
    { from: '2026-11-19T12:00:00' },
    { from: '2026-02-30T12:00:00Z' },
    { from: '2026-11-19T12:00:00.0001Z' },
    { from: '2026-11-19T12:00:00+99:99' },
    { from: '2026-11-20T00:00:00Z', to: '2026-11-19T00:00:00Z' },
    { from: '2026-11-19T14:00:00+02:00', to: '2026-11-19T12:00:00Z' },
    { minAmountMinor: -1 },
    { maxAmountMinor: -1 },
    { minAmountMinor: 1.5 },
    { minAmountMinor: '1e3' },
    { maxAmountMinor: '0x10' },
    { minAmountMinor: '01' },
    { minAmountMinor: '+1' },
    { maxAmountMinor: ' 1' },
    { minAmountMinor: '' },
    { maxAmountMinor: 2147483648 },
    { minAmountMinor: '9007199254740992' },
    { minAmountMinor: 2, maxAmountMinor: 1 },
    { status: 'FAILED' },
    { status: 'pending' },
    { status: '' },
    { page: 0 },
    { page: 1000001 },
    { page: 1.5 },
    { limit: 0 },
    { limit: 101 },
    { limit: '1e2' },
    { unknown: 1 },
    { stationId: 20 },
    { currency: 'EUR' },
    { employeeId: 3 },
  ])(
    'rejects invalid parameters %j with the API 400 convention',
    async (query) => {
      const response = await get(query);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ message: 'Invalid request' });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(db.station.findFirst).not.toHaveBeenCalled();
    },
  );
  it.each([
    'status=PENDING&status=COMPLETED',
    'page=1&page=2',
    'limit=1&limit=2',
    'minAmountMinor=0&minAmountMinor=1',
    'maxAmountMinor=0&maxAmountMinor=1',
    'from=2026-11-19T00:00:00Z&from=2026-11-20T00:00:00Z',
    'to=2026-11-19T00:00:00Z&to=2026-11-20T00:00:00Z',
  ])('rejects repeated query parameters %s', async (query) => {
    expect((await get({}, `${base}?${query}`)).status).toBe(400);
  });
  it.each(['0', '-1', '1e3', '2147483648', 'abc'])(
    'rejects invalid station ID %s',
    async (id) => {
      expect((await get({}, base.replace('/10/', `/${id}/`))).status).toBe(400);
      expect(db.station.findFirst).not.toHaveBeenCalled();
    },
  );
});

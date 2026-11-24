import request from 'supertest';
import { app } from '../../src/app.js';
import { prisma } from '../../src/database/prisma.js';
import { ACCESS_COOKIE } from '../../src/modules/auth/auth.types.js';
import { tokenService } from '../../src/modules/auth/token.service.js';
import {
  orderFixtures,
  matchesOrder,
  selectFields,
  type OrderFixture,
  type OrderWhere,
} from '../fixtures/orders.js';

// HTTP/application integration with mocked Prisma; no PostgreSQL claims.
jest.mock('../../src/database/prisma.js', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    station: { findFirst: jest.fn() },
    fuelOrder: {
      findMany: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
      groupBy: jest.fn(),
    },
    orderEvent: { create: jest.fn() },
    attendanceRecord: { count: jest.fn() },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  },
}));
jest.mock('../../src/utils/logger.js', () => ({
  logger: { error: jest.fn() },
}));
const db = prisma as unknown as {
  user: { findUnique: jest.Mock };
  station: { findFirst: jest.Mock };
  fuelOrder: {
    findMany: jest.Mock;
    count: jest.Mock;
    findFirst: jest.Mock;
    updateMany: jest.Mock;
    groupBy: jest.Mock;
  };
  orderEvent: { create: jest.Mock };
  attendanceRecord: { count: jest.Mock };
  $queryRaw: jest.Mock;
  $transaction: jest.Mock;
};
let role: string;
let permissions: string[];
let actorId: number;
let stationId: number | null;
let active: boolean;
let orders: OrderFixture[];
let stations: {
  id: number;
  managerId: number | null;
  name: string;
  isActive: boolean;
}[];
const base = '/api/manager/stations/10/orders';
it('exposes the grant without authorizing another manager station or trusting edited hints', async () => {
  const profile = await get({}, '/api/auth/me');
  expect(profile.status).toBe(200);
  expect(profile.body.user.permissions).toEqual(['orders.read']);
  profile.body.user.permissions.push('payments.manage');
  const foreign = await get({}, '/api/manager/stations/20/orders');
  expect(foreign.status).toBe(404);
  expect(foreign.body).toEqual({ message: 'Station not found' });
  permissions = [];
  expect(
    (await get({ permissions: JSON.stringify(profile.body.user.permissions) }))
      .status,
  ).toBe(403);
});
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
  jest.resetAllMocks();
  role = 'MANAGER';
  permissions = ['orders.read'];
  actorId = 1;
  stationId = 20;
  active = true;
  stations = [
    { id: 10, managerId: 1, name: 'Historical station', isActive: false },
    { id: 11, managerId: null, name: 'Unassigned station', isActive: true },
    { id: 20, managerId: 2, name: 'Other manager', isActive: true },
  ];
  orders = [...orderFixtures(10), ...orderFixtures(11), ...orderFixtures(20)];
  db.user.findUnique.mockImplementation(async () => ({
    id: actorId,
    name: 'Actor',
    email: 'actor@example.invalid',
    isActive: active,
    tokenVersion: 0,
    stationId,
    station: stations.find((station) => station.id === stationId) ?? null,
    role: {
      name: role,
      permissions: permissions.map((key) => ({ permission: { key } })),
    },
  }));
  db.station.findFirst.mockImplementation(
    async ({ where }) =>
      stations.find(
        (s) =>
          s.id === where.AND[0].id &&
          (!('managerId' in where.AND[1]) ||
            s.managerId === where.AND[1].managerId),
      ) ?? null,
  );
  db.$transaction.mockImplementation(
    async (work: (tx: typeof db) => Promise<unknown>) => work(db),
  );
  db.$queryRaw.mockImplementation(async (query: TemplateStringsArray) =>
    query.join('').includes('FROM stations')
      ? [
          {
            id: stationId,
            isActive: stations.find((s) => s.id === stationId)?.isActive,
          },
        ]
      : [{ id: actorId }],
  );
  db.fuelOrder.findMany.mockImplementation(
    async ({ where, select, skip, take, orderBy }) =>
      orders
        .filter((row) => matchesOrder(row, where))
        .sort(
          (a, b) =>
            (Number(a.createdAt) - Number(b.createdAt) || a.id - b.id) *
            (orderBy[0].createdAt === 'desc' ? -1 : 1),
        )
        .slice(skip, skip + take)
        .map((row) => selectFields(row, select)),
  );
  db.fuelOrder.count.mockImplementation(
    async ({ where }) =>
      orders.filter((row) => matchesOrder(row, where)).length,
  );
  db.fuelOrder.findFirst.mockImplementation(async ({ where, select }) => {
    const row = orders.find((row) => matchesOrder(row, where));
    return row ? selectFields(row, select) : null;
  });
  db.fuelOrder.updateMany.mockImplementation(async ({ where, data }) => {
    const rows = orders.filter((row) => matchesOrder(row, where));
    for (const row of rows)
      Object.assign(row, data, {
        updatedAt: new Date(),
        assignee: { id: actorId, name: 'Employee', isActive: true },
      });
    return { count: rows.length };
  });
  db.orderEvent.create.mockImplementation(async ({ data }) => {
    const row = orders.find((row) => row.id === data.orderId)!;
    const event = {
      ...data,
      id: row.events.length + 1,
      createdAt: new Date(),
      note: null,
    };
    row.events.push(event);
    return event;
  });
  db.attendanceRecord.count.mockResolvedValue(0);
  db.fuelOrder.groupBy.mockImplementation(
    async ({ where }: { where: OrderWhere }) => {
      const counts = new Map<string, number>();
      for (const row of orders.filter((row) => matchesOrder(row, where)))
        counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
      return [...counts].map(([status, count]) => ({
        status,
        _count: { _all: count },
      }));
    },
  );
});

describe('manager persisted order access', () => {
  it('allows executive reads at both branches and rejects a manager on the executive route', async () => {
    const other = '/api/admin/stations/20/orders';
    permissions = ['orders.read', 'stations.read'];
    expect((await get({}, other)).status).toBe(403);
    expect(db.$transaction).not.toHaveBeenCalled();

    role = 'ADMIN';
    expect((await get({}, '/api/admin/stations/10/orders')).status).toBe(200);
    const response = await get({}, other);
    expect(response.status).toBe(200);
    expect(response.body.stationId).toBe(20);
    expect(response.body.orders.length).toBeGreaterThan(0);
    expect(
      (await get({}, `${other}/${response.body.orders[0].id}`)).status,
    ).toBe(200);
    expect(
      (
        await get(
          {},
          `/api/admin/stations/10/orders/${response.body.orders[0].id}`,
        )
      ).status,
    ).toBe(404);
  });

  it.each(['', '/1002'])(
    'requires authentication for %s before resource reads',
    async (suffix) => {
      const response = await get({}, base + suffix, false);
      expect(response.status).toBe(401);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(db.$transaction).not.toHaveBeenCalled();
    },
  );
  it('rejects a malformed cookie and disabled manager', async () => {
    expect(
      (await request(app).get(base).set('Cookie', `${ACCESS_COOKIE}=invalid`))
        .status,
    ).toBe(401);
    active = false;
    expect((await get()).status).toBe(401);
  });
  it.each(['ADMIN', 'HR', 'EMPLOYEE', 'SECURITY', 'CUSTOMER'])(
    'denies %s on list and detail',
    async (value) => {
      role = value;
      expect((await get()).status).toBe(403);
      expect((await get({}, `${base}/1002`)).status).toBe(403);
      expect(db.$transaction).not.toHaveBeenCalled();
    },
  );
  it('requires orders.read independently on list and detail', async () => {
    permissions = ['attendance.read', 'reports.read'];
    expect((await get()).status).toBe(403);
    expect((await get({}, `${base}/1002`)).status).toBe(403);
  });
  it.each([{}, { status: 'COMPLETED', minAmountMinor: 2000000000 }])(
    'does not leak unmanaged stations for %j',
    async (query) => {
      for (const id of [20, 999]) {
        for (const suffix of ['', '/1002']) {
          const response = await get(
            suffix ? {} : query,
            base.replace('/10/', `/${id}/`) + suffix,
          );
          expect(response.status).toBe(404);
          expect(response.body).toEqual({ message: 'Station not found' });
        }
      }
      expect(db.fuelOrder.findMany).not.toHaveBeenCalled();
      expect(db.fuelOrder.findFirst).not.toHaveBeenCalled();
    },
  );
  it('uses ownership rather than affiliation and permits inactive station history', async () => {
    expect((await get()).status).toBe(200);
    expect(db.station.findFirst).toHaveBeenCalledWith({
      where: { AND: [{ id: 10 }, { managerId: 1 }] },
      select: { id: true, name: true, isActive: true },
    });
    stations[0].managerId = null;
    expect((await get()).status).toBe(404);
    expect((await get({}, `${base}/1002`)).status).toBe(404);
    stations[2].managerId = null;
    stations[0].managerId = 2;
    actorId = 2;
    expect((await get()).status).toBe(200);
    expect((await get({}, `${base}/1002`)).status).toBe(200);
  });
  it('isolates reassigned stations and other managers', async () => {
    stations[0].managerId = null;
    stations[1].managerId = 1;
    expect((await get()).status).toBe(404);
    expect(
      (await get({}, base.replace('/10/', '/11/'))).body.orders.map(
        (o: { stationId: number }) => o.stationId,
      ),
    ).toEqual(Array(8).fill(11));
    actorId = 2;
    expect(
      (await get({}, base.replace('/10/', '/20/'))).body.orders.map(
        (o: { stationId: number }) => o.stationId,
      ),
    ).toEqual(Array(8).fill(20));
    expect((await get()).status).toBe(404);
  });
});

describe('persisted Manager listing and detail', () => {
  it('reads unpaid deferred-pump orders and their creation history without exposing checkout credentials', async () => {
    const row = orders.find((order) => order.id === 1002)!;
    Object.assign(row, {
      status: 'AWAITING_PAYMENT',
      source: 'GUEST',
      currency: 'USD',
      fulfillmentType: 'IN_STATION',
      pumpId: null,
      pump: null,
      orderedAmountMinor: 2513,
      guestTokenHash: 'private-guest-hash',
      creationRequestHash: 'private-request-hash',
      events: [
        {
          id: 1,
          actorUserId: null,
          actorType: 'GUEST',
          fromStatus: null,
          toStatus: 'AWAITING_PAYMENT',
          createdAt: row.createdAt,
          note: null,
        },
      ],
    });
    const list = await get({ status: 'AWAITING_PAYMENT' });
    expect(list.status).toBe(200);
    expect(list.body.pagination.total).toBe(1);
    expect(list.body.orders[0]).toMatchObject({
      id: 1002,
      currency: 'USD',
      fulfillmentType: 'IN_STATION',
      pump: null,
      assignedEmployeeId: null,
      orderedAmountMinor: 2513,
    });
    const detail = await get({}, `${base}/1002`);
    expect(detail.status).toBe(200);
    expect(detail.body.order.events).toEqual([
      expect.objectContaining({
        actorType: 'GUEST',
        toStatus: 'AWAITING_PAYMENT',
      }),
    ]);
    expect(detail.text + list.text).not.toMatch(
      /guestToken|creationRequestHash|private-/,
    );
    permissions = ['orders.read', 'attendance.read', 'reports.read'];
    const analytics = await get({}, base.replace('/orders', '/analytics'));
    expect(analytics.body.orders.countsByStatus.AWAITING_PAYMENT).toBe(1);
    expect(analytics.body.orders.totalOrders).toBe(8);
  });
  it('returns stored fields and assignee without inventing currency or exposing private relations', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      dataSource: 'database',
      stationId: 10,
      pagination: { page: 1, limit: 20, total: 8, totalPages: 1 },
    });
    expect(response.body.orders.map((o: { id: number }) => o.id)).toEqual([
      1008, 1007, 1006, 1005, 1004, 1003, 1002, 1001,
    ]);
    expect(response.body.orders[1]).toMatchObject({
      status: 'IN_PROGRESS',
      assignedEmployeeId: 3,
      assignee: { id: 3, name: 'Historical employee', isActive: false },
      source: 'PERSISTED_TEST',
      orderedVolume: '25.125',
    });
    expect(response.text).not.toMatch(
      /private-|password|customerPhone|payments|email/,
    );
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead',
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
    [{ status: 'PENDING' }, [1004, 1002]],
    [{ status: 'IN_PROGRESS' }, [1007]],
    [{ status: 'COMPLETED' }, [1008, 1005, 1003]],
    [{ status: 'CANCELLED' }, [1006, 1001]],
  ] as const)(
    'applies half-open dates and inclusive amounts/status %j',
    async (query, ids) => {
      const response = await get(query);
      expect(response.status).toBe(200);
      expect(response.body.orders.map((o: { id: number }) => o.id)).toEqual(
        ids,
      );
      expect(response.body.pagination.total).toBe(ids.length);
    },
  );
  it('combines all filters before paging and counting', async () => {
    const response = await get({
      from: '2026-11-19T14:00:00+02:00',
      to: '2026-11-20T02:00:00+02:00',
      minAmountMinor: 6000,
      maxAmountMinor: 6000,
      status: 'COMPLETED',
      limit: 1,
    });
    expect(response.body.orders.map((o: { id: number }) => o.id)).toEqual([
      1003,
    ]);
    expect(response.body.pagination.total).toBe(1);
  });
  it('paginates deterministically and retains totals on empty pages', async () => {
    const ids: number[] = [];
    for (let page = 1; page <= 3; page++) {
      const response = await get({ minAmountMinor: 3500, limit: 2, page });
      ids.push(...response.body.orders.map((o: { id: number }) => o.id));
      expect(response.body.pagination).toEqual({
        page,
        limit: 2,
        total: 5,
        totalPages: 3,
      });
    }
    expect(ids).toEqual([1006, 1005, 1004, 1003, 1002]);
    expect((await get({ page: 1000000, limit: 100 })).body).toMatchObject({
      orders: [],
      pagination: { total: 8 },
    });
  });
  it('handles empty persisted stations and allows full integer amount bounds', async () => {
    expect(
      (await get({ minAmountMinor: 0, maxAmountMinor: 2147483647 })).body
        .pagination.total,
    ).toBe(8);
    orders = orders.filter((o) => o.stationId !== 10);
    expect((await get()).body).toEqual({
      dataSource: 'database',
      stationId: 10,
      orders: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });
  });
  it('scopes order IDs after explicit reassignment to another station', async () => {
    for (const id of [1102, 2002, 9999])
      expect((await get({}, `${base}/${id}`)).status).toBe(404);
    stations[0].managerId = null;
    stations[1].managerId = 1;
    expect((await get({}, base.replace('/10/', '/11/') + '/1102')).status).toBe(
      200,
    );
  });
  it('returns chronological persisted history with ID tie-breaking and a nullable actor', async () => {
    const row = orders.find((o) => o.id === 1003)!;
    const createdAt = new Date('2026-11-19T12:00:00Z');
    row.events = [
      {
        id: 3,
        createdAt,
        actorUserId: 3,
        actorType: 'EMPLOYEE',
        fromStatus: 'IN_PROGRESS',
        toStatus: 'COMPLETED',
        note: null,
      },
      {
        id: 1,
        createdAt: new Date('2026-11-19T11:00:00Z'),
        actorUserId: null,
        actorType: 'SYSTEM',
        fromStatus: null,
        toStatus: 'PENDING',
        note: 'Created',
      },
      {
        id: 2,
        createdAt,
        actorUserId: 3,
        actorType: 'EMPLOYEE',
        fromStatus: 'PENDING',
        toStatus: 'IN_PROGRESS',
        note: null,
      },
    ];
    const response = await get({}, `${base}/1003`);
    expect(response.status).toBe(200);
    expect(response.body.order.events.map((e: { id: number }) => e.id)).toEqual(
      [1, 2, 3],
    );
    expect(response.body.order.events[0]).toMatchObject({
      actorUserId: null,
      note: 'Created',
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.text).not.toMatch(
      /private-|password|customerPhone|payments|email/,
    );
  });
  it('exposes no Manager mutation endpoint', async () => {
    // The later attendance router authenticates unmatched Manager paths too.
    permissions = ['orders.read', 'attendance.read'];
    expect(
      (
        await request(app)
          .post(`${base}/1002/claim`)
          .set(
            'Cookie',
            `${ACCESS_COOKIE}=${tokenService.issue(actorId).accessToken}`,
          )
          .set('Origin', 'http://localhost:3000')
          .set('X-CSRF-Protection', '1')
      ).status,
    ).toBe(404);
    expect(db.fuelOrder.updateMany).not.toHaveBeenCalled();
    expect(db.orderEvent.create).not.toHaveBeenCalled();
  });
  it('shows Employee claim and completion in subsequent Manager list/detail/analytics reads', async () => {
    stations[0].isActive = true;
    const employeeAction = async (action: string) => {
      actorId = 3;
      role = 'EMPLOYEE';
      stationId = 10;
      permissions = ['orders.read', 'orders.update'];
      const response = await request(app)
        .post(`/api/employee/orders/1002/${action}`)
        .set('Cookie', `${ACCESS_COOKIE}=${tokenService.issue(3).accessToken}`)
        .set('Origin', 'http://localhost:3000')
        .set('X-CSRF-Protection', '1');
      expect(response.status).toBe(200);
      actorId = 1;
      role = 'MANAGER';
      permissions = ['orders.read', 'attendance.read', 'reports.read'];
    };
    await employeeAction('claim');
    expect(
      (await get({ status: 'IN_PROGRESS' })).body.orders.map(
        (o: { id: number }) => o.id,
      ),
    ).toContain(1002);
    expect((await get({}, `${base}/1002`)).body.order).toMatchObject({
      assignedEmployeeId: 3,
      status: 'IN_PROGRESS',
      events: [expect.objectContaining({ toStatus: 'IN_PROGRESS' })],
    });
    expect(
      (await get({}, base.replace('/orders', '/analytics'))).body.orders
        .countsByStatus.IN_PROGRESS,
    ).toBe(2);
    await employeeAction('complete');
    expect(
      (await get({ status: 'COMPLETED' })).body.orders.map(
        (o: { id: number }) => o.id,
      ),
    ).toContain(1002);
    expect(
      (await get({}, `${base}/1002`)).body.order.events.map(
        (e: { toStatus: string }) => e.toStatus,
      ),
    ).toEqual(['IN_PROGRESS', 'COMPLETED']);
    expect(
      (await get({}, base.replace('/orders', '/analytics'))).body.orders
        .countsByStatus,
    ).toEqual({
      AWAITING_PAYMENT: 0,
      PENDING: 1,
      IN_PROGRESS: 1,
      COMPLETED: 4,
      CANCELLED: 2,
    });
  });
  it.each([
    '/0',
    '/abc',
    '/2147483648',
    '/1002?stationId=20',
    '/1002?status=PENDING',
  ])('rejects invalid detail parameters %s', async (suffix) => {
    expect((await get({}, base + suffix)).status).toBe(400);
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

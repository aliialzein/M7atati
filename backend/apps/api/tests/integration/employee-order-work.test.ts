import request from 'supertest';
import { app } from '../../src/app.js';
import { prisma } from '../../src/database/prisma.js';
import { ACCESS_COOKIE } from '../../src/modules/auth/auth.types.js';
import { tokenService } from '../../src/modules/auth/token.service.js';

jest.mock('../../src/database/prisma.js', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    fuelOrder: {
      findMany: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
    },
    orderEvent: { create: jest.fn() },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  },
}));
jest.mock('../../src/utils/logger.js', () => ({
  logger: { error: jest.fn() },
}));
const db = prisma as unknown as {
  user: { findUnique: jest.Mock };
  fuelOrder: {
    findMany: jest.Mock;
    count: jest.Mock;
    findFirst: jest.Mock;
    updateMany: jest.Mock;
  };
  orderEvent: { create: jest.Mock };
  $queryRaw: jest.Mock;
  $transaction: jest.Mock;
};
type Row = {
  id: number;
  stationId: number;
  status: string;
  assignedEmployeeId: number | null;
  claimedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  dispensedVolume: null;
  finalMinor: null;
};
let rows: Row[];
let events: Record<string, unknown>[];
let actor: number;
let station: number | null;
let active: boolean;
let stationActive: boolean;
let role: string;
let permissions: string[];
const base = '/api/employee/orders';
function call(
  path: string,
  method: 'get' | 'post' = 'get',
  options: { auth?: boolean; csrf?: boolean; body?: object } = {},
) {
  const pending = request(app)[method](`${base}${path}`);
  if (options.auth !== false)
    pending.set(
      'Cookie',
      `${ACCESS_COOKIE}=${tokenService.issue(actor).accessToken}`,
    );
  if (method === 'post' && options.csrf !== false)
    pending
      .set('X-CSRF-Protection', '1')
      .set('Origin', 'http://localhost:3000');
  if (options.body !== undefined) pending.send(options.body);
  return pending;
}
function matches(row: Row, where: Partial<Row>) {
  return Object.entries(where).every(
    ([key, value]) => row[key as keyof Row] === value,
  );
}
function selected(row: Row, select: Record<string, unknown>) {
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(select)) {
    output[key] =
      key === 'events'
        ? events
            .filter((event) => event.orderId === row.id)
            .map((event) => {
              const safe = { ...event };
              delete safe.orderId;
              return safe;
            })
        : key === 'pump'
          ? { id: 1, number: 2 }
          : key === 'fuelType'
            ? { id: 1, name: 'Fuel', code: 'TEST' }
            : key === 'orderedVolume'
              ? '25'
              : row[key as keyof Row];
  }
  return output;
}
beforeEach(() => {
  jest.resetAllMocks();
  actor = 3;
  station = 10;
  active = true;
  stationActive = true;
  role = 'EMPLOYEE';
  permissions = ['orders.read', 'orders.update'];
  events = [];
  rows = [1, 2, 3, 4].map((id) => ({
    id,
    stationId: id === 4 ? 20 : 10,
    status: 'PENDING',
    assignedEmployeeId: null,
    claimedAt: null,
    createdAt: new Date('2026-11-21T08:00:00Z'),
    updatedAt: new Date('2026-11-21T08:00:00Z'),
    dispensedVolume: null,
    finalMinor: null,
  }));
  db.user.findUnique.mockImplementation(async () => ({
    id: actor,
    name: 'Employee',
    email: 'employee@example.invalid',
    isActive: active,
    tokenVersion: 0,
    stationId: station,
    station: station === null ? null : { id: station, isActive: stationActive },
    role: {
      name: role,
      permissions: permissions.map((key) => ({ permission: { key } })),
    },
  }));
  db.$transaction.mockImplementation(
    async (work: (tx: typeof db) => Promise<unknown>) => {
      const before = rows.map((row) => ({ ...row }));
      const beforeEvents = [...events];
      try {
        return await work(db);
      } catch (error) {
        rows = before;
        events = beforeEvents;
        throw error;
      }
    },
  );
  db.$queryRaw.mockImplementation(async (query: TemplateStringsArray) =>
    query.join('').includes('FROM stations')
      ? [{ id: station, isActive: stationActive }]
      : [{ id: actor }],
  );
  db.fuelOrder.findFirst.mockImplementation(async ({ where, select }) => {
    const row = rows.find((row) => matches(row, where));
    return row ? selected(row, select) : null;
  });
  db.fuelOrder.findMany.mockImplementation(
    async ({ where, select, skip, take }) =>
      rows
        .filter((row) => matches(row, where))
        .slice(skip, skip + take)
        .map((row) => selected(row, select)),
  );
  db.fuelOrder.count.mockImplementation(
    async ({ where }) => rows.filter((row) => matches(row, where)).length,
  );
  db.fuelOrder.updateMany.mockImplementation(async ({ where, data }) => {
    const matching = rows.filter((row) => matches(row, where));
    matching.forEach((row) =>
      Object.assign(row, data, { updatedAt: new Date() }),
    );
    return { count: matching.length };
  });
  db.orderEvent.create.mockImplementation(async ({ data }) => {
    const event = { ...data, id: events.length + 1, createdAt: new Date() };
    events.push(event);
    return event;
  });
});
it.each(['/mine', '/1', '/1/claim', '/1/complete'])(
  'requires authentication for %s',
  async (path) => {
    const response = await call(
      path,
      path.endsWith('claim') || path.endsWith('complete') ? 'post' : 'get',
      { auth: false },
    );
    expect(response.status).toBe(401);
    expect(response.headers['cache-control']).toBe('no-store');
  },
);
it.each(['ADMIN', 'HR', 'MANAGER', 'CUSTOMER', 'SECURITY'])(
  'denies %s reads and writes',
  async (value) => {
    role = value;
    expect((await call('/1')).status).toBe(403);
    expect((await call('/mine')).status).toBe(403);
    expect((await call('/1/claim', 'post')).status).toBe(403);
  },
);
it('enforces separate read and write permissions and CSRF before any mutation', async () => {
  permissions = ['orders.read'];
  expect((await call('/1/claim', 'post')).status).toBe(403);
  permissions = ['orders.update'];
  expect((await call('/mine')).status).toBe(403);
  expect((await call('/1')).status).toBe(403);
  const denied = await call('/1/claim', 'post', { csrf: false });
  expect(denied.status).toBe(403);
  expect(denied.headers['cache-control']).toBe('no-store');
  expect(db.fuelOrder.updateMany).not.toHaveBeenCalled();
});
it.each(['/1/claim', '/1/complete'])('requires CSRF on %s', async (path) => {
  expect((await call(path, 'post', { csrf: false })).status).toBe(403);
  expect(db.fuelOrder.updateMany).not.toHaveBeenCalled();
});
it.each([
  '/4',
  '/999',
  '/4/claim',
  '/999/claim',
  '/4/complete',
  '/999/complete',
])('uses identical station-scoped 404 for %s', async (path) => {
  const response = await call(
    path,
    path.split('/').length === 3 ? 'post' : 'get',
  );
  expect(response.status).toBe(404);
  expect(response.body).toEqual({ message: 'Order not found' });
});
it('claims atomically with server metadata and a safe attributed event; repeated and delayed retries preserve it', async () => {
  const first = await call('/1/claim', 'post');
  expect(first.status).toBe(200);
  expect(first.body.order).toMatchObject({
    id: 1,
    status: 'IN_PROGRESS',
    assignedEmployeeId: 3,
  });
  expect(first.body.order.claimedAt).toBeTruthy();
  expect(first.body.order.events).toEqual([
    expect.objectContaining({
      actorUserId: 3,
      actorType: 'EMPLOYEE',
      fromStatus: 'PENDING',
      toStatus: 'IN_PROGRESS',
    }),
  ]);
  expect(db.$queryRaw).toHaveBeenCalled();
  expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: 'Serializable',
  });
  expect(db.fuelOrder.updateMany.mock.calls[0][0].where).toEqual({
    id: 1,
    stationId: 10,
    status: 'PENDING',
    assignedEmployeeId: null,
  });
  expect((await call('/1/claim', 'post')).body).toEqual(first.body);
  const completed = await call('/1/complete', 'post');
  expect(completed.body.order.status).toBe('COMPLETED');
  expect(completed.body.order.claimedAt).toBe(first.body.order.claimedAt);
  expect((await call('/1/complete', 'post')).body).toEqual(completed.body);
  expect((await call('/1/claim', 'post')).body).toEqual(completed.body);
  expect(events).toHaveLength(2);
  expect(rows[0].dispensedVolume).toBeNull();
  expect(rows[0].finalMinor).toBeNull();
  expect(Object.keys(db.fuelOrder.updateMany.mock.calls[1][0].data)).toEqual([
    'status',
  ]);
});
it('denies a competing claimant, non-assignee completion and invalid transitions', async () => {
  expect((await call('/1/complete', 'post')).status).toBe(409);
  await call('/1/claim', 'post');
  actor = 9;
  expect((await call('/1/claim', 'post')).status).toBe(409);
  expect((await call('/1/complete', 'post')).status).toBe(409);
  rows[1].status = 'CANCELLED';
  expect((await call('/2/claim', 'post')).status).toBe(409);
  rows[2].assignedEmployeeId = 3;
  expect((await call('/3/claim', 'post')).status).toBe(409);
  expect(events).toHaveLength(1);
});
it('rejects a lost conditional update without inserting an event', async () => {
  db.fuelOrder.updateMany.mockResolvedValueOnce({ count: 0 });
  expect((await call('/1/claim', 'post')).status).toBe(409);
  expect(events).toHaveLength(0);
});
it.each(['claim', 'complete'])(
  'rolls back %s if event insertion fails',
  async (action) => {
    if (action === 'complete') await call('/1/claim', 'post');
    const before = { ...rows[0] };
    const count = events.length;
    db.orderEvent.create.mockRejectedValueOnce(new Error('event failure'));
    expect((await call(`/1/${action}`, 'post')).status).toBe(500);
    expect(rows[0]).toEqual(before);
    expect(events).toHaveLength(count);
  },
);
it('rechecks permissions, employee activity, assignment and station status inside the write transaction', async () => {
  for (const denied of [
    'permission',
    'inactive',
    'station',
    'missing',
    'role',
    'transfer',
  ]) {
    permissions = ['orders.read', 'orders.update'];
    active = true;
    stationActive = true;
    station = 10;
    role = 'EMPLOYEE';
    db.$queryRaw.mockImplementationOnce(async () => {
      if (denied === 'permission') permissions = ['orders.read'];
      if (denied === 'inactive') active = false;
      if (denied === 'station') stationActive = false;
      if (denied === 'missing') station = null;
      if (denied === 'role') role = 'CUSTOMER';
      if (denied === 'transfer') station = 20;
      return [];
    });
    expect((await call('/1/claim', 'post')).status).toBe(
      denied === 'permission' || denied === 'role'
        ? 403
        : denied === 'inactive'
          ? 401
          : denied === 'transfer'
            ? 404
            : 409,
    );
  }
  expect(events).toHaveLength(0);
});
it('denies retries after transfer instead of acknowledging historical ownership', async () => {
  await call('/1/claim', 'post');
  station = 20;
  expect((await call('/1/claim', 'post')).status).toBe(404);
  expect((await call('/1/complete', 'post')).status).toBe(404);
  expect((await call('/mine')).body.orders).toEqual([]);
});
it('restores only own in-progress work, with pagination totals, while pending stays station-wide', async () => {
  await call('/1/claim', 'post');
  await call('/2/claim', 'post');
  actor = 9;
  await call('/3/claim', 'post');
  actor = 3;
  const first = await call('/mine?page=1&limit=1');
  const second = await call('/mine?page=2&limit=1');
  expect(first.body.orders.map((r: Row) => r.id)).toEqual([1]);
  expect(second.body.orders.map((r: Row) => r.id)).toEqual([2]);
  expect(first.body.pagination).toEqual({
    page: 1,
    limit: 1,
    total: 2,
    totalPages: 2,
  });
  expect((await call('')).body.pagination.total).toBe(0);
  await call('/1/complete', 'post');
  expect((await call('/mine')).body.orders.map((r: Row) => r.id)).toEqual([2]);
  const detail = await call('/1');
  expect(detail.body.order.status).toBe('COMPLETED');
  expect(detail.text).not.toMatch(
    /customer|phone|payment|Minor|dispensed|note/,
  );
  expect(
    Object.keys(
      db.fuelOrder.findFirst.mock.calls.at(-1)![0].select.events.select,
    ).sort(),
  ).toEqual([
    'actorType',
    'actorUserId',
    'createdAt',
    'fromStatus',
    'id',
    'toStatus',
  ]);
});
it.each([
  { stationId: 20 },
  { employeeId: 9 },
  { assignedEmployeeId: 9 },
  { claimedAt: '2026-11-21T00:00:00Z' },
  { status: 'COMPLETED' },
])('rejects client mutation fields %j', async (body) => {
  expect((await call('/1/claim', 'post', { body })).status).toBe(400);
  expect((await call('/1/complete', 'post', { body })).status).toBe(400);
});
it.each([
  '/mine?status=PENDING',
  '/mine?employeeId=3',
  '/mine?stationId=10',
  '/mine?page=0',
  '/mine?limit=101',
  '/1?stationId=10',
  '/abc',
  '/0',
])('rejects invalid parameters %s', async (path) => {
  expect((await call(path)).status).toBe(400);
});
it('retries serialization conflicts with a fresh transaction', async () => {
  db.$transaction.mockRejectedValueOnce({ code: 'P2034' });
  expect((await call('/1/claim', 'post')).status).toBe(200);
  expect(events).toHaveLength(1);
});

it.each(['CANCELLED', 'REJECTED', 'UNKNOWN', 'pending'])(
  'rejects both actions on unsupported state %s without events or mutation',
  async (status) => {
    rows[0].status = status;
    rows[0].assignedEmployeeId = actor;
    const before = { ...rows[0] };
    expect((await call('/1/claim', 'post')).status).toBe(409);
    expect((await call('/1/complete', 'post')).status).toBe(409);
    expect(rows[0]).toEqual(before);
    expect(events).toEqual([]);
  },
);

it('rolls back a failed claim, then permits a clean retry with exactly one event', async () => {
  db.orderEvent.create.mockRejectedValueOnce(new Error('event unavailable'));
  expect((await call('/1/claim', 'post')).status).toBe(500);
  expect((await call('/1/claim', 'post')).status).toBe(200);
  expect((await call('/1/claim', 'post')).status).toBe(200);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    fromStatus: 'PENDING',
    toStatus: 'IN_PROGRESS',
  });
});

it('returns a bounded conflict after repeated serialization failures without a phantom event', async () => {
  db.$transaction.mockRejectedValue({ code: 'P2034' });
  expect((await call('/1/claim', 'post')).status).toBe(409);
  expect(rows[0].status).toBe('PENDING');
  expect(events).toEqual([]);
});

it.each(['claim', 'complete'] as const)(
  'checks the locked station state before %s, even if the earlier employee read was active',
  async (action) => {
    if (action === 'complete') await call('/1/claim', 'post');
    const before = { ...rows[0] };
    const beforeEvents = [...events];
    db.$queryRaw.mockImplementation(async (query: TemplateStringsArray) =>
      query.join('').includes('FROM stations')
        ? [{ id: station, isActive: false }]
        : [{ id: actor }],
    );
    expect((await call(`/1/${action}`, 'post')).status).toBe(409);
    expect(rows[0]).toEqual(before);
    expect(events).toEqual(beforeEvents);
  },
);

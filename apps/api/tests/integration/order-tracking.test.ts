import request from 'supertest';
import { createHash } from 'node:crypto';
import { Decimal } from '@prisma/client/runtime/client';
import { app } from '../../src/app.js';
import { prisma } from '../../src/database/prisma.js';
import { tokenService } from '../../src/modules/auth/token.service.js';
import { ACCESS_COOKIE } from '../../src/modules/auth/auth.types.js';
import { guestOrderAccessToken } from '../../src/modules/orders/orders.guest-access.js';
import { orderStatuses } from '../../src/modules/orders/orders.types.js';
import { selectFields } from '../fixtures/orders.js';

jest.mock('../../src/database/prisma.js', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    fuelOrder: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    orderEvent: { findMany: jest.fn() },
    $transaction: jest.fn(),
  },
}));
jest.mock('../../src/utils/logger.js', () => ({
  logger: { error: jest.fn() },
}));
type Row = Record<string, unknown>;
const db = prisma as unknown as {
  user: { findUnique: jest.Mock };
  fuelOrder: { findFirst: jest.Mock; findMany: jest.Mock; count: jest.Mock };
  orderEvent: { findMany: jest.Mock };
  $transaction: jest.Mock;
};
let orders: Row[];
let events: Row[];
let users: Map<
  number,
  { role: string; active: boolean; permissions: string[] }
>;
const quoteToken = 'aa'.repeat(32);
const guestHash = createHash('sha256').update(quoteToken).digest('hex');
function guestQuote(id: number) {
  return {
    id: `guest-quote-${id}`,
    customerId: null,
    guestTokenHash: guestHash,
  };
}
function credential(id = 21) {
  return guestOrderAccessToken(id, guestQuote(id))!;
}
function get(path: string, actor?: number, token?: string) {
  const pending = request(app).get(`/api/orders${path}`);
  if (actor !== undefined)
    pending.set(
      'Cookie',
      `${ACCESS_COOKIE}=${tokenService.issue(actor).accessToken}`,
    );
  if (token !== undefined) pending.set('X-Order-Access-Token', token);
  return pending;
}
function compare(a: Row, b: Row, ascending: boolean) {
  const value =
    Number(a.createdAt) - Number(b.createdAt) || Number(a.id) - Number(b.id);
  return ascending ? value : -value;
}
beforeEach(() => {
  jest.resetAllMocks();
  users = new Map([
    [1, { role: 'CUSTOMER', active: true, permissions: ['orders.read'] }],
    [2, { role: 'CUSTOMER', active: true, permissions: ['orders.read'] }],
    [3, { role: 'MANAGER', active: true, permissions: ['orders.read'] }],
    [4, { role: 'ADMIN', active: true, permissions: ['orders.read'] }],
    [5, { role: 'EMPLOYEE', active: true, permissions: ['orders.read'] }],
    [6, { role: 'CUSTOMER', active: true, permissions: [] }],
    [7, { role: 'CUSTOMER', active: false, permissions: ['orders.read'] }],
  ]);
  db.user.findUnique.mockImplementation(async ({ where }) => {
    const u = users.get(where.id);
    return u
      ? {
          id: where.id,
          name: 'Private customer',
          email: 'private@example.invalid',
          tokenVersion: 0,
          isActive: u.active,
          stationId: null,
          station: null,
          role: {
            name: u.role,
            permissions: u.permissions.map((key) => ({ permission: { key } })),
          },
        }
      : null;
  });
  orders = [1, 2, null].flatMap((userId, ownerIndex) =>
    orderStatuses.map((status, index) => {
      const id = ownerIndex * 10 + index + 1;
      return {
        id,
        userId,
        status,
        source: userId === null ? 'GUEST' : 'CUSTOMER',
        currency: 'USD',
        orderedAmountMinor: 249,
        orderedVolume: new Decimal('1.250'),
        fulfillmentType: 'IN_STATION',
        station: {
          id: 10,
          name: 'Station',
          address: 'Public station address',
          managerId: 3,
          deviceKeyHash: 'station-secret',
          isActive: false,
        },
        fuelType: { id: 1, name: 'Fuel', code: 'FUEL', internal: 'private' },
        pump:
          status === 'AWAITING_PAYMENT'
            ? null
            : { id: 7, number: 2, status: 'IDLE', stationId: 10 },
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
        claimedAt: ['IN_PROGRESS', 'COMPLETED'].includes(status)
          ? new Date('2026-01-02T00:00:00Z')
          : null,
        scheduledFor: null,
        quote: userId === null ? guestQuote(id) : null,
        customerName: 'PRIVATE NAME',
        customerPhone: 'PRIVATE PHONE',
        notes: 'PRIVATE NOTE',
        assignedEmployeeId: 5,
        assignee: { id: 5, email: 'private-staff' },
        creationKey: 'PRIVATE KEY',
        creationRequestHash: 'PRIVATE HASH',
        payments: [{ confirmedById: 3 }],
        unitPriceMinor: 199,
      };
    }),
  );
  events = [
    {
      id: 30,
      orderId: 21,
      fromStatus: 'IN_PROGRESS',
      toStatus: 'COMPLETED',
      createdAt: new Date('2026-01-03T00:00:00Z'),
    },
    {
      id: 12,
      orderId: 21,
      fromStatus: 'PENDING',
      toStatus: 'IN_PROGRESS',
      createdAt: new Date('2026-01-02T00:00:00Z'),
    },
    {
      id: 11,
      orderId: 21,
      fromStatus: 'AWAITING_PAYMENT',
      toStatus: 'PENDING',
      createdAt: new Date('2026-01-02T00:00:00Z'),
    },
    {
      id: 1,
      orderId: 21,
      fromStatus: null,
      toStatus: 'AWAITING_PAYMENT',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    },
    {
      id: 2,
      orderId: 1,
      fromStatus: null,
      toStatus: 'AWAITING_PAYMENT',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    },
  ].map((event) => ({
    ...event,
    actorUserId: 3,
    actorType: 'MANAGER',
    note: 'PRIVATE EVENT NOTE',
  }));
  const matched = (where: Row) =>
    orders.filter((row) =>
      Object.entries(where).every(([key, value]) => row[key] === value),
    );
  db.fuelOrder.findFirst.mockImplementation(async ({ where, select }) => {
    const row = matched(where)[0];
    return row ? selectFields(row, select) : null;
  });
  db.fuelOrder.findMany.mockImplementation(
    async ({ where, select, skip, take }) =>
      matched(where)
        .sort((a, b) => compare(a, b, false))
        .slice(skip, skip + take)
        .map((row) => selectFields(row, select)),
  );
  db.fuelOrder.count.mockImplementation(
    async ({ where }) => matched(where).length,
  );
  db.orderEvent.findMany.mockImplementation(async ({ where, select }) =>
    events
      .filter((row) => row.orderId === where.orderId)
      .sort((a, b) => compare(a, b, true))
      .map((row) => selectFields(row, select)),
  );
  db.$transaction.mockImplementation(
    async (work: (tx: typeof db) => Promise<unknown>) => work(db),
  );
});

it("lists only the active authenticated customer's orders with stable descending pagination", async () => {
  const first = await get('/mine?page=1&limit=2', 1);
  expect(first.status).toBe(200);
  expect(first.headers['cache-control']).toBe('no-store');
  expect(first.body.orders.map((row: Row) => row.id)).toEqual([5, 4]);
  expect(first.body.pagination).toEqual({
    page: 1,
    limit: 2,
    total: 5,
    totalPages: 3,
  });
  expect(
    (await get('/mine?page=2&limit=2', 1)).body.orders.map(
      (row: Row) => row.id,
    ),
  ).toEqual([3, 2]);
  expect(
    (await get('/mine?page=3&limit=2', 1)).body.orders.map(
      (row: Row) => row.id,
    ),
  ).toEqual([1]);
  expect((await get('/mine?page=4&limit=2', 1)).body.orders).toEqual([]);
  expect(db.fuelOrder.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { userId: 1 },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }),
  );
});
it.each(orderStatuses)(
  'supports customer detail and filtering for %s',
  async (status) => {
    const index = orderStatuses.indexOf(status);
    const result = await get(`/${index + 1}`, 1);
    expect(result.status).toBe(200);
    expect(result.body.order.status).toBe(status);
    const history = await get(`/mine?status=${status}`, 1);
    expect(history.status).toBe(200);
    expect(history.body.orders).toHaveLength(1);
    expect(history.body.orders[0].status).toBe(status);
  },
);
it.each(orderStatuses)('supports guest detail in state %s', async (status) => {
  const id = 21 + orderStatuses.indexOf(status);
  const result = await get(`/${id}`, undefined, credential(id));
  expect(result.status).toBe(200);
  expect(result.body.order.status).toBe(status);
});
it('returns zero counts and an empty page when a customer has no orders', async () => {
  orders = orders.filter((row) => row.userId !== 1);
  const result = await get('/mine', 1);
  expect(result.status).toBe(200);
  expect(result.body).toEqual({
    orders: [],
    pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
  });
});
it.each(['/mine', '/1', '/1/events'])(
  'denies inactive customers and customers without orders.read: %s',
  async (path) => {
    expect((await get(path, 7)).status).toBe(401);
    expect((await get(path, 6)).status).toBe(403);
  },
);
it.each([3, 4, 5])(
  'denies staff actor %s even with orders.read and a valid guest credential',
  async (actor) => {
    expect((await get('/mine', actor)).status).toBe(403);
    expect((await get('/21', actor, credential())).status).toBe(403);
    expect((await get('/21/events', actor, credential())).status).toBe(403);
  },
);
it('requires authentication for mine and never treats a guest credential as customer login', async () => {
  expect((await get('/mine')).status).toBe(401);
  expect((await get('/mine', undefined, credential())).status).toBe(401);
});
it.each(['/11', '/11/events', '/21', '/21/events', '/999', '/999/events'])(
  'conceals foreign or unknown orders from customers: %s',
  async (path) => {
    expect((await get(path, 1, credential())).status).toBe(404);
    expect(db.orderEvent.findMany).not.toHaveBeenCalled();
  },
);
it.each([undefined, '', 'malformed', '00'.repeat(32), quoteToken])(
  'rejects absent, invalid and quote-only credentials: %s',
  async (token) => {
    const detail = await get('/21', undefined, token);
    expect(detail.status).toBe(404);
    expect((await get('/21/events', undefined, token)).status).toBe(404);
    expect(db.orderEvent.findMany).not.toHaveBeenCalled();
  },
);
it('binds guest access to the exact order even when quotes have identical secret hashes', async () => {
  expect((await get('/22', undefined, credential(21))).status).toBe(404);
  expect((await get('/22/events', undefined, credential(21))).status).toBe(404);
  expect((await get('/999', undefined, credential(21))).status).toBe(404);
  expect((await get('/1', undefined, credential(21))).status).toBe(404);
});
it('rejects guest legacy orders without a guest quote or with corrupt credential metadata', async () => {
  const row = orders.find((row) => row.id === 21)!;
  row.quote = null;
  expect((await get('/21', undefined, credential())).status).toBe(404);
  row.quote = { ...guestQuote(21), guestTokenHash: 'corrupt' };
  expect((await get('/21', undefined, credential())).status).toBe(404);
  row.quote = { ...guestQuote(21), customerId: 1 };
  expect((await get('/21', undefined, credential())).status).toBe(404);
});
it('does not downgrade an invalid supplied login cookie to guest access', async () => {
  const result = await get('/21', undefined, credential()).set(
    'Cookie',
    `${ACCESS_COOKIE}=invalid`,
  );
  expect(result.status).toBe(401);
});
it('allows the guest credential header in browser CORS preflight', async () => {
  const result = await request(app)
    .options('/api/orders/21')
    .set('Origin', 'http://localhost:3000')
    .set('Access-Control-Request-Method', 'GET')
    .set('Access-Control-Request-Headers', 'X-Order-Access-Token');
  expect(result.status).toBe(204);
  expect(result.headers['access-control-allow-origin']).toBe(
    'http://localhost:3000',
  );
  expect(
    result.headers['access-control-allow-headers'].toLowerCase(),
  ).toContain('x-order-access-token');
});
it('continues tracking persisted guest orders after quote expiry and station deactivation', async () => {
  orders.find((row) => row.id === 21)!.quote = {
    ...guestQuote(21),
    expiresAt: new Date(0),
  };
  expect((await get('/21', undefined, credential())).status).toBe(200);
  expect((await get('/21/events', undefined, credential())).status).toBe(200);
});
it('returns only safe order fields, including nullable pump and unknown legacy currency', async () => {
  const result = await get('/21', undefined, credential());
  expect(Object.keys(result.body.order).sort()).toEqual(
    [
      'id',
      'status',
      'currency',
      'fulfillmentType',
      'orderedAmountMinor',
      'orderedVolume',
      'createdAt',
      'updatedAt',
      'claimedAt',
      'scheduledFor',
      'station',
      'fuelType',
      'pump',
    ].sort(),
  );
  expect(result.body.order.station).toEqual({
    id: 10,
    name: 'Station',
    address: 'Public station address',
  });
  expect(result.body.order.fuelType).toEqual({
    id: 1,
    name: 'Fuel',
    code: 'FUEL',
  });
  expect(result.body.order.pump).toBeNull();
  expect(result.body.order.orderedVolume).toBe('1.25');
  const assigned = await get('/22', undefined, credential(22));
  expect(assigned.body.order.pump).toEqual({ id: 7, number: 2 });
  orders.find((row) => row.id === 1)!.currency = null;
  expect((await get('/1', 1)).body.order.currency).toBeNull();
  expect(JSON.stringify(result.body)).not.toMatch(
    /PRIVATE|guestTokenHash|quote|confirmedById|managerId|deviceKeyHash|assignee/,
  );
});
it('uses the same safe projection in customer history', async () => {
  const result = await get('/mine', 1);
  expect(JSON.stringify(result.body)).not.toMatch(
    /PRIVATE|userId|quote|assignedEmployeeId|actorUserId|confirmedById/,
  );
});
it('returns chronological safe events, with ID breaking timestamp ties', async () => {
  const result = await get('/21/events', undefined, credential());
  expect(result.status).toBe(200);
  expect(result.headers['cache-control']).toBe('no-store');
  expect(result.body.orderId).toBe(21);
  expect(result.body.events.map((event: Row) => event.id)).toEqual([
    1, 11, 12, 30,
  ]);
  for (const event of result.body.events)
    expect(Object.keys(event).sort()).toEqual(
      ['id', 'fromStatus', 'toStatus', 'createdAt'].sort(),
    );
  expect(db.orderEvent.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { orderId: 21 },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
  );
});
it('authorizes customer history and handles empty event history', async () => {
  expect(
    (await get('/1/events', 1)).body.events.map((event: Row) => event.id),
  ).toEqual([2]);
  expect((await get('/2/events', 1)).body.events).toEqual([]);
});
it('reads fresh persisted status and events in a RepeatableRead transaction', async () => {
  expect((await get('/21', undefined, credential())).body.order.status).toBe(
    'AWAITING_PAYMENT',
  );
  const row = orders.find((row) => row.id === 21)!;
  row.status = 'PENDING';
  row.pump = { id: 7, number: 2 };
  expect((await get('/21', undefined, credential())).body.order.status).toBe(
    'PENDING',
  );
  row.status = 'IN_PROGRESS';
  expect((await get('/21/events', undefined, credential())).body.status).toBe(
    'IN_PROGRESS',
  );
  row.status = 'COMPLETED';
  expect((await get('/21', undefined, credential())).body.order.status).toBe(
    'COMPLETED',
  );
  expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: 'RepeatableRead',
  });
});
it('rechecks customer permissions inside the read transaction', async () => {
  const find = db.user.findUnique.getMockImplementation()!;
  db.user.findUnique
    .mockImplementationOnce(find)
    .mockImplementationOnce(async (...args: unknown[]) => {
      users.get(1)!.permissions = [];
      return find(...args);
    });
  expect((await get('/1', 1)).status).toBe(403);
});
it.each([
  '/mine?page=0',
  '/mine?limit=101',
  '/mine?page=1.5',
  '/mine?page=1000001',
  '/mine?status=INVALID',
  '/mine?userId=2',
  '/21?guestToken=secret',
  '/21/events?token=secret',
  '/0',
  '/-1',
  '/2147483648',
])(
  'rejects invalid IDs, pagination and unrecognized query fields: %s',
  async (path) => {
    expect((await get(path, 1)).status).toBe(400);
  },
);

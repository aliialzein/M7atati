import request from 'supertest';
import { createHash } from 'node:crypto';
import { Decimal } from '@prisma/client/runtime/client';
import { app } from '../../src/app.js';
import { prisma } from '../../src/database/prisma.js';
import { tokenService } from '../../src/modules/auth/token.service.js';
import { ACCESS_COOKIE } from '../../src/modules/auth/auth.types.js';
import { selectFields } from '../fixtures/orders.js';
import { guestOrderAccessToken } from '../../src/modules/orders/orders.guest-access.js';

jest.mock('../../src/database/prisma.js', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    station: { findFirst: jest.fn() },
    fuelOrder: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      updateMany: jest.fn(),
    },
    payment: { create: jest.fn() },
    orderEvent: { create: jest.fn(), findMany: jest.fn() },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  },
}));
jest.mock('../../src/utils/logger.js', () => ({
  logger: { error: jest.fn() },
}));

type Row = Record<string, unknown>;
const db = prisma as unknown as {
  user: { findUnique: jest.Mock };
  station: { findFirst: jest.Mock };
  fuelOrder: {
    findFirst: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    updateMany: jest.Mock;
  };
  payment: { create: jest.Mock };
  orderEvent: { create: jest.Mock; findMany: jest.Mock };
  $queryRaw: jest.Mock;
  $transaction: jest.Mock;
};
let order: Row;
let otherOrders: Row[];
let payments: Row[];
let events: Row[];
let station: { id: number; managerId: number; isActive: boolean };
let pump: { id: number; stationId: number; status: string } | null;
let users: Map<
  number,
  { role: string; permissions: string[]; active: boolean }
>;
const body = { amountMinor: 249, currency: 'USD', pumpId: 7 };
const path = '/api/manager/stations/10/orders/20/confirm-cash';
function confirm(
  input: object = body,
  actor: number | undefined = 1,
  url = path,
  csrf = true,
) {
  const pending = request(app).post(url).send(input);
  if (csrf)
    pending
      .set('Origin', 'http://localhost:3000')
      .set('X-CSRF-Protection', '1');
  if (actor !== undefined)
    pending.set(
      'Cookie',
      `${ACCESS_COOKIE}=${tokenService.issue(actor).accessToken}`,
    );
  return pending;
}
function get(url: string, actor = 1) {
  return request(app)
    .get(`/api${url}`)
    .set('Cookie', `${ACCESS_COOKIE}=${tokenService.issue(actor).accessToken}`);
}
function employeeAction(action: 'claim' | 'complete') {
  return request(app)
    .post(`/api/employee/orders/20/${action}`)
    .set('Cookie', `${ACCESS_COOKIE}=${tokenService.issue(3).accessToken}`)
    .set('Origin', 'http://localhost:3000')
    .set('X-CSRF-Protection', '1')
    .send({});
}
function waitingOrder() {
  otherOrders.push({
    ...order,
    id: 21,
    status: 'AWAITING_PAYMENT',
    pumpId: null,
    assignedEmployeeId: null,
    claimedAt: null,
  });
}
function confirmWaiting() {
  return confirm(body, 1, path.replace('/20/', '/21/'));
}
function ownUnpaidOrder() {
  order.userId = 4;
  order.source = 'CUSTOMER';
  users.get(4)!.permissions = ['orders.read', 'orders.cancel'];
}
function guestUnpaidOrder() {
  const quoteToken = 'ab'.repeat(32);
  const quote = {
    id: '00000000-0000-4000-8000-000000000020',
    customerId: null,
    guestTokenHash: createHash('sha256').update(quoteToken).digest('hex'),
  };
  order.userId = null;
  order.source = 'GUEST';
  order.quote = quote;
  return { quoteToken, credential: guestOrderAccessToken(20, quote)! };
}
function cancel(
  actor: number | null = 4,
  credential?: string,
  url = '/api/orders/20/cancel',
  body: object = {},
  csrf = true,
) {
  const pending = request(app).post(url).send(body);
  if (actor !== null)
    pending.set(
      'Cookie',
      `${ACCESS_COOKIE}=${tokenService.issue(actor).accessToken}`,
    );
  if (credential !== undefined) pending.set('X-Order-Access-Token', credential);
  if (csrf)
    pending
      .set('Origin', 'http://localhost:3000')
      .set('X-CSRF-Protection', '1');
  return pending;
}
function persisted(row = order) {
  return {
    ...row,
    quote: row.quote ?? null,
    station: { id: row.stationId, name: 'Station', address: 'Station address' },
    payments: payments.filter((payment) => payment.orderId === row.id),
    events: events.filter((event) => event.orderId === row.id),
    pump: row.pumpId === null ? null : { id: row.pumpId, number: 1 },
    assignee:
      row.assignedEmployeeId === null
        ? null
        : { id: row.assignedEmployeeId, name: 'Employee', isActive: true },
  };
}
beforeEach(() => {
  jest.resetAllMocks();
  station = { id: 10, managerId: 1, isActive: true };
  pump = { id: 7, stationId: 10, status: 'IDLE' };
  payments = [];
  otherOrders = [];
  events = [];
  order = {
    id: 20,
    stationId: 10,
    status: 'AWAITING_PAYMENT',
    pumpId: null,
    currency: 'USD',
    orderedAmountMinor: 249,
    assignedEmployeeId: null,
    claimedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    orderedVolume: new Decimal('1.250'),
    fuelType: { id: 1, name: 'Fuel', code: 'FUEL' },
    source: 'GUEST',
    fulfillmentType: 'IN_STATION',
    unitPriceMinor: 199,
    dispensedVolume: null,
    finalMinor: null,
    scheduledFor: null,
    // Expired quote/order timestamps must never expire an already-created unpaid order.
    expiresAt: new Date(0),
  };
  users = new Map([
    [
      1,
      {
        role: 'MANAGER',
        permissions: ['payments.manage', 'orders.read'],
        active: true,
      },
    ],
    [2, { role: 'ADMIN', permissions: ['payments.manage'], active: true }],
    [
      3,
      {
        role: 'EMPLOYEE',
        permissions: ['payments.manage', 'orders.read', 'orders.update'],
        active: true,
      },
    ],
    [4, { role: 'CUSTOMER', permissions: ['payments.manage'], active: true }],
    [
      5,
      {
        role: 'MANAGER',
        permissions: ['payments.manage', 'orders.read'],
        active: true,
      },
    ],
  ]);
  db.user.findUnique.mockImplementation(async ({ where }) => {
    const u = users.get(where.id);
    return u
      ? {
          id: where.id,
          name: 'Staff',
          email: 'private@example.invalid',
          tokenVersion: 0,
          isActive: u.active,
          stationId: u.role === 'EMPLOYEE' ? 10 : null,
          station: u.role === 'EMPLOYEE' ? station : null,
          role: {
            name: u.role,
            permissions: u.permissions.map((key) => ({ permission: { key } })),
          },
        }
      : null;
  });
  db.$queryRaw.mockImplementation(
    async (sql: TemplateStringsArray, id: number, stationId?: number) => {
      const text = sql.join('');
      if (text.includes('FROM stations'))
        return id === station.id ? [station] : [];
      if (text.includes('FROM pumps')) return pump?.id === id ? [pump] : [];
      if (text.includes('FROM orders'))
        return [order, ...otherOrders].some(
          (row) =>
            id === row.id &&
            (stationId === undefined || stationId === row.stationId),
        )
          ? [{ id }]
          : [];
      return [{ id }];
    },
  );
  db.station.findFirst.mockImplementation(async ({ where }) => {
    const clauses = where.AND as Row[];
    return clauses[0]!.id === station.id &&
      clauses[1]!.managerId === station.managerId
      ? station
      : null;
  });
  const matches = (row: Row, where: Row) =>
    Object.entries(where).every(([key, value]) =>
      key === 'payments'
        ? !payments.some((payment) => payment.orderId === row.id)
        : value !== null && typeof value === 'object' && 'in' in value
          ? (value.in as unknown[]).includes(row[key])
          : row[key] === value,
    );
  db.fuelOrder.findFirst.mockImplementation(async ({ where, select }) => {
    const row = [order, ...otherOrders].find((row) => matches(row, where));
    return row ? selectFields(persisted(row), select) : null;
  });
  db.fuelOrder.findMany.mockImplementation(async ({ where, select }) =>
    [order, ...otherOrders]
      .filter((row) => matches(row, where))
      .map((row) => selectFields(persisted(row), select)),
  );
  db.fuelOrder.count.mockImplementation(
    async ({ where }) =>
      [order, ...otherOrders].filter((row) => matches(row, where)).length,
  );
  db.fuelOrder.updateMany.mockImplementation(async ({ where, data }) => {
    const row = [order, ...otherOrders].find((row) => matches(row, where));
    if (!row) return { count: 0 };
    Object.assign(row, data, { updatedAt: new Date() });
    return { count: 1 };
  });
  db.payment.create.mockImplementation(async ({ data, select }) => {
    const row = { id: payments.length + 1, ...data };
    payments.push(row);
    return selectFields(row, select);
  });
  db.orderEvent.create.mockImplementation(async ({ data }) => {
    const row = { id: events.length + 1, createdAt: new Date(), ...data };
    events.push(row);
    return row;
  });
  db.orderEvent.findMany.mockImplementation(async ({ where, select }) =>
    events
      .filter((event) => event.orderId === where.orderId)
      .sort(
        (a, b) =>
          Number(a.createdAt) - Number(b.createdAt) ||
          Number(a.id) - Number(b.id),
      )
      .map((event) => selectFields(event, select)),
  );
  // Serialize competing callbacks and snapshot rollback. This verifies application
  // behavior under lock exclusion, NOT PostgreSQL isolation/locking semantics.
  let tail = Promise.resolve();
  db.$transaction.mockImplementation(
    async (work: (tx: typeof db) => Promise<unknown>) => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      const before = {
        order: { ...order },
        otherOrders: otherOrders.map((row) => ({ ...row })),
        payments: [...payments],
        events: [...events],
      };
      try {
        return await work(db);
      } catch (error) {
        order = before.order;
        otherOrders = before.otherOrders;
        payments = before.payments;
        events = before.events;
        throw error;
      } finally {
        release();
      }
    },
  );
});

it('confirms exact cash, assigns pump and creates one transition atomically without expiring unpaid orders', async () => {
  const result = await confirm();
  expect(result.status).toBe(201);
  expect(result.headers['cache-control']).toBe('no-store');
  expect(result.body).toMatchObject({
    replayed: false,
    order: { status: 'PENDING', pumpId: 7 },
    payment: {
      method: 'CASH',
      status: 'CONFIRMED',
      amountMinor: 249,
      capturedMinor: 249,
      currency: 'USD',
      confirmedById: 1,
    },
  });
  expect(new Date(result.body.payment.confirmedAt).getTime()).toBeGreaterThan(
    0,
  );
  expect(payments).toHaveLength(1);
  expect(events).toEqual([
    expect.objectContaining({
      fromStatus: 'AWAITING_PAYMENT',
      toStatus: 'PENDING',
      actorUserId: 1,
      actorType: 'MANAGER',
    }),
  ]);
  expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: 'Serializable',
  });
});
it('supports LBP independently in whole pounds', async () => {
  order.currency = 'LBP';
  order.orderedAmountMinor = 250000;
  expect(
    (await confirm({ ...body, currency: 'LBP', amountMinor: 250000 })).status,
  ).toBe(201);
});
it.each([2, 3, 4])(
  'denies role %s even with payments.manage',
  async (actor) => {
    expect((await confirm(body, actor)).status).toBe(403);
    expect(db.$transaction).not.toHaveBeenCalled();
  },
);

describe('unpaid cancellation', () => {
  it('cancels the owned unpaid order and appends one attributed event without reserving a pump', async () => {
    ownUnpaidOrder();
    const result = await cancel();
    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body).toMatchObject({
      replayed: false,
      order: { id: 20, status: 'CANCELLED', pump: null },
    });
    expect(events).toEqual([
      expect.objectContaining({
        actorUserId: 4,
        actorType: 'CUSTOMER',
        fromStatus: 'AWAITING_PAYMENT',
        toStatus: 'CANCELLED',
      }),
    ]);
    expect(payments).toHaveLength(0);
    expect(pump!.status).toBe('IDLE');
    expect((await get('/orders/20', 4)).body.order.status).toBe('CANCELLED');
    const history = await get('/orders/20/events', 4);
    expect(history.body.events).toEqual([
      expect.objectContaining({
        fromStatus: 'AWAITING_PAYMENT',
        toStatus: 'CANCELLED',
      }),
    ]);
    expect(JSON.stringify(result.body)).not.toMatch(
      /quote|payments|actorUserId|creationRequestHash/,
    );
    const manager = await get('/manager/stations/10/orders/20');
    expect(manager.body.order.status).toBe('CANCELLED');
    expect((await get('/employee/orders', 3)).body.orders).toEqual([]);
    expect((await employeeAction('claim')).status).toBe(409);
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
  });
  it('uses the order-bound guest credential, retains tracking and attributes the guest event', async () => {
    const { credential } = guestUnpaidOrder();
    const result = await cancel(null, credential);
    expect(result.status).toBe(200);
    expect(events[0]).toMatchObject({
      actorType: 'GUEST',
      actorUserId: null,
      toStatus: 'CANCELLED',
    });
    const detail = await request(app)
      .get('/api/orders/20')
      .set('X-Order-Access-Token', credential);
    expect(detail.status).toBe(200);
    expect(detail.body.order.status).toBe('CANCELLED');
    expect((await cancel(null, credential)).body.replayed).toBe(true);
    expect(events).toHaveLength(1);
  });
  it('replays cancellation without changing timestamps or duplicating events', async () => {
    ownUnpaidOrder();
    const first = await cancel();
    const second = await cancel();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ...first.body, replayed: true });
    expect(events).toHaveLength(1);
    expect(payments).toHaveLength(0);
    expect((await confirm()).status).toBe(409);
  });
  it.each(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'UNKNOWN'])(
    'rejects state %s without mutating order or events',
    async (status) => {
      ownUnpaidOrder();
      order.status = status;
      expect((await cancel()).status).toBe(409);
      expect(order.status).toBe(status);
      expect(events).toHaveLength(0);
    },
  );
  it.each([1, 2, 3])(
    'denies staff actor %s despite orders.cancel permission',
    async (actor) => {
      ownUnpaidOrder();
      users.get(actor)!.permissions.push('orders.cancel');
      expect((await cancel(actor)).status).toBe(403);
      expect(events).toHaveLength(0);
    },
  );
  it('requires orders.cancel rather than just read permission and rechecks current activation', async () => {
    ownUnpaidOrder();
    users.get(4)!.permissions = ['orders.read'];
    expect((await cancel()).status).toBe(403);
    users.get(4)!.active = false;
    expect((await cancel()).status).toBe(401);
  });
  it('rechecks cancellation permission inside the transaction', async () => {
    ownUnpaidOrder();
    const find = db.user.findUnique.getMockImplementation()!;
    db.user.findUnique
      .mockImplementationOnce(find)
      .mockImplementationOnce(async (...args: unknown[]) => {
        users.get(4)!.permissions = ['orders.read'];
        return find(...args);
      });
    expect((await cancel()).status).toBe(403);
    expect(events).toHaveLength(0);
  });
  it('conceals foreign and missing orders before cancellation, including cancelled orders', async () => {
    ownUnpaidOrder();
    order.userId = 99;
    expect((await cancel()).status).toBe(404);
    order.status = 'CANCELLED';
    expect((await cancel()).status).toBe(404);
    expect((await cancel(4, undefined, '/api/orders/999/cancel')).status).toBe(
      404,
    );
    expect(events).toHaveLength(0);
  });
  it('rejects missing, quote-only and cross-order guest credentials without login fallback', async () => {
    const { quoteToken, credential } = guestUnpaidOrder();
    expect((await cancel(null)).status).toBe(404);
    expect((await cancel(null, quoteToken)).status).toBe(404);
    expect(
      (await cancel(null, credential, '/api/orders/21/cancel')).status,
    ).toBe(404);
    expect(
      (await cancel(null, credential).set('Cookie', `${ACCESS_COOKIE}=invalid`))
        .status,
    ).toBe(401);
    expect(events).toHaveLength(0);
  });
  it('does not use a guest credential to override authenticated ownership', async () => {
    ownUnpaidOrder();
    const { credential } = guestUnpaidOrder();
    expect((await cancel(4, credential)).status).toBe(404);
  });
  it('requires CSRF protection for customer and guest cancellation', async () => {
    ownUnpaidOrder();
    expect(
      (await cancel(4, undefined, '/api/orders/20/cancel', {}, false)).status,
    ).toBe(403);
    const { credential } = guestUnpaidOrder();
    expect(
      (await cancel(null, credential, '/api/orders/20/cancel', {}, false))
        .status,
    ).toBe(403);
  });
  it.each([
    { status: 'CANCELLED' },
    { reason: 'not approved' },
    { pumpId: 7 },
    { userId: 99 },
  ])('rejects unsupported input %j', async (body) => {
    ownUnpaidOrder();
    expect(
      (await cancel(4, undefined, '/api/orders/20/cancel', body)).status,
    ).toBe(400);
  });
  it('rejects query credentials and invalid IDs', async () => {
    ownUnpaidOrder();
    expect(
      (await cancel(4, undefined, '/api/orders/20/cancel?token=secret')).status,
    ).toBe(400);
    expect((await cancel(4, undefined, '/api/orders/0/cancel')).status).toBe(
      400,
    );
  });
  it.each(['AWAITING_PAYMENT', 'CANCELLED'])(
    'rejects legacy payment records in state %s instead of cancelling a payment',
    async (status) => {
      ownUnpaidOrder();
      order.status = status;
      payments.push({ id: 1, orderId: 20, status: 'CONFIRMED' });
      expect((await cancel()).status).toBe(409);
      expect(payments).toHaveLength(1);
      expect(events).toHaveLength(0);
    },
  );
  it.each([
    { pumpId: 7 },
    { assignedEmployeeId: 3 },
    { claimedAt: new Date() },
  ])('does not repair inconsistent unpaid assignment %j', async (change) => {
    ownUnpaidOrder();
    Object.assign(order, change);
    expect((await cancel()).status).toBe(409);
    expect(order).toMatchObject(change);
    expect(events).toHaveLength(0);
  });
  it('allows unpaid cancellation after station deactivation and quote expiry', async () => {
    ownUnpaidOrder();
    station.isActive = false;
    expect((await cancel()).status).toBe(200);
  });
  it('rolls back cancellation on event failure and allows a later retry', async () => {
    ownUnpaidOrder();
    db.orderEvent.create.mockRejectedValueOnce(new Error('event failed'));
    expect((await cancel()).status).toBe(500);
    expect(order.status).toBe('AWAITING_PAYMENT');
    expect(events).toHaveLength(0);
    expect((await cancel()).status).toBe(200);
    expect(events).toHaveLength(1);
  });
  it('rejects a failed conditional update without appending an event', async () => {
    ownUnpaidOrder();
    db.fuelOrder.updateMany.mockResolvedValueOnce({ count: 0 });
    expect((await cancel()).status).toBe(409);
    expect(order.status).toBe('AWAITING_PAYMENT');
    expect(events).toHaveLength(0);
  });
  it('retries serialization failure without duplicate cancellation events', async () => {
    ownUnpaidOrder();
    db.orderEvent.create.mockRejectedValueOnce({ code: 'P2034' });
    expect((await cancel()).status).toBe(200);
    expect(events).toHaveLength(1);
    expect(order.status).toBe('CANCELLED');
  });
  it('returns conflict on exhausted retries without partial cancellation', async () => {
    ownUnpaidOrder();
    db.orderEvent.create.mockRejectedValue({ code: 'P2034' });
    expect((await cancel()).status).toBe(409);
    expect(order.status).toBe('AWAITING_PAYMENT');
    expect(events).toHaveLength(0);
  });
  it('serializes competing cancellations to one transition in the mock protocol', async () => {
    ownUnpaidOrder();
    const results = await Promise.all([cancel(), cancel()]);
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect(results.map((result) => result.body.replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(events).toHaveLength(1);
    expect(payments).toHaveLength(0);
  });
  it.each([true, false])(
    'coordinates cancellation versus cash confirmation with cancellation first: %s (mock protocol)',
    async (cancellationFirst) => {
      ownUnpaidOrder();
      const transaction = db.$transaction.getMockImplementation()!;
      let releaseFirst!: () => void;
      let firstEntered!: () => void;
      let competitorArrived!: () => void;
      const held = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        firstEntered = resolve;
      });
      const arrived = new Promise<void>((resolve) => {
        competitorArrived = resolve;
      });
      let calls = 0;
      db.$transaction.mockImplementation(
        (work: (tx: typeof db) => Promise<unknown>, ...args: unknown[]) => {
          if (++calls === 1)
            return transaction(
              async (tx: typeof db) => {
                firstEntered();
                await held;
                return work(tx);
              },
              ...args,
            );
          competitorArrived();
          return transaction(work, ...args);
        },
      );
      const firstRequest = cancellationFirst ? cancel() : confirm();
      const first = firstRequest.then((response) => response);
      await entered;
      const secondRequest = cancellationFirst ? confirm() : cancel();
      const second = secondRequest.then((response) => response);
      await arrived;
      releaseFirst();
      const results = await Promise.all([first, second]);
      expect(results[0]!.status).toBe(cancellationFirst ? 200 : 201);
      expect(results[1]!.status).toBe(409);
      expect(order.status).toBe(cancellationFirst ? 'CANCELLED' : 'PENDING');
      expect(order.pumpId).toBe(cancellationFirst ? null : 7);
      expect(events).toHaveLength(1);
      expect(payments).toHaveLength(cancellationFirst ? 0 : 1);
    },
  );
});
it('requires authentication', async () => {
  expect((await confirm(body, 999)).status).toBe(401);
  expect(
    (
      await request(app)
        .post(path)
        .set('Origin', 'http://localhost:3000')
        .set('X-CSRF-Protection', '1')
        .send(body)
    ).status,
  ).toBe(401);
});
it('requires payments.manage and active Manager', async () => {
  users.get(1)!.permissions = ['orders.read'];
  expect((await confirm()).status).toBe(403);
  users.get(1)!.active = false;
  expect((await confirm()).status).toBe(401);
});
it('requires CSRF protection', async () => {
  expect((await confirm(body, 1, path, false)).status).toBe(403);
});
it('rechecks permission inside the write transaction', async () => {
  const original = db.user.findUnique.getMockImplementation()!;
  db.user.findUnique
    .mockImplementationOnce(original)
    .mockImplementationOnce(async (...args: unknown[]) => {
      users.get(1)!.permissions = [];
      return original(...args);
    });
  expect((await confirm()).status).toBe(403);
  expect(payments).toHaveLength(0);
});
it('rechecks Manager role inside the write transaction', async () => {
  const original = db.user.findUnique.getMockImplementation()!;
  db.user.findUnique
    .mockImplementationOnce(original)
    .mockImplementationOnce(async (...args: unknown[]) => {
      users.get(1)!.role = 'ADMIN';
      return original(...args);
    });
  expect((await confirm()).status).toBe(403);
});
it('conceals unmanaged stations and cross-station orders', async () => {
  expect((await confirm(body, 5)).status).toBe(404);
  expect((await confirm(body, 1, path.replace('/10/', '/11/'))).status).toBe(
    404,
  );
  order.stationId = 11;
  expect((await confirm()).status).toBe(404);
  expect(payments).toHaveLength(0);
});
it('rejects missing orders', async () => {
  expect((await confirm(body, 1, path.replace('/20/', '/21/'))).status).toBe(
    404,
  );
});
it.each([{ amountMinor: 248 }, { amountMinor: 250 }, { currency: 'LBP' }])(
  'rejects snapshot mismatch %j',
  async (change) => {
    expect((await confirm({ ...body, ...change })).status).toBe(409);
    expect(order.status).toBe('AWAITING_PAYMENT');
    expect(payments).toHaveLength(0);
  },
);
it.each([
  { amountMinor: 0 },
  { amountMinor: -1 },
  { amountMinor: 2.49 },
  { amountMinor: '249' },
  { currency: 'EUR' },
  { pumpId: null },
  { pumpId: 0 },
  { pumpId: 1.1 },
  { amountMinor: 2147483648 },
  { status: 'PENDING' },
  { method: 'CARD' },
])('rejects malformed or client-controlled fields %j', async (change) => {
  expect((await confirm({ ...body, ...change })).status).toBe(400);
});
it('requires a pump selection', async () => {
  expect((await confirm({ amountMinor: 249, currency: 'USD' })).status).toBe(
    400,
  );
});
it('rechecks station ownership under the station lock', async () => {
  const query = db.$queryRaw.getMockImplementation()!;
  db.$queryRaw.mockImplementation(
    async (sql: TemplateStringsArray, ...args: unknown[]) => {
      if (sql.join('').includes('FROM stations')) station.managerId = 5;
      return query(sql, ...args);
    },
  );
  expect((await confirm()).status).toBe(404);
  expect(payments).toHaveLength(0);
});
it('rechecks Manager activation inside the transaction', async () => {
  const find = db.user.findUnique.getMockImplementation()!;
  db.user.findUnique
    .mockImplementationOnce(find)
    .mockImplementationOnce(async (...args: unknown[]) => {
      users.get(1)!.active = false;
      return find(...args);
    });
  expect((await confirm()).status).toBe(401);
  expect(payments).toHaveLength(0);
});
it('does not treat a cancelled paid order or missing pump as a successful replay', async () => {
  expect((await confirm()).status).toBe(201);
  order.status = 'CANCELLED';
  expect((await confirm()).status).toBe(409);
  order.status = 'PENDING';
  order.pumpId = null;
  expect((await confirm()).status).toBe(409);
  expect(payments).toHaveLength(1);
  expect(events).toHaveLength(1);
});
it('preserves the first confirmation when competing requests select different pumps', async () => {
  const responses = await Promise.all([
    confirm(),
    confirm({ ...body, pumpId: 8 }),
  ]);
  expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
  expect(order.pumpId).toBe(7);
  expect(payments).toHaveLength(1);
  expect(events).toHaveLength(1);
});
it.each(['OFFLINE', 'BUSY', 'ACTIVE', 'idle', ''])(
  'rejects pump status %s using the existing IDLE convention',
  async (status) => {
    pump!.status = status;
    expect((await confirm()).status).toBe(409);
    expect(payments).toHaveLength(0);
    expect(order.pumpId).toBeNull();
  },
);
it('rejects missing or foreign pumps', async () => {
  pump!.stationId = 11;
  expect((await confirm()).status).toBe(409);
  pump = null;
  expect((await confirm()).status).toBe(409);
});
it('rejects inactive stations before new activation', async () => {
  station.isActive = false;
  expect((await confirm()).status).toBe(409);
  expect(order.status).toBe('AWAITING_PAYMENT');
});
it.each(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'UNKNOWN'])(
  'rejects an unpaid order in state %s',
  async (status) => {
    order.status = status;
    expect((await confirm()).status).toBe(409);
    expect(payments).toHaveLength(0);
  },
);
it('rejects an already assigned unpaid order', async () => {
  order.assignedEmployeeId = 3;
  expect((await confirm()).status).toBe(409);
});
it('rejects legacy orders without authoritative currency', async () => {
  order.currency = null;
  expect((await confirm()).status).toBe(409);
});
it('replays duplicate confirmation without duplicate payment or event, even after completion and deactivation', async () => {
  const first = await confirm();
  order.status = 'COMPLETED';
  station.isActive = false;
  pump!.status = 'OFFLINE';
  const repeated = await confirm();
  expect(repeated.status).toBe(200);
  expect(repeated.body.replayed).toBe(true);
  expect(repeated.body.payment).toEqual(first.body.payment);
  expect(order.status).toBe('COMPLETED');
  expect(payments).toHaveLength(1);
  expect(events).toHaveLength(1);
  expect((await confirm({ ...body, pumpId: 8 })).status).toBe(409);
  expect((await confirm(body, 5)).status).toBe(404);
});
it('rejects pre-existing unconfirmed or inconsistent payments instead of charging again', async () => {
  payments.push({
    id: 1,
    orderId: 20,
    method: 'CARD',
    status: 'PENDING',
    confirmedAt: null,
  });
  expect((await confirm()).status).toBe(409);
  expect(events).toHaveLength(0);
});
it('serializes simultaneous duplicate requests in the mock protocol to one payment/event', async () => {
  const responses = await Promise.all([confirm(), confirm()]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 201]);
  expect(payments).toHaveLength(1);
  expect(events).toHaveLength(1);
});
it.each(['payment', 'event'])(
  'rolls back order and all writes when %s insertion fails',
  async (target) => {
    const create =
      target === 'payment' ? db.payment.create : db.orderEvent.create;
    create.mockRejectedValueOnce(new Error('insertion failed'));
    expect((await confirm()).status).toBe(500);
    expect(order.status).toBe('AWAITING_PAYMENT');
    expect(order.pumpId).toBeNull();
    expect(payments).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect((await confirm()).status).toBe(201);
  },
);
it('rolls back a conditional update conflict', async () => {
  db.fuelOrder.updateMany.mockResolvedValueOnce({ count: 0 });
  expect((await confirm()).status).toBe(409);
  expect(payments).toHaveLength(0);
  expect(events).toHaveLength(0);
});
it('retries a serialization failure with all partial writes rolled back', async () => {
  db.orderEvent.create.mockRejectedValueOnce({ code: 'P2034' });
  expect((await confirm()).status).toBe(201);
  expect(payments).toHaveLength(1);
  expect(events).toHaveLength(1);
});
it('returns conflict on exhausted serialization retries', async () => {
  db.orderEvent.create.mockRejectedValue({ code: 'P2034' });
  expect((await confirm()).status).toBe(409);
  expect(db.$transaction).toHaveBeenCalledTimes(3);
  expect(order.status).toBe('AWAITING_PAYMENT');
  expect(payments).toHaveLength(0);
});
it('returns conflict and rolls back a database uniqueness violation', async () => {
  db.payment.create.mockRejectedValueOnce({ code: 'P2002' });
  expect((await confirm()).status).toBe(409);
  expect(order.pumpId).toBeNull();
  expect(events).toHaveLength(0);
});
it('keeps unpaid orders unclaimable, then exposes paid orders to Employee fulfillment and Manager history', async () => {
  order.userId = 4;
  users.get(4)!.permissions.push('orders.read');
  const initialTracking = await get('/orders/20', 4);
  expect(initialTracking.status).toBe(200);
  expect(initialTracking.body.order.status).toBe('AWAITING_PAYMENT');
  expect((await get('/employee/orders', 3)).body.orders).toEqual([]);
  expect(
    (
      await request(app)
        .post('/api/employee/orders/20/claim')
        .set('Cookie', `${ACCESS_COOKIE}=${tokenService.issue(3).accessToken}`)
        .set('Origin', 'http://localhost:3000')
        .set('X-CSRF-Protection', '1')
        .send({})
    ).status,
  ).toBe(409);
  expect((await confirm()).status).toBe(201);
  expect((await get('/orders/20', 4)).body.order.status).toBe('PENDING');
  const pending = await get('/employee/orders', 3);
  expect(pending.body.orders).toEqual([
    expect.objectContaining({
      id: 20,
      status: 'PENDING',
      pump: { id: 7, number: 1 },
    }),
  ]);
  for (const action of ['claim', 'complete']) {
    const result = await request(app)
      .post(`/api/employee/orders/20/${action}`)
      .set('Cookie', `${ACCESS_COOKIE}=${tokenService.issue(3).accessToken}`)
      .set('Origin', 'http://localhost:3000')
      .set('X-CSRF-Protection', '1')
      .send({});
    expect(result.status).toBe(200);
    expect((await get('/orders/20', 4)).body.order.status).toBe(
      action === 'claim' ? 'IN_PROGRESS' : 'COMPLETED',
    );
  }
  const detail = await get('/manager/stations/10/orders/20');
  expect(detail.status).toBe(200);
  expect(detail.body.order).toMatchObject({
    status: 'COMPLETED',
    pump: { id: 7 },
    assignee: { id: 3 },
  });
  expect(detail.body.order.events.map((e: Row) => e.toStatus)).toEqual([
    'PENDING',
    'IN_PROGRESS',
    'COMPLETED',
  ]);
  const customerHistory = await get('/orders/20/events', 4);
  expect(customerHistory.status).toBe(200);
  expect(
    customerHistory.body.events.map((event: Row) => event.toStatus),
  ).toEqual(['PENDING', 'IN_PROGRESS', 'COMPLETED']);
  expect(JSON.stringify(customerHistory.body)).not.toMatch(
    /actorUserId|actorType|note/,
  );
  expect((await confirm()).status).toBe(200);
  expect(payments).toHaveLength(1);
  expect(events).toHaveLength(3);
});

it.each(['PENDING', 'IN_PROGRESS'])(
  'rejects an IDLE pump already reserved by a %s order before recording cash',
  async (status) => {
    otherOrders.push({ ...order, id: 21, status, pumpId: 7 });
    const result = await confirm();
    expect(result.status).toBe(409);
    expect(result.body.message ?? result.body.error).toBeDefined();
    expect(order.status).toBe('AWAITING_PAYMENT');
    expect(order.pumpId).toBeNull();
    expect(payments).toHaveLength(0);
    expect(events).toHaveLength(0);
  },
);
it.each(['COMPLETED', 'CANCELLED', 'AWAITING_PAYMENT'])(
  'does not reserve a pump for an order in state %s',
  async (status) => {
    otherOrders.push({ ...order, id: 21, status, pumpId: 7 });
    expect((await confirm()).status).toBe(201);
  },
);
it('does not treat a reservation on a different pump as a conflict', async () => {
  otherOrders.push({ ...order, id: 21, status: 'IN_PROGRESS', pumpId: 8 });
  expect((await confirm()).status).toBe(201);
});
it('locks the pump exclusively before checking active reservations', async () => {
  expect((await confirm()).status).toBe(201);
  const pumpLock = db.$queryRaw.mock.calls.find(
    ([sql]: [TemplateStringsArray]) => sql.join('').includes('FROM pumps'),
  )!;
  expect(pumpLock[0].join('')).toContain('FOR UPDATE');
  const lockIndex = db.$queryRaw.mock.calls.indexOf(pumpLock);
  const checkIndex = db.fuelOrder.findFirst.mock.calls.findIndex(
    ([arg]) => arg.where.pumpId === 7,
  );
  expect(db.$queryRaw.mock.invocationCallOrder[lockIndex]).toBeLessThan(
    db.fuelOrder.findFirst.mock.invocationCallOrder[checkIndex]!,
  );
});
it('allows only one of two different unpaid orders to reserve a pump in the mock concurrency protocol', async () => {
  waitingOrder();
  const results = await Promise.all([confirm(), confirmWaiting()]);
  expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
  expect(
    [order, ...otherOrders].filter(
      (row) =>
        row.pumpId === 7 &&
        ['PENDING', 'IN_PROGRESS'].includes(row.status as string),
    ),
  ).toHaveLength(1);
  expect(payments).toHaveLength(1);
  expect(events).toHaveLength(1);
  expect(otherOrders[0]!.status).toBe('AWAITING_PAYMENT');
  expect(otherOrders[0]!.pumpId).toBeNull();
});
it('retains the reservation through claim and releases it on completion without changing pump eligibility status', async () => {
  expect((await confirm()).status).toBe(201);
  waitingOrder();
  expect((await confirmWaiting()).status).toBe(409);
  expect((await employeeAction('claim')).status).toBe(200);
  expect(order.status).toBe('IN_PROGRESS');
  expect(order.pumpId).toBe(7);
  expect((await confirmWaiting()).status).toBe(409);
  expect((await employeeAction('complete')).status).toBe(200);
  expect(order.status).toBe('COMPLETED');
  expect(order.pumpId).toBe(7);
  expect(pump!.status).toBe('IDLE');
  expect((await confirmWaiting()).status).toBe(201);
  expect(otherOrders[0]!).toMatchObject({ status: 'PENDING', pumpId: 7 });
});
it("does not reserve or release another order's pump on delayed cash, claim or completion retries", async () => {
  expect((await confirm()).status).toBe(201);
  expect((await employeeAction('claim')).status).toBe(200);
  expect((await employeeAction('complete')).status).toBe(200);
  waitingOrder();
  expect((await confirmWaiting()).status).toBe(201);
  expect((await confirm()).status).toBe(200);
  expect((await employeeAction('claim')).status).toBe(200);
  expect((await employeeAction('complete')).status).toBe(200);
  expect(otherOrders[0]!).toMatchObject({ status: 'PENDING', pumpId: 7 });
  expect(payments).toHaveLength(2);
  expect(events).toHaveLength(4);
});
it('preserves the reservation if completion event insertion rolls back', async () => {
  expect((await confirm()).status).toBe(201);
  expect((await employeeAction('claim')).status).toBe(200);
  waitingOrder();
  db.orderEvent.create.mockRejectedValueOnce(
    new Error('completion event failed'),
  );
  expect((await employeeAction('complete')).status).toBe(500);
  expect(order.status).toBe('IN_PROGRESS');
  expect((await confirmWaiting()).status).toBe(409);
  expect(payments).toHaveLength(1);
  expect(events).toHaveLength(2);
  expect((await employeeAction('complete')).status).toBe(200);
  expect((await confirmWaiting()).status).toBe(201);
});
it.each(['payment', 'event'])(
  'leaves the pump available to another order when cash %s insertion rolls back',
  async (target) => {
    waitingOrder();
    const create =
      target === 'payment' ? db.payment.create : db.orderEvent.create;
    create.mockRejectedValueOnce(new Error('cash insertion failed'));
    expect((await confirm()).status).toBe(500);
    expect((await confirmWaiting()).status).toBe(201);
    expect((await confirm()).status).toBe(409);
    expect(order.status).toBe('AWAITING_PAYMENT');
    expect(order.pumpId).toBeNull();
    expect(payments).toHaveLength(1);
    expect(events).toHaveLength(1);
  },
);
it('rolls back a database pump uniqueness conflict before recording payment', async () => {
  db.fuelOrder.updateMany.mockRejectedValueOnce({
    code: 'P2002',
    meta: { target: 'orders_active_pump_key' },
  });
  expect((await confirm()).status).toBe(409);
  expect(order.status).toBe('AWAITING_PAYMENT');
  expect(order.pumpId).toBeNull();
  expect(payments).toHaveLength(0);
  expect(events).toHaveLength(0);
});
it('retries a serialization failure without losing or duplicating the reservation', async () => {
  waitingOrder();
  db.orderEvent.create.mockRejectedValueOnce({ code: 'P2034' });
  expect((await confirm()).status).toBe(201);
  expect((await confirmWaiting()).status).toBe(409);
  expect(payments).toHaveLength(1);
  expect(events).toHaveLength(1);
});
it.each([true, false])(
  'handles completion versus reservation with completion first: %s (mock protocol)',
  async (completionFirst) => {
    expect((await confirm()).status).toBe(201);
    expect((await employeeAction('claim')).status).toBe(200);
    waitingOrder();
    const transaction = db.$transaction.getMockImplementation()!;
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    let competitorArrived!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const arrived = new Promise<void>((resolve) => {
      competitorArrived = resolve;
    });
    let calls = 0;
    db.$transaction.mockImplementation(
      (work: (tx: typeof db) => Promise<unknown>, ...args: unknown[]) => {
        if (++calls === 1)
          return transaction(
            async (tx: typeof db) => {
              firstEntered();
              await held;
              return work(tx);
            },
            ...args,
          );
        competitorArrived();
        return transaction(work, ...args);
      },
    );
    const firstRequest = completionFirst
      ? employeeAction('complete')
      : confirmWaiting();
    const first = firstRequest.then((response) => response);
    await entered;
    const secondRequest = completionFirst
      ? confirmWaiting()
      : employeeAction('complete');
    const second = secondRequest.then((response) => response);
    await arrived;
    releaseFirst();
    // Both are in flight, with deterministic acquisition of the mock exclusion.
    const results = await Promise.all([first, second]);
    expect(results[completionFirst ? 0 : 1]!.status).toBe(200);
    const confirmation = results[completionFirst ? 1 : 0]!;
    expect(confirmation.status).toBe(completionFirst ? 201 : 409);
    if (confirmation.status === 409)
      expect((await confirmWaiting()).status).toBe(201);
    expect(order.status).toBe('COMPLETED');
    expect(otherOrders[0]!).toMatchObject({ status: 'PENDING', pumpId: 7 });
    expect(payments).toHaveLength(2);
    expect(events).toHaveLength(4);
  },
);

import request from 'supertest';
import { randomUUID, createHash } from 'node:crypto';
import { Decimal } from '@prisma/client/runtime/client';
import { app } from '../../src/app.js';
import { prisma } from '../../src/database/prisma.js';
import { tokenService } from '../../src/modules/auth/token.service.js';
import { ACCESS_COOKIE } from '../../src/modules/auth/auth.types.js';
import { selectFields } from '../fixtures/orders.js';

jest.mock('../../src/database/prisma.js', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    fuelType: { findUnique: jest.fn() },
    sellingPrice: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    orderQuote: { create: jest.fn(), findUnique: jest.fn() },
    fuelOrder: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    orderEvent: { create: jest.fn() },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  },
}));
jest.mock('../../src/utils/logger.js', () => ({
  logger: { error: jest.fn() },
}));
type Row = Record<string, unknown>;
const db = prisma as unknown as {
  user: { findUnique: jest.Mock };
  fuelType: { findUnique: jest.Mock };
  sellingPrice: {
    create: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
  };
  orderQuote: { create: jest.Mock; findUnique: jest.Mock };
  fuelOrder: {
    create: jest.Mock;
    findUnique: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
  };
  orderEvent: { create: jest.Mock };
  $transaction: jest.Mock;
  $queryRaw: jest.Mock;
};
let prices: Row[];
let quotes: Map<string, Row>;
let orders: Row[];
let events: Row[];
let stationActive: boolean;
let users: Map<
  number,
  { role: string; permissions: string[]; isActive: boolean }
>;
function post(path: string, body: object, actor?: number, csrf = true) {
  const pending = request(app).post(`/api${path}`).send(body);
  if (csrf)
    pending
      .set('Origin', 'http://localhost:3000')
      .set('X-CSRF-Protection', '1');
  if (actor)
    pending.set(
      'Cookie',
      `${ACCESS_COOKIE}=${tokenService.issue(actor).accessToken}`,
    );
  return pending;
}
function get(path: string, actor = 1) {
  return request(app)
    .get(`/api${path}`)
    .set('Cookie', `${ACCESS_COOKIE}=${tokenService.issue(actor).accessToken}`);
}
const quoteBody = {
  stationId: 10,
  fuelTypeId: 1,
  currency: 'USD',
  fulfillmentType: 'IN_STATION',
  inputMode: 'LITERS',
  value: '1.250',
};
async function sell(
  currency = 'USD',
  unitPrice = '1.99',
  effectiveAt = '2020-01-01T00:00:00Z',
) {
  const result = await post(
    '/fuel-prices/selling',
    { fuelTypeId: 1, currency, unitPrice, effectiveAt },
    1,
  );
  expect(result.status).toBe(201);
  return result;
}
async function quote(actor?: number, extra: object = {}) {
  const result = await post(
    '/orders/quotes',
    { ...quoteBody, ...extra },
    actor,
  );
  expect(result.status).toBe(201);
  return result.body;
}
function creation(
  q: { quote: { id: string }; guestToken?: string },
  extra: object = {},
) {
  return {
    quoteId: q.quote.id,
    idempotencyKey: randomUUID(),
    ...(q.guestToken ? { guestToken: q.guestToken } : {}),
    ...extra,
  };
}
beforeEach(() => {
  jest.restoreAllMocks();
  jest.resetAllMocks();
  prices = [];
  quotes = new Map();
  orders = [];
  events = [];
  stationActive = true;
  users = new Map([
    [
      1,
      {
        role: 'ADMIN',
        permissions: ['pricing.read', 'pricing.update'],
        isActive: true,
      },
    ],
    [
      2,
      {
        role: 'CUSTOMER',
        permissions: ['orders.create', 'orders.read'],
        isActive: true,
      },
    ],
    [
      3,
      {
        role: 'EMPLOYEE',
        permissions: ['orders.read', 'orders.update', 'orders.create'],
        isActive: true,
      },
    ],
    [
      4,
      {
        role: 'MANAGER',
        permissions: ['pricing.read', 'pricing.update', 'orders.create'],
        isActive: true,
      },
    ],
    [5, { role: 'CUSTOMER', permissions: ['orders.create'], isActive: true }],
  ]);
  db.user.findUnique.mockImplementation(async ({ where }) => {
    const u = users.get(where.id);
    return u
      ? {
          id: where.id,
          name: 'User',
          email: 'private@example.invalid',
          tokenVersion: 0,
          isActive: u.isActive,
          stationId: u.role === 'EMPLOYEE' ? 10 : null,
          station:
            u.role === 'EMPLOYEE' ? { id: 10, isActive: stationActive } : null,
          role: {
            name: u.role,
            permissions: u.permissions.map((key) => ({ permission: { key } })),
          },
        }
      : null;
  });
  db.$queryRaw.mockImplementation(
    async (sql: TemplateStringsArray, id: unknown) =>
      sql.join('').includes('FROM stations')
        ? id === 10
          ? [{ id: 10, isActive: stationActive }]
          : []
        : [{ id }],
  );
  db.$transaction.mockImplementation(
    async (work: (tx: typeof db) => Promise<unknown>) => {
      const before = {
        prices: [...prices],
        quotes: new Map(quotes),
        orders: [...orders],
        events: [...events],
      };
      try {
        return await work(db);
      } catch (error) {
        prices = before.prices;
        quotes = before.quotes;
        orders = before.orders;
        events = before.events;
        throw error;
      }
    },
  );
  db.fuelType.findUnique.mockImplementation(async ({ where }) =>
    where.id === 1 ? { id: 1 } : null,
  );
  db.sellingPrice.create.mockImplementation(async ({ data, select }) => {
    if (
      prices.some(
        (p) =>
          p.fuelTypeId === data.fuelTypeId &&
          p.currency === data.currency &&
          Number(p.effectiveAt) === Number(data.effectiveAt),
      )
    )
      throw { code: 'P2002' };
    const row = { id: prices.length + 1, ...data, createdAt: new Date() };
    prices.push(row);
    return selectFields(row, select);
  });
  const matchedPrices = (where: Row) =>
    prices
      .filter(
        (p) =>
          (where.fuelTypeId === undefined ||
            p.fuelTypeId === where.fuelTypeId) &&
          (where.currency === undefined || p.currency === where.currency) &&
          (!where.effectiveAt ||
            Number(p.effectiveAt) <=
              Number((where.effectiveAt as { lte: Date }).lte)),
      )
      .sort(
        (a, b) =>
          Number(b.effectiveAt) - Number(a.effectiveAt) ||
          Number(b.id) - Number(a.id),
      );
  db.sellingPrice.findFirst.mockImplementation(async ({ where, select }) => {
    const row = matchedPrices(where)[0];
    return row ? (select ? selectFields(row, select) : row) : null;
  });
  db.sellingPrice.findMany.mockImplementation(
    async ({ where, select, skip, take }) =>
      matchedPrices(where)
        .slice(skip, skip + take)
        .map((r) => selectFields(r, select)),
  );
  db.sellingPrice.count.mockImplementation(
    async ({ where }) => matchedPrices(where).length,
  );
  db.orderQuote.create.mockImplementation(async ({ data }) => {
    const row = {
      id: randomUUID(),
      ...data,
      quantity: new Decimal(data.quantity),
      createdAt: new Date(),
    };
    quotes.set(row.id, row);
    return row;
  });
  db.orderQuote.findUnique.mockImplementation(
    async ({ where }) => quotes.get(where.id) ?? null,
  );
  const uniqueOrder = ({ where, select }: { where: Row; select?: Row }) => {
    const row = orders.find((o) =>
      Object.entries(where).every(([key, value]) => o[key] === value),
    );
    return row ? (select ? selectFields(row, select) : row) : null;
  };
  db.fuelOrder.findUnique.mockImplementation(async (input) =>
    uniqueOrder(input),
  );
  db.fuelOrder.findUniqueOrThrow.mockImplementation(async (input) => {
    const row = uniqueOrder(input);
    if (!row) throw Error('Missing order');
    return row;
  });
  db.fuelOrder.create.mockImplementation(async ({ data, select }) => {
    if (
      orders.some(
        (o) => o.quoteId === data.quoteId || o.creationKey === data.creationKey,
      )
    )
      throw { code: 'P2002' };
    const row = {
      id: orders.length + 1,
      ...data,
      assignedEmployeeId: null,
      claimedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    orders.push(row);
    return selectFields(row, select);
  });
  const matchedOrders = (where: Row) =>
    orders.filter((o) =>
      Object.entries(where).every(([key, value]) => o[key] === value),
    );
  db.fuelOrder.findFirst.mockImplementation(async ({ where, select }) => {
    const row = matchedOrders(where)[0];
    return row
      ? selectFields(
          {
            ...row,
            quote: row.quoteId ? quotes.get(String(row.quoteId)) : null,
            station: {
              id: row.stationId,
              name: 'Station',
              address: 'Station address',
            },
            pump: null,
            fuelType: { id: 1, code: 'TEST', name: 'Test fuel' },
            events: events.filter((event) => event.orderId === row.id),
          },
          select,
        )
      : null;
  });
  db.fuelOrder.findMany.mockImplementation(
    async ({ where, select, skip, take }) =>
      matchedOrders(where)
        .slice(skip, skip + take)
        .map((r) => selectFields(r, select)),
  );
  db.fuelOrder.count.mockImplementation(
    async ({ where }) => matchedOrders(where).length,
  );
  db.orderEvent.create.mockImplementation(async ({ data }) => {
    const row = { id: events.length + 1, ...data, createdAt: new Date() };
    events.push(row);
    return row;
  });
});

describe('Admin global selling prices', () => {
  it('returns no fabricated current price and protects reads from non-Admins', async () => {
    expect(
      (await get('/fuel-prices/selling/current?fuelTypeId=1&currency=USD'))
        .status,
    ).toBe(404);
    expect((await get('/fuel-prices/selling', 4)).status).toBe(403);
  });
  it('rechecks Admin permission inside the price-write transaction', async () => {
    db.$queryRaw.mockImplementationOnce(async () => {
      users.get(1)!.permissions = [];
      return [];
    });
    expect(
      (
        await post(
          '/fuel-prices/selling',
          {
            fuelTypeId: 1,
            currency: 'USD',
            unitPrice: '1.99',
            effectiveAt: '2020-01-01T00:00:00Z',
          },
          1,
        )
      ).status,
    ).toBe(403);
    expect(prices).toEqual([]);
  });
  it('appends history, picks only effective prices and keeps currencies independent', async () => {
    await sell('USD', '1.25');
    await sell('LBP', '125000');
    await sell('USD', '1.50', '2021-01-01T00:00:00Z');
    await sell('USD', '99.00', '2100-01-01T00:00:00Z');
    expect(
      (await get('/fuel-prices/selling/current?fuelTypeId=1&currency=USD')).body
        .price.unitPrice,
    ).toBe('1.50');
    expect(
      (await get('/fuel-prices/selling/current?fuelTypeId=1&currency=LBP')).body
        .price.unitPrice,
    ).toBe('125000');
    const history = await get(
      '/fuel-prices/selling?fuelTypeId=1&currency=USD&limit=1',
    );
    expect(history.body.pagination.total).toBe(3);
    expect(history.body.prices).toHaveLength(1);
    expect(prices[0].unitPriceMinor).toBe(125);
  });
  it.each([undefined, 2, 3, 4, 5])(
    'denies non-Admin selling price writes for actor %s',
    async (actor) => {
      expect(
        (
          await post(
            '/fuel-prices/selling',
            {
              fuelTypeId: 1,
              currency: 'USD',
              unitPrice: '1',
              effectiveAt: '2020-01-01T00:00:00Z',
            },
            actor,
          )
        ).status,
      ).toBe(actor ? 403 : 401);
    },
  );
  it('requires pricing permissions independently', async () => {
    users.get(1)!.permissions = [];
    expect((await get('/fuel-prices/selling')).status).toBe(403);
    expect(
      (
        await post(
          '/fuel-prices/selling',
          {
            fuelTypeId: 1,
            currency: 'USD',
            unitPrice: '1',
            effectiveAt: '2020-01-01T00:00:00Z',
          },
          1,
        )
      ).status,
    ).toBe(403);
  });
  it.each([
    ['USD', '1.001'],
    ['LBP', '1.5'],
    ['USD', '0'],
    ['USD', '-1'],
    ['EUR', '1'],
  ])('rejects invalid selling tariff %s %s', async (currency, unitPrice) => {
    expect(
      (
        await post(
          '/fuel-prices/selling',
          {
            fuelTypeId: 1,
            currency,
            unitPrice,
            effectiveAt: '2020-01-01T00:00:00Z',
          },
          1,
        )
      ).status,
    ).toBe(400);
    expect(prices).toEqual([]);
  });
  it('rejects duplicate effective dates and unknown fuels without replacing history', async () => {
    await sell();
    expect(
      (
        await post(
          '/fuel-prices/selling',
          {
            fuelTypeId: 1,
            currency: 'USD',
            unitPrice: '2',
            effectiveAt: '2020-01-01T00:00:00Z',
          },
          1,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await post(
          '/fuel-prices/selling',
          {
            fuelTypeId: 99,
            currency: 'USD',
            unitPrice: '2',
            effectiveAt: '2020-01-01T00:00:00Z',
          },
          1,
        )
      ).status,
    ).toBe(404);
    expect(prices).toHaveLength(1);
  });
});

describe('quotations and persistent unpaid creation', () => {
  it('rechecks Customer activity inside the quotation transaction', async () => {
    await sell();
    db.$queryRaw.mockImplementationOnce(async () => {
      users.get(2)!.isActive = false;
      return [];
    });
    expect((await post('/orders/quotes', quoteBody, 2)).status).toBe(401);
    expect(quotes.size).toBe(0);
  });
  it('rejects invalid persisted selling prices', async () => {
    await sell();
    prices[0].unitPriceMinor = 0;
    expect((await post('/orders/quotes', quoteBody)).status).toBe(409);
    expect(quotes.size).toBe(0);
  });
  it('quotes a guest, stores only a hashed token and creates exactly one unpaid unassigned order/event', async () => {
    await sell();
    const before = Date.now();
    const q = await quote();
    expect(q.quote).toMatchObject({
      currency: 'USD',
      unitPriceMinor: 199,
      quantity: '1.250',
      totalMinor: 249,
      total: '2.49',
    });
    expect(Date.parse(q.quote.expiresAt)).toBeGreaterThanOrEqual(
      before + 600000,
    );
    expect(Date.parse(q.quote.expiresAt)).toBeLessThanOrEqual(
      Date.now() + 600000,
    );
    expect(quotes.get(q.quote.id)!.guestTokenHash).toBe(
      createHash('sha256').update(q.guestToken).digest('hex'),
    );
    expect(q.quote.guestTokenHash).toBeUndefined();
    const input = creation(q);
    const first = await post('/orders', input);
    const retry = await post('/orders', input);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.order).toEqual(first.body.order);
    expect(first.body.guestAccessToken).toMatch(/^[a-f0-9]{64}$/);
    expect(first.body.guestAccessToken).not.toBe(q.guestToken);
    expect(retry.body.guestAccessToken).toBe(first.body.guestAccessToken);
    expect(orders[0].guestAccessToken).toBeUndefined();
    const tracking = await request(app)
      .get(`/api/orders/${first.body.order.id}`)
      .set('X-Order-Access-Token', first.body.guestAccessToken);
    expect(tracking.status).toBe(200);
    expect(tracking.body.order.status).toBe('AWAITING_PAYMENT');
    expect(
      (
        await request(app)
          .get(`/api/orders/${first.body.order.id}`)
          .set('X-Order-Access-Token', q.guestToken)
      ).status,
    ).toBe(404);
    expect(first.body.order).toMatchObject({
      status: 'AWAITING_PAYMENT',
      pumpId: null,
      currency: 'USD',
      source: 'GUEST',
      fulfillmentType: 'IN_STATION',
      orderedAmountMinor: 249,
    });
    expect(first.headers['cache-control']).toBe('no-store');
    expect(orders).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: 'GUEST',
      actorUserId: null,
      fromStatus: null,
      toStatus: 'AWAITING_PAYMENT',
    });
  });
  it('binds pickup to the authenticated Customer and attributes the initial event', async () => {
    await sell();
    const q = await quote(2, { fulfillmentType: 'PICKUP' });
    expect(q.guestToken).toBeUndefined();
    const result = await post('/orders', creation(q), 2);
    expect(result.status).toBe(201);
    expect(orders[0].userId).toBe(2);
    expect(result.body.guestAccessToken).toBeUndefined();
    expect(result.body.order).toMatchObject({
      source: 'CUSTOMER',
      fulfillmentType: 'PICKUP',
      pumpId: null,
    });
    expect(events[0].actorUserId).toBe(2);
  });
  it('holds the selected price snapshot despite later tariffs', async () => {
    await sell();
    const q = await quote();
    await sell('USD', '9.99', '2021-01-01T00:00:00Z');
    const result = await post('/orders', creation(q));
    expect(result.body.order.unitPriceMinor).toBe(199);
    expect(result.body.order.orderedAmountMinor).toBe(249);
  });
  it('calculates LBP amount orders without USD fallback or conversion', async () => {
    await sell();
    expect(
      (await post('/orders/quotes', { ...quoteBody, currency: 'LBP' })).status,
    ).toBe(409);
    await sell('LBP', '9999');
    const q = await quote(undefined, {
      currency: 'LBP',
      inputMode: 'AMOUNT',
      value: '17',
    });
    expect(q.quote).toMatchObject({
      currency: 'LBP',
      totalMinor: 10,
      total: '10',
      quantity: '0.001',
    });
  });
  it.each([1, 3, 4])(
    'denies staff actor %s from customer quotations',
    async (actor) => {
      await sell();
      expect((await post('/orders/quotes', quoteBody, actor)).status).toBe(403);
    },
  );
  it('rejects guest pickup, missing permission and a malformed cookie without guest fallback', async () => {
    await sell();
    expect(
      (
        await post('/orders/quotes', {
          ...quoteBody,
          fulfillmentType: 'PICKUP',
        })
      ).status,
    ).toBe(401);
    users.get(2)!.permissions = [];
    expect((await post('/orders/quotes', quoteBody, 2)).status).toBe(403);
    expect(
      (
        await post('/orders/quotes', quoteBody).set(
          'Cookie',
          `${ACCESS_COOKIE}=malformed`,
        )
      ).status,
    ).toBe(401);
  });
  it('rejects missing/future prices, invalid fuels and inactive stations', async () => {
    expect((await post('/orders/quotes', quoteBody)).status).toBe(409);
    await sell('USD', '1', '2100-01-01T00:00:00Z');
    expect((await post('/orders/quotes', quoteBody)).status).toBe(409);
    expect(
      (await post('/orders/quotes', { ...quoteBody, fuelTypeId: 99 })).status,
    ).toBe(404);
    stationActive = false;
    expect((await post('/orders/quotes', quoteBody)).status).toBe(409);
  });
  it('rejects expired quotes and deactivated stations at creation', async () => {
    await sell();
    const q = await quote();
    quotes.get(q.quote.id)!.expiresAt = new Date(Date.now() - 1);
    expect((await post('/orders', creation(q))).status).toBe(409);
    const valid = await quote();
    stationActive = false;
    expect((await post('/orders', creation(valid))).status).toBe(409);
    expect(orders).toEqual([]);
    expect(events).toEqual([]);
  });
  it('rejects at the exact expiry boundary, including expiry while waiting on a station lock', async () => {
    await sell();
    const q = await quote();
    const expiry = Date.now() + 1000;
    quotes.get(q.quote.id)!.expiresAt = new Date(expiry);
    const original = db.$queryRaw.getMockImplementation()!;
    db.$queryRaw.mockImplementation(async (...args) => {
      if ((args[0] as TemplateStringsArray).join('').includes('FROM stations'))
        jest.spyOn(Date, 'now').mockReturnValue(expiry);
      return original(...args);
    });
    expect((await post('/orders', creation(q))).status).toBe(409);
    expect(orders).toEqual([]);
  });
  it('authorizes every quote and replay against its customer or guest secret', async () => {
    await sell();
    const guest = await quote();
    expect(
      (
        await post('/orders', {
          quoteId: guest.quote.id,
          idempotencyKey: randomUUID(),
        })
      ).status,
    ).toBe(404);
    expect(
      (await post('/orders', creation(guest, { guestToken: 'a'.repeat(64) })))
        .status,
    ).toBe(404);
    expect((await post('/orders', creation(guest), 2)).status).toBe(404);
    const owned = await quote(2);
    const input = creation(owned);
    expect((await post('/orders', input, 5)).status).toBe(404);
    expect((await post('/orders', input)).status).toBe(404);
    expect((await post('/orders', input, 2)).status).toBe(201);
    expect((await post('/orders', input, 5)).status).toBe(404);
  });
  it('conflicts on changed payloads, reused keys or a second key for a consumed quote', async () => {
    await sell();
    const q = await quote();
    const input = creation(q, { customerName: 'Guest' });
    expect((await post('/orders', input)).status).toBe(201);
    expect(
      (await post('/orders', { ...input, customerName: 'Changed' })).status,
    ).toBe(409);
    expect((await post('/orders', creation(q))).status).toBe(409);
    const other = await quote();
    expect(
      (
        await post(
          '/orders',
          creation(other, { idempotencyKey: input.idempotencyKey }),
        )
      ).status,
    ).toBe(409);
    expect(orders).toHaveLength(1);
    expect(events).toHaveLength(1);
  });
  it('replays a committed result after expiry/deactivation but never creates another order', async () => {
    await sell();
    const q = await quote();
    const input = creation(q);
    const first = await post('/orders', input);
    quotes.get(q.quote.id)!.expiresAt = new Date(0);
    stationActive = false;
    const retry = await post('/orders', input);
    expect(retry.status).toBe(200);
    expect(retry.body.order).toEqual(first.body.order);
    expect(orders).toHaveLength(1);
    expect(events).toHaveLength(1);
  });
  it('rolls back order creation if its initial event fails and permits a clean retry', async () => {
    await sell();
    const q = await quote();
    const input = creation(q);
    db.orderEvent.create.mockRejectedValueOnce(new Error('Event unavailable'));
    expect((await post('/orders', input)).status).toBe(500);
    expect(orders).toEqual([]);
    expect(events).toEqual([]);
    expect((await post('/orders', input)).status).toBe(201);
    expect(events).toHaveLength(1);
  });
  it.each(['P2034', 'P2002'])(
    'retries %s using a fresh transaction',
    async (code) => {
      await sell();
      const q = await quote();
      db.$transaction.mockRejectedValueOnce({ code });
      expect((await post('/orders', creation(q))).status).toBe(201);
      expect(orders).toHaveLength(1);
      expect(events).toHaveLength(1);
    },
  );
  it('keeps unpaid records out of the employee queue and rejects claim/completion', async () => {
    await sell();
    const q = await quote();
    const result = await post('/orders', creation(q));
    const queue = await get('/employee/orders', 3);
    expect(queue.status).toBe(200);
    expect(queue.body.orders).toEqual([]);
    expect(queue.body.pagination.total).toBe(0);
    for (const action of ['claim', 'complete'])
      expect(
        (
          await post(
            `/employee/orders/${result.body.order.id}/${action}`,
            {},
            3,
          )
        ).status,
      ).toBe(409);
    expect(orders[0].status).toBe('AWAITING_PAYMENT');
    expect(events).toHaveLength(1);
  });
  it('retains browser CSRF protection for guest quotations and creation', async () => {
    expect(
      (await post('/orders/quotes', quoteBody, undefined, false)).status,
    ).toBe(403);
    expect(
      (
        await post(
          '/orders',
          { quoteId: randomUUID(), idempotencyKey: randomUUID() },
          undefined,
          false,
        )
      ).status,
    ).toBe(403);
  });
  it('requires a creation idempotency key and rejects unsupported fulfillment/extra input', async () => {
    await sell();
    const q = await quote();
    expect(
      (await post('/orders', { quoteId: q.quote.id, guestToken: q.guestToken }))
        .status,
    ).toBe(400);
    expect(
      (
        await post('/orders/quotes', {
          ...quoteBody,
          fulfillmentType: 'DELIVERY',
        })
      ).status,
    ).toBe(400);
    expect((await post('/orders', creation(q, { totalMinor: 1 }))).status).toBe(
      400,
    );
  });
});

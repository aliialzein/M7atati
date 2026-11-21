import type { PrismaClient } from '../../src/generated/prisma/client.js';
import {
  createEmployeeOrderFixtures,
  employeeOrdersTestUrl,
} from '../../scripts/employee-orders-fixtures.js';
const target =
  'postgresql://fixture:fixture@localhost:5432/m7atati_employee_orders_verify_test';
it.each([
  {},
  { DATABASE_URL: target },
  { EMPLOYEE_ORDERS_TEST_DATABASE_URL: target },
  {
    EMPLOYEE_ORDERS_TEST_DATABASE_URL: target.replace(
      'm7atati_employee_orders_verify_test',
      'm7atati',
    ),
    ALLOW_EMPLOYEE_ORDER_FIXTURES: 'yes',
  },
  {
    EMPLOYEE_ORDERS_TEST_DATABASE_URL: target.replace(
      'localhost',
      'example.com',
    ),
    ALLOW_EMPLOYEE_ORDER_FIXTURES: 'yes',
  },
  {
    EMPLOYEE_ORDERS_TEST_DATABASE_URL: `${target}?schema=other`,
    ALLOW_EMPLOYEE_ORDER_FIXTURES: 'yes',
  },
])('rejects unapproved or development targets %j', (environment) => {
  expect(() => employeeOrdersTestUrl(environment)).toThrow();
});
it('accepts only the explicit disposable target and authorization', () => {
  expect(
    employeeOrdersTestUrl({
      EMPLOYEE_ORDERS_TEST_DATABASE_URL: target,
      ALLOW_EMPLOYEE_ORDER_FIXTURES: 'yes',
    }),
  ).toBe(target);
});
it('creates two isolated orders/events transactionally, is repeatable, and preserves manual status changes', async () => {
  const stations: {
    id: number;
    name: string;
    address: string;
    isActive: boolean;
  }[] = [];
  const orders: {
    id: number;
    stationId: number;
    pumpId: number;
    source: string;
    status: string;
  }[] = [];
  const events: { orderId: number; fromStatus: null; toStatus: string }[] = [];
  const users = new Map<
    string,
    { id: number; isActive: boolean; stationId: number; roleId: number }
  >();
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ locked: 1 }]),
    role: { upsert: jest.fn().mockResolvedValue({ id: 1 }) },
    permission: { upsert: jest.fn().mockResolvedValue({ id: 2 }) },
    rolePermission: { upsert: jest.fn() },
    fuelType: { upsert: jest.fn().mockResolvedValue({ id: 1 }) },
    station: {
      findMany: jest.fn(async ({ where }) =>
        stations.filter(
          (s) => s.name === where.name && s.address === where.address,
        ),
      ),
      create: jest.fn(async ({ data }) => {
        const row = { ...data, id: stations.length + 1, isActive: true };
        stations.push(row);
        return row;
      }),
    },
    pump: {
      upsert: jest.fn(async ({ create }) => ({
        ...create,
        id: create.stationId * 10,
      })),
    },
    fuelOrder: {
      findMany: jest.fn(async ({ where }) =>
        orders.filter(
          (o) => o.stationId === where.stationId && o.source === where.source,
        ),
      ),
      create: jest.fn(async ({ data }) => {
        const row = { ...data, id: orders.length + 1 };
        orders.push(row);
        return row;
      }),
    },
    orderEvent: {
      create: jest.fn(async ({ data }) => {
        events.push(data);
        return data;
      }),
      count: jest.fn(
        async ({ where }) =>
          events.filter(
            (e) =>
              e.orderId === where.orderId &&
              e.fromStatus === null &&
              e.toStatus === 'PENDING',
          ).length,
      ),
    },
    user: {
      upsert: jest.fn(async ({ where, create }) => {
        if (!users.has(where.email))
          users.set(where.email, {
            ...create,
            id: users.size + 1,
            isActive: true,
          });
        return users.get(where.email);
      }),
    },
  };
  const database = {
    $transaction: jest.fn((work: (client: typeof tx) => Promise<unknown>) =>
      work(tx),
    ),
  };
  const first = await createEmployeeOrderFixtures(
    database as unknown as PrismaClient,
    'test-hash',
  );
  expect(
    await createEmployeeOrderFixtures(
      database as unknown as PrismaClient,
      'another-hash',
    ),
  ).toEqual(first);
  expect(stations).toHaveLength(2);
  expect(orders).toHaveLength(2);
  expect(events).toHaveLength(2);
  expect(users.size).toBe(3);
  expect(first[0].employees).toHaveLength(2);
  expect(first[1].employees).toHaveLength(1);
  expect(orders.map((o) => o.pumpId)).toEqual(
    orders.map((o) => o.stationId * 10),
  );
  expect(tx.orderEvent.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      actorType: 'SYSTEM',
      fromStatus: null,
      toStatus: 'PENDING',
    }),
  });
  expect(database.$transaction).toHaveBeenCalledWith(expect.any(Function), {
    timeout: 10000,
  });
  orders[0].status = 'COMPLETED';
  expect(
    (
      await createEmployeeOrderFixtures(
        database as unknown as PrismaClient,
        'test-hash',
      )
    )[0].status,
  ).toBe('COMPLETED');
  expect(events).toHaveLength(2);
});

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import request from 'supertest';
import {
  ordersVerificationTarget,
  requireOrdersVerificationMutations,
} from './orders-verification-safety.js';
import {
  ordersDatabasePreflight,
  ordersMigrationInventory,
  verifyOrdersConstraints,
} from './orders-verification-preflight.js';
import { assertReviewedMigrationHistory } from './postgres-verification-migrations.js';

let phase = 'target safety';
async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const mode = process.argv[2] ?? '--preflight';
  assert(
    ['--preflight', '--verify'].includes(mode) && process.argv.length <= 3,
  );
  const protectedUrls = ['.env', 'apps/api/.env'].flatMap((name) => {
    const path = resolve(root, name);
    const value = existsSync(path)
      ? parse(readFileSync(path)).DATABASE_URL
      : undefined;
    return value ? [value] : [];
  });
  const target = ordersVerificationTarget(process.env, protectedUrls);
  // Separate Task 05 namespace prevents accidentally reusing retained earlier fixtures.
  assert(
    /^m7atati_employee_orders_verify_pumps_task05(?:_[a-z0-9_]+)?$/.test(
      target.name,
    ),
  );
  if (mode === '--verify') requireOrdersVerificationMutations(process.env);
  const migrations = resolve(root, 'apps/api/prisma/migrations');
  assertReviewedMigrationHistory(
    ordersMigrationInventory(migrations).map((row) => row.name),
  );
  process.env.DATABASE_URL = target.url;
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_SECRET = randomBytes(32).toString('hex');
  process.env.JWT_REFRESH_SECRET = randomBytes(32).toString('hex');
  // Application/database imports occur only after target and mutation guards.
  const { prisma } = await import('../src/database/prisma.js');
  try {
    phase = 'read-only preflight';
    const history = await ordersDatabasePreflight(
      prisma,
      target.name,
      migrations,
    );
    console.info(JSON.stringify(history, null, 2));
    if (mode === '--preflight') return;
    assert.equal(
      history.pending.length,
      0,
      'Deploy reviewed migrations separately first',
    );
    assert.equal(
      history.conflicts.length,
      0,
      'Review existing conflicts without repairing data',
    );
    phase = 'order and pump constraint metadata';
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await verifyOrdersConstraints(tx);
      const indexes = await tx.$queryRaw<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes WHERE schemaname='public'
        AND indexname='pumps_station_id_number_key'`;
      assert.equal(indexes.length, 1);
      assert(indexes[0].indexdef.includes('UNIQUE'));
      const foreignKeys = await tx.$queryRaw<
        { conname: string; convalidated: boolean }[]
      >`
        SELECT conname, convalidated FROM pg_constraint
        WHERE conname IN ('pumps_station_id_fkey', 'orders_pump_id_fkey')
          AND connamespace='public'::regnamespace`;
      assert.equal(foreignKeys.length, 2);
      assert(foreignKeys.every((row) => row.convalidated));
    });
    console.info(
      'PASS: required order constraints, pump number uniqueness and station/order pump foreign keys',
    );
    const { app } = await import('../src/app.js');
    const { env } = await import('../src/config/env.js');
    const { tokenService } =
      await import('../src/modules/auth/token.service.js');
    phase = 'isolated fixtures';
    const makeRole = async (name: string, keys: string[]) => {
      const role = await prisma.role.upsert({
        where: { name },
        update: {},
        create: { name },
      });
      for (const key of keys) {
        const permission = await prisma.permission.upsert({
          where: { key },
          update: {},
          create: { key },
        });
        await prisma.rolePermission.upsert({
          where: {
            roleId_permissionId: {
              roleId: role.id,
              permissionId: permission.id,
            },
          },
          update: {},
          create: { roleId: role.id, permissionId: permission.id },
        });
      }
      return role.id;
    };
    const managerRole = await makeRole('MANAGER', ['payments.manage']);
    const employeeRole = await makeRole('EMPLOYEE', ['orders.update']);
    const customerRole = await makeRole('CUSTOMER', ['orders.cancel']);
    const customer = await prisma.user.create({
      data: {
        name: 'Pump cancellation fixture',
        email: `${randomUUID()}@pump-lookup.invalid`,
        passwordHash: '!No-login-fixture',
        roleId: customerRole,
      },
    });
    const manager = await prisma.user.create({
      data: {
        name: 'Pump lookup fixture',
        email: `${randomUUID()}@pump-lookup.invalid`,
        passwordHash: '!No-login-fixture',
        roleId: managerRole,
      },
    });
    const station = await prisma.station.create({
      data: { name: `Pump lookup ${randomUUID()}`, managerId: manager.id },
    });
    const foreign = await prisma.station.create({
      data: { name: `Foreign ${randomUUID()}` },
    });
    const employee = await prisma.user.create({
      data: {
        name: 'Pump lookup worker',
        email: `${randomUUID()}@pump-lookup.invalid`,
        passwordHash: '!No-login-fixture',
        roleId: employeeRole,
        stationId: station.id,
      },
    });
    const fuel = await prisma.fuelType.create({
      data: { code: `PUMP_${randomUUID()}`, name: 'Pump fixture fuel' },
    });
    const pump = await prisma.pump.create({
      data: { stationId: station.id, number: 2, status: 'IDLE' },
    });
    const offline = await prisma.pump.create({
      data: { stationId: station.id, number: 1, status: 'OFFLINE' },
    });
    const foreignPump = await prisma.pump.create({
      data: { stationId: foreign.id, number: 3, status: 'IDLE' },
    });
    const api = async (
      method: 'get' | 'post',
      path: string,
      actor: number,
      expected: number | readonly number[],
      body?: object,
    ) => {
      const client = request(app);
      const call = client[method](`/api${path}`)
        .set(
          'Cookie',
          `m7atati_access=${tokenService.issue(actor).accessToken}`,
        )
        .set('Origin', env.allowedOrigins[0])
        .set('X-CSRF-Protection', '1')
        .timeout(12000);
      if (body) call.send(body);
      const response = await call;
      assert(
        typeof expected === 'number'
          ? response.status === expected
          : expected.includes(response.status),
        `${method} ${path}: HTTP ${response.status}`,
      );
      return response;
    };
    const lookup = async (expected = 200) =>
      api('get', `/stations/${station.id}/pumps`, manager.id, expected);
    phase = 'station scope, ordering and read-only behavior';
    const before = await prisma.pump.findMany({
      where: { stationId: station.id },
      orderBy: { id: 'asc' },
    });
    const initial = await lookup();
    assert.deepEqual(initial.body, {
      pumps: [
        { id: offline.id, number: 1, status: 'OFFLINE', available: false },
        { id: pump.id, number: 2, status: 'IDLE', available: true },
      ],
    });
    assert.deepEqual(
      await prisma.pump.findMany({
        where: { stationId: station.id },
        orderBy: { id: 'asc' },
      }),
      before,
    );
    await api('get', `/stations/${foreign.id}/pumps`, manager.id, 404);
    await api('get', `/stations/${station.id}/pumps`, employee.id, 403);
    const available = async () =>
      (await lookup()).body.pumps.find(
        (row: { id: number }) => row.id === pump.id,
      ).available;
    phase = 'real cash reservation, claim and completion';
    const order = await prisma.fuelOrder.create({
      data: {
        stationId: station.id,
        fuelTypeId: fuel.id,
        source: 'PUMP_LOOKUP_TEST',
        status: 'AWAITING_PAYMENT',
        currency: 'USD',
        unitPriceMinor: 100,
        orderedVolume: '1',
        orderedAmountMinor: 100,
      },
    });
    await api(
      'post',
      `/manager/stations/${station.id}/orders/${order.id}/confirm-cash`,
      manager.id,
      201,
      { pumpId: pump.id, currency: 'USD', amountMinor: 100 },
    );
    assert.equal(await available(), false);
    await api(
      'post',
      `/employee/orders/${order.id}/claim`,
      employee.id,
      200,
      {},
    );
    assert.equal(await available(), false);
    await api(
      'post',
      `/employee/orders/${order.id}/complete`,
      employee.id,
      200,
      {},
    );
    assert.equal(await available(), true);
    assert.equal(
      (await prisma.pump.findUniqueOrThrow({ where: { id: pump.id } })).status,
      'IDLE',
    );
    phase = 'legacy unpaid reservation and terminal history';
    const legacy = await prisma.fuelOrder.create({
      data: {
        stationId: station.id,
        fuelTypeId: fuel.id,
        pumpId: pump.id,
        source: 'PUMP_LOOKUP_TEST',
        status: 'PENDING',
        unitPriceMinor: 100,
        orderedVolume: '1',
        orderedAmountMinor: 100,
      },
    });
    assert.equal(
      await available(),
      false,
      'Unpaid pending orders still reserve pumps',
    );
    await prisma.fuelOrder.update({
      where: { id: legacy.id },
      data: { status: 'CANCELLED' },
    });
    assert.equal(
      await available(),
      true,
      'Terminal history does not reserve pumps',
    );
    console.info(
      'PASS: IDLE/unreserved, non-IDLE, station scope, ownership, cash PENDING, claimed IN_PROGRESS, completion and terminal fixture release',
    );

    const waiting = () =>
      prisma.fuelOrder.create({
        data: {
          stationId: station.id,
          fuelTypeId: fuel.id,
          userId: customer.id,
          source: 'PUMP_LOOKUP_TEST',
          status: 'AWAITING_PAYMENT',
          currency: 'USD',
          unitPriceMinor: 100,
          orderedVolume: '1',
          orderedAmountMinor: 100,
        },
      });
    const confirm = (id: number, expected: number | readonly number[]) =>
      api(
        'post',
        `/manager/stations/${station.id}/orders/${id}/confirm-cash`,
        manager.id,
        expected,
        { pumpId: pump.id, currency: 'USD', amountMinor: 100 },
      );
    const saved = (id: number) =>
      prisma.fuelOrder.findUniqueOrThrow({
        where: { id },
        include: { payments: true, events: true },
      });
    phase = 'rejected non-IDLE and foreign pump selection';
    const rejected = await waiting();
    const rejectedBefore = await saved(rejected.id);
    for (const invalidPump of [offline, foreignPump]) {
      await api(
        'post',
        `/manager/stations/${station.id}/orders/${rejected.id}/confirm-cash`,
        manager.id,
        409,
        { pumpId: invalidPump.id, currency: 'USD', amountMinor: 100 },
      );
      assert.deepEqual(await saved(rejected.id), rejectedBefore);
    }
    assert.equal(await available(), true);
    console.info(
      'PASS: non-IDLE and cross-station cash selections rejected without changing order/payment/event records',
    );
    phase = 'supported cancellation API';
    const cancelled = await waiting();
    await api('post', `/orders/${cancelled.id}/cancel`, customer.id, 200, {});
    assert.equal((await saved(cancelled.id)).status, 'CANCELLED');
    assert.equal(await available(), true);
    console.info(
      'PASS: unpaid cancellation API leaves availability free; direct terminal fixture transition above is not a paid cancellation API',
    );

    phase = 'rollback after order and payment writes';
    const rollbackOrder = await waiting();
    const rollbackBefore = await saved(rollbackOrder.id);
    const { cashOrdersRepository } =
      await import('../src/modules/orders/orders.repository.js');
    const originalTransaction = cashOrdersRepository.transaction;
    let injected = false;
    cashOrdersRepository.transaction = (work) =>
      originalTransaction(async (tx) => {
        const proxy = new Proxy(tx, {
          get(target, property) {
            if (property !== 'orderEvent') return Reflect.get(target, property);
            return new Proxy(target.orderEvent, {
              get(delegate, key) {
                if (key !== 'create') return Reflect.get(delegate, key);
                return async () => {
                  injected = true;
                  try {
                    await tx.$queryRaw`SELECT 1 / 0`;
                  } catch (error) {
                    const failure = error as {
                      code?: string;
                      meta?: {
                        code?: string;
                        driverAdapterError?: {
                          cause?: { originalCode?: string };
                        };
                      };
                    };
                    console.info(
                      JSON.stringify({
                        expectedRollbackError: failure.code,
                        sqlState:
                          failure.meta?.code ??
                          failure.meta?.driverAdapterError?.cause?.originalCode,
                      }),
                    );
                    throw error;
                  }
                  throw new Error('Expected database error did not occur');
                };
              },
            });
          },
        });
        return work(proxy);
      });
    try {
      await confirm(rollbackOrder.id, 500);
    } finally {
      cashOrdersRepository.transaction = originalTransaction;
    }
    assert(injected, 'Failure must occur inside the payment transaction');
    assert.deepEqual(await saved(rollbackOrder.id), rollbackBefore);
    assert.equal(await available(), true);
    console.info(
      'PASS: injected PostgreSQL failure rolls back order/payment/event writes; original records preserved',
    );

    phase = 'concurrent cash confirmations';
    const contenders = await Promise.all([waiting(), waiting()]);
    const originalRows = await Promise.all(
      contenders.map((row) => saved(row.id)),
    );
    const responses = await Promise.all(
      contenders.map((row) => confirm(row.id, [201, 409])),
    );
    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [201, 409],
    );
    const winner =
      contenders[responses.findIndex((response) => response.status === 201)];
    const loserIndex = responses.findIndex(
      (response) => response.status === 409,
    );
    const loser = contenders[loserIndex];
    assert.deepEqual(await saved(loser.id), originalRows[loserIndex]);
    const active = await prisma.fuelOrder.findMany({
      where: { pumpId: pump.id, status: { in: ['PENDING', 'IN_PROGRESS'] } },
    });
    assert.equal(active.length, 1);
    assert.equal(active[0].id, winner.id);
    const winningRecord = await saved(winner.id);
    assert.equal(winningRecord.payments.length, 1);
    assert.equal(winningRecord.events.length, 1);
    await assert.rejects(
      prisma.fuelOrder.update({
        where: { id: loser.id },
        data: { pumpId: pump.id, status: 'PENDING' },
      }),
      (error: unknown) => (error as { code?: string }).code === 'P2002',
    );
    assert.deepEqual(await saved(loser.id), originalRows[loserIndex]);
    await api('post', `/orders/${winner.id}/cancel`, customer.id, 409, {});
    assert.deepEqual(await saved(winner.id), winningRecord);
    assert.equal(await available(), false);
    for (const action of ['claim', 'complete'])
      await api(
        'post',
        `/employee/orders/${winner.id}/${action}`,
        employee.id,
        200,
        {},
      );
    assert.equal(await available(), true);
    console.info(
      'PASS: concurrent cash HTTP 201/409, one reservation/payment/event, losing records unchanged, direct duplicate P2002, paid cancellation rejected without changes, completion releases winner',
    );
    phase = 'inactive station';
    await prisma.station.update({
      where: { id: station.id },
      data: { isActive: false },
    });
    await lookup(409);
    console.info(
      'PASS: scoped pumps, ordering, no lookup writes, status exclusion, cash/claim/completion reservations, unpaid pending reservations, terminal history and inactive station; fixtures retained',
    );
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((error: unknown) => {
  const failure = error as {
    name?: string;
    code?: string;
    message?: string;
    meta?: {
      code?: string;
      driverAdapterError?: { cause?: { originalCode?: string } };
    };
  };
  // Emit only classifications and bounded assertion diagnostics, never a raw
  // Prisma error, query arguments, connection URL or fixture records.
  console.error(
    JSON.stringify({
      errorType: failure.name,
      code: failure.code,
      sqlState:
        failure.meta?.code ??
        failure.meta?.driverAdapterError?.cause?.originalCode,
      assertion:
        failure.code === 'ERR_ASSERTION'
          ? failure.message?.slice(0, 240)
          : undefined,
    }),
  );
  console.error(
    `Pump lookup verification stopped during ${phase}; no database reset, deletion, migration or Stage 9 invocation.`,
  );
  process.exitCode = 1;
});

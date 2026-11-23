import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import {
  createEmployeeOrderFixtures,
  employeeOrdersTestUrl,
} from './employee-orders-fixtures.js';

async function main() {
  const target = employeeOrdersTestUrl();
  const database = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: target,
      connectionTimeoutMillis: 5000,
      query_timeout: 10000,
    }),
    log: [],
  });
  try {
    // Usable fixture credentials must be deliberately supplied, never printed.
    const { registerSchema } =
      await import('../src/modules/auth/auth.validation.js');
    const password = registerSchema.shape.password.parse(
      process.env.EMPLOYEE_ORDER_FIXTURE_PASSWORD,
    );
    const { passwordService } =
      await import('../src/modules/auth/password.service.js');
    const hash = await passwordService.hash(password);
    const first = await createEmployeeOrderFixtures(database, hash);
    assert.deepEqual(await createEmployeeOrderFixtures(database, hash), first);
    const probe = (id: number) => {
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          'apps/api/scripts/employee-orders-fixture.ts',
          '--probe',
          `--employee=${id}`,
        ],
        {
          env: process.env,
          encoding: 'utf8',
          timeout: 30000,
          maxBuffer: 1024 * 1024,
        },
      );
      assert.equal(
        result.status,
        0,
        'Isolated API process probe failed (details withheld)',
      );
      return JSON.parse(result.stdout) as {
        stationId: number;
        orders: { id: number }[];
      };
    };
    const a1 = probe(first[0].employees[0].id);
    const a2 = probe(first[0].employees[1].id);
    const restarted = probe(first[0].employees[0].id);
    const b = probe(first[1].employees[0].id);
    assert.deepEqual(a1, a2);
    assert.deepEqual(a1, restarted);
    assert.equal(a1.stationId, first[0].stationId);
    assert.equal(b.stationId, first[1].stationId);
    assert(a1.orders.some((order) => order.id === first[0].orderId));
    assert(!a1.orders.some((order) => order.id === first[1].orderId));
    assert(b.orders.some((order) => order.id === first[1].orderId));
    // A new marked order on each verification run preserves all earlier history.
    const raceOrder = await database.$transaction(async (tx) => {
      // Share the fixture lock so concurrent verifier runs allocate distinct
      // pump numbers without changing any retained fixture reservation.
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(73190211)`;
      const original = await tx.fuelOrder.findUniqueOrThrow({
        where: { id: first[0].orderId },
      });
      const lastPump = await tx.pump.findFirst({
        where: { stationId: original.stationId },
        orderBy: { number: 'desc' },
        select: { number: true },
      });
      const pump = await tx.pump.create({
        data: {
          stationId: original.stationId,
          number: (lastPump?.number ?? 0) + 1,
          status: 'IDLE',
        },
      });
      const order = await tx.fuelOrder.create({
        data: {
          stationId: original.stationId,
          pumpId: pump.id,
          fuelTypeId: original.fuelTypeId,
          source: `EMPLOYEE_WORK_RACE_${randomUUID()}`,
          status: 'PENDING',
          orderedVolume: original.orderedVolume,
          unitPriceMinor: original.unitPriceMinor,
          orderedAmountMinor: original.orderedAmountMinor,
        },
      });
      await tx.orderEvent.create({
        data: { orderId: order.id, actorType: 'SYSTEM', toStatus: 'PENDING' },
      });
      return order;
    });
    const race = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'apps/api/scripts/employee-orders-fixture.ts',
        '--probe',
        '--race',
        `--employee=${first[0].employees[0].id}`,
        `--second=${first[0].employees[1].id}`,
        `--order=${raceOrder.id}`,
      ],
      {
        env: process.env,
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      },
    );
    assert.equal(
      race.status,
      0,
      'Claim race process failed (details withheld)',
    );
    const results = JSON.parse(race.stdout) as {
      employee: number;
      status: number;
    }[];
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
    const winner = results.find((result) => result.status === 200)!;
    const persisted = await database.fuelOrder.findUniqueOrThrow({
      where: { id: raceOrder.id },
      include: { events: true },
    });
    assert.equal(persisted.status, 'IN_PROGRESS');
    assert.equal(persisted.assignedEmployeeId, winner.employee);
    assert(persisted.claimedAt);
    const claims = persisted.events.filter(
      (event) => event.toStatus === 'IN_PROGRESS',
    );
    assert.equal(claims.length, 1);
    assert.equal(claims[0].actorUserId, winner.employee);
    assert.equal(claims[0].fromStatus, 'PENDING');
    assert.equal(persisted.dispensedVolume, null);
    assert.equal(persisted.finalMinor, null);
    console.info(
      'PASS: repeatable fixtures, shared persisted orders, station isolation, API restarts, concurrent claims with one winner/event and consistent persisted state',
    );
  } finally {
    await database.$disconnect();
  }
}
main().catch(() => {
  console.error(
    'Disposable queue verification failed or is not configured; no development fallback or migrations',
  );
  process.exitCode = 1;
});

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { UserProfile } from '../src/modules/auth/auth.types.js';
import {
  employeeOrdersTestUrl,
  createEmployeeOrderFixtures,
} from './employee-orders-fixtures.js';

// Explicitly invoked only. Requires an already migrated, disposable local database.
// Appends marked fixtures; never migrates, truncates, deletes, or repairs old rows.
async function main() {
  const target = employeeOrdersTestUrl();
  process.env.DATABASE_URL = target;
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_SECRET = randomBytes(32).toString('hex');
  process.env.JWT_REFRESH_SECRET = randomBytes(32).toString('hex');
  const { prisma } = await import('../src/database/prisma.js');
  const { employeeOrdersService } =
    await import('../src/modules/orders/orders.service.js');
  const { employeeOrdersRepository } =
    await import('../src/modules/orders/orders.repository.js');
  const { usersService } =
    await import('../src/modules/users/users.service.js');
  const { usersRepository } =
    await import('../src/modules/users/users.repository.js');
  const { stationsService } =
    await import('../src/modules/stations/stations.service.js');
  const { stationsRepository } =
    await import('../src/modules/stations/stations.repository.js');
  const { HttpError } = await import('../src/types/http-error.js');
  const run = randomUUID();
  try {
    const identity = await prisma.$queryRaw<{ name: string; schema: string }[]>`
      SELECT current_database() AS name, current_schema() AS schema`;
    assert.equal(
      identity[0].name,
      decodeURIComponent(new URL(target).pathname.slice(1)),
    );
    assert.equal(identity[0].schema, 'public');
    const fixtures = await createEmployeeOrderFixtures(
      prisma,
      '!No-login-verification-fixture',
    );
    const template = await prisma.fuelOrder.findUniqueOrThrow({
      where: { id: fixtures[0].orderId },
    });
    const employeeRole = await prisma.role.findUniqueOrThrow({
      where: { name: 'EMPLOYEE' },
    });
    const adminRole = await prisma.role.upsert({
      where: { name: 'ADMIN' },
      update: {},
      create: { name: 'ADMIN' },
    });
    const securityRole = await prisma.role.upsert({
      where: { name: 'SECURITY' },
      update: {},
      create: { name: 'SECURITY' },
    });
    const createPerson = (roleId: number, stationId: number | null) =>
      prisma.user.create({
        data: {
          name: 'Order consistency verification',
          email: `${randomUUID()}@order-consistency.invalid`,
          passwordHash: '!No-login-verification-fixture',
          roleId,
          stationId,
        },
      });
    const admin = await createPerson(adminRole.id, null);
    const context = {
      user: {
        id: admin.id,
        name: admin.name,
        email: admin.email,
        role: 'ADMIN',
        stationId: null,
      },
      permissions: ['employees.transfer', 'users.update'],
    };
    const employee = async (
      stationId = template.stationId,
    ): Promise<UserProfile> => {
      const person = await createPerson(employeeRole.id, stationId);
      return {
        id: person.id,
        name: person.name,
        email: person.email,
        role: 'EMPLOYEE',
        stationId: person.stationId,
      };
    };
    const newOrder = async (
      stationId = template.stationId,
      pumpId?: number,
    ) => {
      // Each active fixture needs its own reservation. Never reuse a retained
      // claim's pump or repair historical rows to satisfy the Stage 6 index.
      if (pumpId === undefined) {
        const last = await prisma.pump.findFirst({
          where: { stationId },
          orderBy: { number: 'desc' },
          select: { number: true },
        });
        pumpId = (
          await prisma.pump.create({
            data: {
              stationId,
              number: (last?.number ?? 0) + 1,
              status: 'IDLE',
            },
          })
        ).id;
      }
      return prisma.fuelOrder.create({
        data: {
          stationId,
          pumpId,
          fuelTypeId: template.fuelTypeId,
          source: `ORDER_CONSISTENCY_${run}`,
          status: 'PENDING',
          orderedVolume: template.orderedVolume,
          unitPriceMinor: template.unitPriceMinor,
          orderedAmountMinor: template.orderedAmountMinor,
        },
      });
    };
    const persisted = (id: number) =>
      prisma.fuelOrder.findUniqueOrThrow({
        where: { id },
        include: { events: { orderBy: { id: 'asc' } } },
      });
    const conflict = (work: Promise<unknown>) =>
      assert.rejects(
        work,
        (error: unknown) =>
          error instanceof HttpError && error.statusCode === 409,
      );

    const a = await employee();
    const b = await employee();
    const order = await newOrder();
    const race = await Promise.allSettled([
      employeeOrdersService.transition(a, order.id, 'claim'),
      employeeOrdersService.transition(b, order.id, 'claim'),
    ]);
    assert.equal(
      race.filter((outcome) => outcome.status === 'fulfilled').length,
      1,
    );
    const loser = race.find((outcome) => outcome.status === 'rejected');
    assert(
      loser?.status === 'rejected' &&
        loser.reason instanceof HttpError &&
        loser.reason.statusCode === 409,
    );
    let saved = await persisted(order.id);
    assert.equal(saved.status, 'IN_PROGRESS');
    assert.equal(saved.events.length, 1);
    const winner = saved.assignedEmployeeId === a.id ? a : b;
    assert.equal(saved.events[0].actorUserId, winner.id);
    assert.equal(saved.events[0].fromStatus, 'PENDING');
    assert.equal(saved.events[0].toStatus, 'IN_PROGRESS');
    const claimedAt = saved.claimedAt?.getTime();
    await Promise.all(
      [1, 2].map(() =>
        employeeOrdersService.transition(winner, order.id, 'claim'),
      ),
    );
    assert.equal((await persisted(order.id)).events.length, 1);

    await conflict(
      usersService.transfer(context, winner.id, fixtures[1].stationId),
    );
    await conflict(usersService.setStatus(context, winner.id, false));
    await conflict(
      usersService.update(context, winner.id, { role: 'SECURITY' }),
    );
    const foreign = { ...b, stationId: fixtures[1].stationId };
    const outsider = await createPerson(employeeRole.id, foreign.stationId);
    await assert.rejects(
      employeeOrdersService.detail({ ...foreign, id: outsider.id }, order.id),
      (error: unknown) =>
        error instanceof HttpError && error.statusCode === 404,
    );
    await assert.rejects(
      employeeOrdersService.transition(
        { ...foreign, id: outsider.id },
        order.id,
        'claim',
      ),
      (error: unknown) =>
        error instanceof HttpError && error.statusCode === 404,
    );

    await Promise.all(
      [1, 2].map(() =>
        employeeOrdersService.transition(winner, order.id, 'complete'),
      ),
    );
    await employeeOrdersService.transition(winner, order.id, 'claim');
    saved = await persisted(order.id);
    assert.equal(saved.status, 'COMPLETED');
    assert.equal(saved.claimedAt?.getTime(), claimedAt);
    assert.equal(saved.events.length, 2);
    assert.equal(saved.events[1].fromStatus, 'IN_PROGRESS');
    assert.equal(saved.events[1].toStatus, 'COMPLETED');
    assert.equal(saved.events[1].actorUserId, winner.id);
    await usersService.transfer(context, winner.id, fixtures[1].stationId);
    console.info(
      'PASS: competing claims, unique events, duplicate actions, eligibility conflicts, completion and cross-station isolation',
    );

    // Force an actual FK failure during event insertion, after the conditional update.
    assert.equal(
      await prisma.user.findUnique({ where: { id: -2147483648 } }),
      null,
    );
    const originalEvent = employeeOrdersRepository.event;
    const rollbackActor = await employee();
    const rollbackOrder = await newOrder();
    try {
      employeeOrdersRepository.event = (id, _actor, from, to, tx) =>
        originalEvent(id, -2147483648, from, to, tx);
      await conflict(
        employeeOrdersService.transition(
          rollbackActor,
          rollbackOrder.id,
          'claim',
        ),
      );
      const unchanged = await persisted(rollbackOrder.id);
      assert.equal(unchanged.status, 'PENDING');
      assert.equal(unchanged.assignedEmployeeId, null);
      assert.equal(unchanged.claimedAt, null);
      assert.equal(unchanged.events.length, 0);
    } finally {
      employeeOrdersRepository.event = originalEvent;
    }
    await employeeOrdersService.transition(
      rollbackActor,
      rollbackOrder.id,
      'claim',
    );
    try {
      employeeOrdersRepository.event = (id, _actor, from, to, tx) =>
        originalEvent(id, -2147483648, from, to, tx);
      await conflict(
        employeeOrdersService.transition(
          rollbackActor,
          rollbackOrder.id,
          'complete',
        ),
      );
      const unchanged = await persisted(rollbackOrder.id);
      assert.equal(unchanged.status, 'IN_PROGRESS');
      assert.equal(unchanged.events.length, 1);
    } finally {
      employeeOrdersRepository.event = originalEvent;
    }
    await employeeOrdersService.transition(
      rollbackActor,
      rollbackOrder.id,
      'complete',
    );
    console.info(
      'PASS: real event insertion failures roll back both claim and completion',
    );

    // Hold the first operation's real row lock until the competing transaction
    // reaches that lock. Exercise both commit orders with overlapping snapshots.
    for (const kind of ['transfer', 'deactivate', 'role'] as const) {
      for (const claimFirst of [true, false]) {
        const actor = await employee();
        const targetOrder = await newOrder();
        const originalClaimLock = employeeOrdersRepository.lockEmployee;
        const originalUserLock = usersRepository.lockUser;
        let firstLocked!: () => void;
        let competitorArrived!: () => void;
        const locked = new Promise<void>((resolve) => {
          firstLocked = resolve;
        });
        const arrived = new Promise<void>((resolve) => {
          competitorArrived = resolve;
        });
        let waiting = true;
        const gate = async (first: boolean, acquire: () => Promise<void>) => {
          if (first && waiting) {
            waiting = false;
            await acquire();
            firstLocked();
            await arrived;
          } else {
            competitorArrived();
            await acquire();
          }
        };
        employeeOrdersRepository.lockEmployee = (id, tx) =>
          gate(claimFirst, () => originalClaimLock(id, tx));
        usersRepository.lockUser = (id, tx) =>
          gate(!claimFirst, () => originalUserLock(id, tx));
        const claim = () =>
          employeeOrdersService.transition(actor, targetOrder.id, 'claim');
        const change = () =>
          kind === 'transfer'
            ? usersService.transfer(context, actor.id, fixtures[1].stationId)
            : kind === 'deactivate'
              ? usersService.setStatus(context, actor.id, false)
              : usersService.update(context, actor.id, { role: 'SECURITY' });
        try {
          const first = claimFirst ? claim() : change();
          // Register rejection handling before waiting for the lock barrier.
          const firstOutcome = Promise.allSettled([first]);
          await Promise.race([
            locked,
            first.then(() => {
              throw new Error('Expected lock barrier');
            }),
          ]);
          const second = claimFirst ? change() : claim();
          const secondOutcome = Promise.allSettled([second]);
          const [one, two] = await Promise.all([firstOutcome, secondOutcome]);
          assert.equal(one[0].status, 'fulfilled');
          assert.equal(two[0].status, 'rejected');
          if (two[0].status === 'rejected') {
            assert(two[0].reason instanceof HttpError);
            assert.equal(
              two[0].reason.statusCode,
              claimFirst
                ? 409
                : kind === 'transfer'
                  ? 404
                  : kind === 'deactivate'
                    ? 401
                    : 403,
            );
          }
          const state = await persisted(targetOrder.id);
          const person = await prisma.user.findUniqueOrThrow({
            where: { id: actor.id },
          });
          assert.equal(state.status, claimFirst ? 'IN_PROGRESS' : 'PENDING');
          assert.equal(state.events.length, claimFirst ? 1 : 0);
          assert.equal(state.assignedEmployeeId, claimFirst ? actor.id : null);
          assert.equal(
            person.stationId,
            !claimFirst && kind === 'transfer'
              ? fixtures[1].stationId
              : template.stationId,
          );
          assert.equal(person.isActive, claimFirst || kind !== 'deactivate');
          assert.equal(
            person.roleId,
            !claimFirst && kind === 'role' ? securityRole.id : employeeRole.id,
          );
        } finally {
          competitorArrived();
          employeeOrdersRepository.lockEmployee = originalClaimLock;
          usersRepository.lockUser = originalUserLock;
        }
      }
    }
    console.info(
      'PASS: transfer, deactivation and role change versus claim, in both lock orders',
    );

    for (const claimFirst of [true, false]) {
      // Earlier scenarios intentionally retain claims. Isolate these station
      // races from that history using new marked stations, not data cleanup.
      const station = await prisma.station.create({
        data: {
          name: `Order station race ${run} ${claimFirst}`,
          address: 'ORDER_CONSISTENCY_STATION_RACE',
        },
      });
      const pump = await prisma.pump.create({
        data: { stationId: station.id, number: 1, status: 'IDLE' },
      });
      const actor = await employee(station.id);
      const targetOrder = await newOrder(station.id, pump.id);
      const originalWorkLock = employeeOrdersRepository.lockStation;
      const originalStatusLock = stationsRepository.lockStation;
      let firstLocked!: () => void;
      let competitorArrived!: () => void;
      const locked = new Promise<void>((resolve) => {
        firstLocked = resolve;
      });
      const arrived = new Promise<void>((resolve) => {
        competitorArrived = resolve;
      });
      let waiting = true;
      const gate = async <T>(
        first: boolean,
        acquire: () => Promise<T>,
      ): Promise<T> => {
        if (first && waiting) {
          waiting = false;
          const result = await acquire();
          firstLocked();
          await arrived;
          return result;
        }
        competitorArrived();
        return acquire();
      };
      employeeOrdersRepository.lockStation = (id, tx) =>
        gate(claimFirst, () => originalWorkLock(id, tx));
      stationsRepository.lockStation = (id, tx) =>
        gate(!claimFirst, () => originalStatusLock(id, tx));
      const claim = () =>
        employeeOrdersService.transition(actor, targetOrder.id, 'claim');
      const deactivate = () => stationsService.setStatus(station.id, false);
      try {
        const first = claimFirst ? claim() : deactivate();
        const one = Promise.allSettled([first]);
        await Promise.race([
          locked,
          first.then(() => {
            throw new Error('Expected station lock barrier');
          }),
        ]);
        const two = Promise.allSettled([claimFirst ? deactivate() : claim()]);
        const [firstResults, secondResults] = await Promise.all([one, two]);
        assert.equal(firstResults[0].status, 'fulfilled');
        assert.equal(secondResults[0].status, 'rejected');
        if (secondResults[0].status === 'rejected') {
          assert(secondResults[0].reason instanceof HttpError);
          assert.equal(secondResults[0].reason.statusCode, 409);
        }
        const savedOrder = await persisted(targetOrder.id);
        assert.equal(savedOrder.status, claimFirst ? 'IN_PROGRESS' : 'PENDING');
        assert.equal(
          savedOrder.assignedEmployeeId,
          claimFirst ? actor.id : null,
        );
        assert.equal(savedOrder.events.length, claimFirst ? 1 : 0);
        assert.equal(
          (
            await prisma.station.findUniqueOrThrow({
              where: { id: station.id },
            })
          ).isActive,
          claimFirst,
        );
      } finally {
        competitorArrived();
        employeeOrdersRepository.lockStation = originalWorkLock;
        stationsRepository.lockStation = originalStatusLock;
      }
      if (claimFirst) {
        await conflict(deactivate());
        await employeeOrdersService.transition(
          actor,
          targetOrder.id,
          'complete',
        );
      }
      await deactivate();
      const before = await persisted(targetOrder.id);
      const version = () => prisma.$queryRaw<{ version: string }[]>`
        SELECT xmin::text AS version FROM stations WHERE id = ${station.id}`;
      const inactiveVersion = await version();
      await deactivate();
      assert.deepEqual(await version(), inactiveVersion);
      await stationsService.setStatus(station.id, true);
      const activeVersion = await version();
      await stationsService.setStatus(station.id, true);
      assert.deepEqual(await version(), activeVersion);
      assert.deepEqual(await persisted(targetOrder.id), before);
    }
    console.info(
      'PASS: station deactivation versus claim in both lock orders, completion release, reactivation and repeated status row no-ops',
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(() => {
  console.error(
    'Employee order consistency verification failed or lacks an explicitly authorized disposable target; no development fallback.',
  );
  process.exitCode = 1;
});

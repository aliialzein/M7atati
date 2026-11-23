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
import { ordersDatabasePreflight } from './orders-verification-preflight.js';

// Standalone Task 03 acceptance. Reuses the exact confirmed disposable-target
// guard, but does not invoke Stage 9, create/drop databases, or apply migrations.
async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const mode = process.argv[2] ?? '--preflight';
  assert(
    ['--preflight', '--verify'].includes(mode) && process.argv.length <= 3,
  );
  const protectedUrls = ['.env', 'apps/api/.env'].flatMap((name) => {
    const file = resolve(root, name);
    const value = existsSync(file)
      ? parse(readFileSync(file)).DATABASE_URL
      : undefined;
    return value ? [value] : [];
  });
  const target = ordersVerificationTarget(process.env, protectedUrls);
  if (mode === '--verify') requireOrdersVerificationMutations(process.env);
  const { PrismaPg } = await import('@prisma/adapter-pg');
  const { PrismaClient } = await import('../src/generated/prisma/client.js');
  const database = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: target.url,
      connectionTimeoutMillis: 5000,
      query_timeout: 10000,
    }),
    log: [],
  });
  let disconnect: (() => Promise<void>) | undefined;
  try {
    const history = await ordersDatabasePreflight(
      database,
      target.name,
      resolve(root, 'apps/api/prisma/migrations'),
    );
    const ownership = await database.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        const [table] = await tx.$queryRaw<
          { present: boolean }[]
        >`SELECT to_regclass('public.stations') IS NOT NULL AS present`;
        if (!table.present) return { duplicates: [], ineligible: [] };
        const duplicates = await tx.$queryRaw<
          { manager_id: number; station_ids: number[] }[]
        >`
        SELECT manager_id, array_agg(id ORDER BY id) AS station_ids FROM stations
        WHERE manager_id IS NOT NULL GROUP BY manager_id HAVING count(*) > 1`;
        const ineligible = await tx.$queryRaw<
          { station_id: number; manager_id: number }[]
        >`
        SELECT s.id AS station_id, s.manager_id FROM stations s
        JOIN users u ON u.id=s.manager_id JOIN roles r ON r.id=u.role_id
        WHERE NOT u.is_active OR r.name <> 'MANAGER'`;
        return { duplicates, ineligible };
      },
      { isolationLevel: 'RepeatableRead' },
    );
    console.info(
      JSON.stringify(
        {
          database: target.name,
          applied: history.applied,
          pending: history.pending,
          ownership,
          separateOrderConflicts: history.conflicts,
        },
        null,
        2,
      ),
    );
    assert.equal(
      ownership.duplicates.length,
      0,
      'Explicitly resolve duplicate ownership before migration',
    );
    assert.equal(
      ownership.ineligible.length,
      0,
      'Explicitly review ineligible existing owners',
    );
    if (mode === '--preflight') return;
    assert.equal(
      history.pending.length,
      0,
      'Apply reviewed migrations to this authorized disposable target first',
    );
    const indexes = await database.$queryRaw<
      { indexdef: string }[]
    >`SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='stations_manager_id_key'`;
    assert.equal(indexes.length, 1);
    assert(
      indexes[0].indexdef.includes('UNIQUE') &&
        indexes[0].indexdef.includes('manager_id') &&
        !indexes[0].indexdef.includes('NULLS NOT DISTINCT'),
    );
    const fk = await database.$queryRaw<
      { confdeltype: string }[]
    >`SELECT confdeltype::text AS confdeltype FROM pg_constraint WHERE conrelid='public.stations'::regclass AND conname='stations_manager_id_fkey' AND contype='f'`;
    assert.equal(fk[0]?.confdeltype, 'n', 'Original SET NULL FK must remain');

    // Prove the migration's duplicate guard/rollback using a temporary table
    // that shadows stations only on this independent connection. Persistent
    // stations and retained assignments are never rewritten or removed.
    const { default: pg } = await import('pg');
    const sql = new pg.Client({
      connectionString: target.url,
      connectionTimeoutMillis: 5000,
      query_timeout: 10000,
    });
    try {
      await sql.connect();
      await sql.query(
        'CREATE TEMP TABLE stations (id integer, manager_id integer)',
      );
      await sql.query(
        'INSERT INTO stations VALUES (1,7),(2,7),(3,NULL),(4,NULL)',
      );
      assert.equal(
        (
          await sql.query(
            "SELECT 'stations'::regclass = 'pg_temp.stations'::regclass AS isolated",
          )
        ).rows[0].isolated,
        true,
      );
      const before = (await sql.query('SELECT * FROM stations ORDER BY id'))
        .rows;
      const migration = readFileSync(
        resolve(
          root,
          'apps/api/prisma/migrations/20261123160000_unique_station_manager/migration.sql',
        ),
        'utf8',
      );
      await assert.rejects(
        sql.query(migration),
        /Duplicate station manager ownership exists/,
      );
      await sql.query('ROLLBACK');
      assert.deepEqual(
        (await sql.query('SELECT * FROM stations ORDER BY id')).rows,
        before,
      );
    } finally {
      await sql.end();
    }
    console.info(
      'PASS: unique nullable manager index, preserved FK, duplicate migration refusal without assignment changes',
    );

    process.env.DATABASE_URL = target.url;
    process.env.NODE_ENV = 'test';
    process.env.JWT_ACCESS_SECRET = randomBytes(32).toString('hex');
    process.env.JWT_REFRESH_SECRET = randomBytes(32).toString('hex');
    const { prisma } = await import('../src/database/prisma.js');
    disconnect = () => prisma.$disconnect();
    const { app } = await import('../src/app.js');
    const { env } = await import('../src/config/env.js');
    const { tokenService } =
      await import('../src/modules/auth/token.service.js');
    const { stationsService } =
      await import('../src/modules/stations/stations.service.js');
    const { stationsRepository } =
      await import('../src/modules/stations/stations.repository.js');
    const { usersService } =
      await import('../src/modules/users/users.service.js');
    const { usersRepository } =
      await import('../src/modules/users/users.repository.js');
    const role = async (name: string, keys: string[]) => {
      const result = await prisma.role.upsert({
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
              roleId: result.id,
              permissionId: permission.id,
            },
          },
          update: {},
          create: { roleId: result.id, permissionId: permission.id },
        });
      }
      return result.id;
    };
    const adminRole = await role('ADMIN', ['stations.update', 'users.update']);
    const managerRole = await role('MANAGER', [
      'orders.read',
      'attendance.read',
      'reports.read',
      'payments.manage',
    ]);
    const employeeRole = await role('EMPLOYEE', [
      'orders.update',
      'orders.read',
    ]);
    await role('SECURITY', []);
    const person = (roleId: number) =>
      prisma.user.create({
        data: {
          name: 'Ownership acceptance',
          email: `${randomUUID()}@ownership.invalid`,
          roleId,
          passwordHash: '!No-login-disposable-fixture',
        },
      });
    const admin = await person(adminRole);
    const secondAdmin = await person(adminRole);
    const manager = await person(managerRole);
    const replacement = await person(managerRole);
    const one = await prisma.station.create({
      data: { name: `Ownership ${randomUUID()}` },
    });
    const two = await prisma.station.create({
      data: { name: `Ownership ${randomUUID()}`, isActive: false },
    });
    const three = await prisma.station.create({
      data: { name: `Ownership ${randomUUID()}` },
    });
    assert.equal(
      await prisma.station.count({
        where: { id: { in: [one.id, two.id, three.id] }, managerId: null },
      }),
      3,
      'Multiple persistent stations must allow NULL ownership',
    );
    const api = async (
      method: 'get' | 'patch' | 'post',
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
        `${method} ${path}: unexpected HTTP ${response.status}`,
      );
      return response;
    };
    const assign = (
      id: number,
      managerId: number | null,
      expected: number | readonly number[] = 200,
      actor = admin.id,
    ) =>
      api('patch', `/stations/${id}/manager`, actor, expected, { managerId });
    await assign(one.id, manager.id);
    const before = await prisma.station.findUniqueOrThrow({
      where: { id: one.id },
    });
    const version = () =>
      prisma.$queryRaw<
        { version: string }[]
      >`SELECT xmin::text AS version FROM stations WHERE id=${one.id}`;
    const originalVersion = await version();
    await assign(one.id, manager.id);
    assert.deepEqual(await version(), originalVersion);
    await assign(two.id, manager.id, 409);
    assert.deepEqual(
      await prisma.station.findUniqueOrThrow({ where: { id: one.id } }),
      before,
    );
    await assign(three.id, replacement.id, 403, manager.id);
    const bad = await person(employeeRole);
    await assign(three.id, bad.id, 409);
    const inactive = await person(managerRole);
    await prisma.user.update({
      where: { id: inactive.id },
      data: { isActive: false },
    });
    await assign(three.id, inactive.id, 409);
    const sessions = tokenService.issue(manager.id);
    await prisma.refreshSession.create({
      data: {
        id: sessions.sessionId,
        userId: manager.id,
        tokenHash: sessions.tokenHash,
        expiresAt: sessions.expiresAt,
      },
    });
    const managerBefore = await prisma.user.findUniqueOrThrow({
      where: { id: manager.id },
    });
    await api('patch', `/users/${manager.id}/status`, admin.id, 409, {
      isActive: false,
    });
    await api('patch', `/users/${manager.id}`, admin.id, 409, {
      role: 'SECURITY',
      stationId: one.id,
    });
    assert.deepEqual(
      await prisma.user.findUniqueOrThrow({ where: { id: manager.id } }),
      managerBefore,
    );
    assert.equal(
      (
        await prisma.refreshSession.findUniqueOrThrow({
          where: { id: sessions.sessionId },
        })
      ).revokedAt,
      null,
    );
    await assign(one.id, replacement.id);
    assert.deepEqual(
      (await api('get', '/stations/managed', manager.id, 200)).body.stations,
      [],
    );
    assert.equal(
      (await api('get', '/stations/managed', replacement.id, 200)).body
        .stations[0].id,
      one.id,
    );
    const fuel = await prisma.fuelType.create({
      data: { code: `OWNERSHIP_${randomUUID()}`, name: 'Ownership test fuel' },
    });
    const pump = await prisma.pump.create({
      data: { stationId: one.id, number: 1, status: 'IDLE' },
    });
    const order = await prisma.fuelOrder.create({
      data: {
        stationId: one.id,
        fuelTypeId: fuel.id,
        source: 'OWNERSHIP_TEST',
        status: 'AWAITING_PAYMENT',
        currency: 'USD',
        unitPriceMinor: 100,
        orderedVolume: '1',
        orderedAmountMinor: 100,
      },
    });
    for (const suffix of [
      'orders',
      `orders/${order.id}`,
      'analytics',
      'attendance',
      'attendance/export?format=csv',
      'attendance/export?format=pdf',
    ]) {
      await api(
        'get',
        `/manager/stations/${one.id}/${suffix}`,
        manager.id,
        404,
      );
      await api(
        'get',
        `/manager/stations/${one.id}/${suffix}`,
        replacement.id,
        200,
      );
    }
    const cash = `/manager/stations/${one.id}/orders/${order.id}/confirm-cash`;
    await api('post', cash, manager.id, 404, {
      amountMinor: 100,
      currency: 'USD',
      pumpId: pump.id,
    });
    await api('post', cash, replacement.id, 201, {
      amountMinor: 100,
      currency: 'USD',
      pumpId: pump.id,
    });
    const worker = await person(employeeRole);
    await prisma.user.update({
      where: { id: worker.id },
      data: { stationId: one.id },
    });
    for (const action of ['claim', 'complete'])
      await api(
        'post',
        `/employee/orders/${order.id}/${action}`,
        worker.id,
        200,
        {},
      );
    await api('patch', `/stations/${one.id}/status`, admin.id, 200, {
      isActive: false,
    });
    assert.equal(
      (await prisma.station.findUniqueOrThrow({ where: { id: one.id } }))
        .managerId,
      replacement.id,
    );
    await api(
      'get',
      `/manager/stations/${one.id}/analytics`,
      replacement.id,
      200,
    );
    await assign(two.id, manager.id);
    assert.equal(
      (await prisma.station.findUniqueOrThrow({ where: { id: two.id } }))
        .isActive,
      false,
    );
    assert.equal(
      (await prisma.user.findUniqueOrThrow({ where: { id: manager.id } }))
        .stationId,
      null,
    );
    await assign(two.id, null);
    await api('patch', `/users/${manager.id}/status`, admin.id, 200, {
      isActive: false,
    });
    console.info(
      'PASS: assignment/reassignment/unassignment, lifecycle, unchanged affiliation, inactive stations, immediate access revocation across manager routes',
    );

    const contested = await person(managerRole);
    const raceStations = await Promise.all(
      [1, 2].map(() =>
        prisma.station.create({
          data: { name: `Ownership race ${randomUUID()}` },
        }),
      ),
    );
    const results = await Promise.all(
      raceStations.map((station, i) =>
        assign(
          station.id,
          contested.id,
          [200, 409],
          i ? secondAdmin.id : admin.id,
        ),
      ),
    );
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
    const count = await prisma.station.count({
      where: { managerId: contested.id },
    });
    assert.equal(count, 1);
    const owned = await prisma.station.findFirstOrThrow({
      where: { managerId: contested.id },
    });
    const other = raceStations.find((station) => station.id !== owned.id)!;
    await assert.rejects(
      prisma.station.update({
        where: { id: other.id },
        data: { managerId: contested.id },
      }),
      (error: unknown) => (error as { code: string }).code === 'P2002',
    );
    assert.equal(
      (await prisma.station.findUniqueOrThrow({ where: { id: other.id } }))
        .managerId,
      null,
    );
    console.info(
      'PASS: concurrent administrators leave one owner; direct duplicate SQL/Prisma assignment is rejected by the database',
    );
    const context = {
      user: {
        id: admin.id,
        name: admin.name,
        email: admin.email,
        role: 'ADMIN',
        stationId: null,
      },
      permissions: ['stations.update', 'users.update'],
    };
    for (const operation of ['deactivate', 'role'] as const) {
      for (const assignmentFirst of [true, false]) {
        console.info(
          `RUN: assignment versus ${operation}, ${assignmentFirst ? 'assignment' : 'lifecycle'} lock first`,
        );
        const candidate = await person(managerRole);
        const station = await prisma.station.create({
          data: { name: `Ownership lifecycle ${randomUUID()}` },
        });
        const assignmentLock = stationsRepository.lockManager;
        const lifecycleLock = usersRepository.lockUser;
        let held!: () => void;
        let arrived!: () => void;
        const locked = new Promise<void>((resolve) => {
          held = resolve;
        });
        const competitor = new Promise<void>((resolve) => {
          arrived = resolve;
        });
        let waiting = true;
        const gate = async (first: boolean, acquire: () => Promise<void>) => {
          if (first && waiting) {
            waiting = false;
            await acquire();
            held();
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                competitor,
                new Promise<never>((_, reject) => {
                  timer = setTimeout(
                    () =>
                      reject(
                        new Error('Ownership lifecycle barrier timed out'),
                      ),
                    2000,
                  );
                }),
              ]);
            } finally {
              clearTimeout(timer);
            }
          } else {
            arrived();
            await acquire();
          }
        };
        stationsRepository.lockManager = (id, tx) =>
          id === candidate.id
            ? gate(assignmentFirst, () => assignmentLock(id, tx))
            : assignmentLock(id, tx);
        usersRepository.lockUser = (id, tx) =>
          id === candidate.id
            ? gate(!assignmentFirst, () => lifecycleLock(id, tx))
            : lifecycleLock(id, tx);
        const assignment = () =>
          stationsService.setManager(context, station.id, candidate.id);
        const change = () =>
          operation === 'deactivate'
            ? usersService.setStatus(context, candidate.id, false)
            : usersService.update(context, candidate.id, {
                role: 'SECURITY',
                stationId: station.id,
              });
        try {
          const first = assignmentFirst ? assignment() : change();
          const firstResult = Promise.allSettled([first]);
          await Promise.race([
            locked,
            first.then(() => {
              throw new Error('Expected ownership user lock');
            }),
          ]);
          const secondResult = Promise.allSettled([
            assignmentFirst ? change() : assignment(),
          ]);
          const [one, two] = await Promise.all([firstResult, secondResult]);
          console.info(
            JSON.stringify({
              first: one[0].status,
              second: two[0].status,
              firstErrorCode:
                one[0].status === 'rejected' ? one[0].reason.code : undefined,
              secondStatus:
                two[0].status === 'rejected'
                  ? two[0].reason.statusCode
                  : undefined,
              secondErrorCode:
                two[0].status === 'rejected' ? two[0].reason.code : undefined,
              secondSqlState:
                two[0].status === 'rejected'
                  ? (two[0].reason.meta?.code ??
                    two[0].reason.meta?.driverAdapterError?.cause?.originalCode)
                  : undefined,
            }),
          );
          assert.equal(one[0].status, 'fulfilled');
          assert(two[0].status === 'rejected');
          assert.equal(two[0].reason.statusCode, 409);
        } finally {
          arrived();
          stationsRepository.lockManager = assignmentLock;
          usersRepository.lockUser = lifecycleLock;
        }
        const saved = await prisma.station.findUniqueOrThrow({
          where: { id: station.id },
        });
        const owner = await prisma.user.findUniqueOrThrow({
          where: { id: candidate.id },
          include: { role: true },
        });
        assert.equal(saved.managerId, assignmentFirst ? candidate.id : null);
        if (saved.managerId !== null) {
          assert(owner.isActive);
          assert.equal(owner.role.name, 'MANAGER');
        } else if (operation === 'deactivate')
          assert.equal(owner.isActive, false);
        else assert.equal(owner.role.name, 'SECURITY');
        console.info(
          `PASS: ${operation}, ${assignmentFirst ? 'assignment' : 'lifecycle'} first; owner=${saved.managerId === null ? 'none' : 'candidate'}, active=${owner.isActive}, role=${owner.role.name}`,
        );
      }
    }
    console.info(
      'PASS: manager assignment versus deactivation/role exit in both real user-lock commit orders; fixtures retained',
    );
  } finally {
    await disconnect?.();
    await database.$disconnect();
  }
}

main().catch(() => {
  console.error(
    'Manager ownership verification stopped; inspect the last phase and confirmed disposable target. No Stage 9 invocation, database reset, deletion or automatic data repair.',
  );
  process.exitCode = 1;
});

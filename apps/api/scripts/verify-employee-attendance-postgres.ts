import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import type { AuthContext } from '../src/modules/auth/auth.types.js';

// Opt-in only. No fallback to DATABASE_URL, no database creation, no development
// target, no general seed/provisioning. Requires an EMPTY dedicated database.
async function main() {
  const target = process.env.EMPLOYEE_ATTENDANCE_TEST_DATABASE_URL;
  assert(
    target,
    'Set EMPLOYEE_ATTENDANCE_TEST_DATABASE_URL to an authorized empty disposable database',
  );
  assert.equal(
    process.env.ALLOW_EMPLOYEE_ATTENDANCE_TEST_WRITES,
    'yes',
    'Explicit disposable-write authorization required',
  );
  const url = new URL(target);
  assert(
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
    'Local disposable database required',
  );
  const name = decodeURIComponent(url.pathname.slice(1));
  assert(
    /^m7atati_employee_verify_[a-z0-9_]+$/.test(name),
    'Disposable database name required',
  );
  assert(
    !url.searchParams.has('schema') ||
      url.searchParams.get('schema') === 'public',
  );
  const sql = new pg.Client({
    connectionString: target,
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
  });
  let disconnect: (() => Promise<void>) | undefined;
  await sql.connect();
  try {
    assert.equal(
      (await sql.query('SELECT current_database() AS name')).rows[0].name,
      name,
    );
    assert.equal(
      (
        await sql.query(
          "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'",
        )
      ).rows[0].n,
      0,
      'Disposable database must be empty',
    );
    const root = 'apps/api/prisma/migrations';
    const migration = '20261121130000_employee_attendance';
    const names = readdirSync(root)
      .filter((entry) => /^\d/.test(entry))
      .sort();
    assert.equal(
      names.at(-1),
      migration,
      'Review verifier before using with later migrations',
    );
    for (const entry of names.filter((entry) => entry !== migration))
      await sql.query(readFileSync(join(root, entry, 'migration.sql'), 'utf8'));
    const employeeRole = (
      await sql.query(
        "INSERT INTO roles(name) VALUES ('EMPLOYEE') RETURNING id",
      )
    ).rows[0].id;
    const hrRole = (
      await sql.query("INSERT INTO roles(name) VALUES ('HR') RETURNING id")
    ).rows[0].id;
    const stationA = (
      await sql.query(
        "INSERT INTO stations(name) VALUES ('Disposable A') RETURNING id",
      )
    ).rows[0].id;
    const stationB = (
      await sql.query(
        "INSERT INTO stations(name) VALUES ('Disposable B') RETURNING id",
      )
    ).rows[0].id;
    const legacy = (
      await sql.query(
        "INSERT INTO users(name,email,password_hash,role_id,station_id,updated_at) VALUES ('Legacy test','legacy@employee.invalid','unusable',$1,$2,CURRENT_TIMESTAMP) RETURNING id",
        [employeeRole, stationA],
      )
    ).rows[0].id;
    const inserted = await sql.query(
      "INSERT INTO attendance_records(employee_id,station_id,clock_in_at) VALUES ($1,$2,'2026-01-01T00:00:00Z'),($1,$2,'2026-01-02T00:00:00Z') RETURNING id",
      [legacy, stationA],
    );
    const before = (
      await sql.query('SELECT * FROM attendance_records ORDER BY id')
    ).rows;
    const migrationSql = readFileSync(
      join(root, migration, 'migration.sql'),
      'utf8',
    );
    await assert.rejects(sql.query(migrationSql), /Duplicate open attendance/);
    await sql.query('ROLLBACK');
    assert.deepEqual(
      (await sql.query('SELECT * FROM attendance_records ORDER BY id')).rows,
      before,
    );
    assert.equal(
      (
        await sql.query(
          "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='attendance_records' AND column_name='check_in_request_id'",
        )
      ).rows[0].n,
      0,
    );
    console.info(
      'PASS: duplicate preflight failure leaves legacy rows and schema unchanged',
    );
    // Remove only the duplicate manufactured above in this initially empty DB.
    await sql.query('DELETE FROM attendance_records WHERE id=$1', [
      inserted.rows[1].id,
    ]);
    await sql.query(migrationSql);
    const index = (
      await sql.query(
        "SELECT indexdef FROM pg_indexes WHERE indexname='attendance_one_open_per_employee'",
      )
    ).rows[0].indexdef as string;
    assert(index.includes('UNIQUE') && index.includes('clock_out_at IS NULL'));
    await assert.rejects(
      sql.query(
        'INSERT INTO attendance_records(employee_id,station_id,clock_in_at) VALUES ($1,$2,CURRENT_TIMESTAMP)',
        [legacy, stationA],
      ),
      (error: unknown) => (error as { code: string }).code === '23505',
    );
    process.env.DATABASE_URL = target;
    process.env.NODE_ENV = 'test';
    process.env.JWT_ACCESS_SECRET = randomBytes(32).toString('hex');
    process.env.JWT_REFRESH_SECRET = randomBytes(32).toString('hex');
    const { prisma } = await import('../src/database/prisma.js');
    disconnect = () => prisma.$disconnect();
    const { EmployeeAttendanceService } =
      await import('../src/modules/attendance/attendance.service.js');
    const { employeeAttendanceRepository: attendanceRepository } =
      await import('../src/modules/attendance/attendance.repository.js');
    const { UsersService } =
      await import('../src/modules/users/users.service.js');
    const { usersRepository } =
      await import('../src/modules/users/users.repository.js');
    let sequence = 0;
    const employee = async (
      roleId = employeeRole,
      assigned: number | null = stationA,
    ) => {
      return prisma.user.create({
        data: {
          name: 'Disposable user',
          email: `fixture-${++sequence}@employee.invalid`,
          passwordHash: 'unusable',
          roleId,
          stationId: assigned,
        },
      });
    };
    const context = (id: number, role = 'EMPLOYEE'): AuthContext => {
      return {
        user: {
          id,
          role,
          name: 'Disposable',
          email: 'test@employee.invalid',
          stationId: stationA,
        },
        permissions: [
          'attendance.read',
          'attendance.self.write',
          'employees.transfer',
        ],
      };
    };
    const gate = () => {
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      let arrivals = 0;
      return async () => {
        if (++arrivals === 2) release();
        await ready;
      };
    };
    // Force both Serializable transactions to observe no open record initially.
    for (const sameKey of [true, false]) {
      const person = await employee();
      const rendezvous = gate();
      let reads = 0;
      const repository = {
        ...attendanceRepository,
        async open(
          id: number,
          tx: Parameters<typeof attendanceRepository.open>[1],
        ) {
          const result = await attendanceRepository.open(id, tx);
          if (++reads <= 2) await rendezvous();
          return result;
        },
      };
      const service = new EmployeeAttendanceService(repository);
      const key = randomUUID();
      const outcomes = await Promise.allSettled([
        service.checkIn(context(person.id), key),
        service.checkIn(context(person.id), sameKey ? key : randomUUID()),
      ]);
      assert.equal(
        await prisma.attendanceRecord.count({
          where: { employeeId: person.id, clockOutAt: null },
        }),
        1,
      );
      if (sameKey) {
        assert(outcomes.every((outcome) => outcome.status === 'fulfilled'));
      } else {
        assert.equal(
          outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
          1,
        );
        const rejected = outcomes.find(
          (outcome) => outcome.status === 'rejected',
        );
        assert(
          rejected?.status === 'rejected' && rejected.reason.statusCode === 409,
        );
      }
    }
    console.info(
      'PASS: concurrent same-key retries resolve; different keys leave exactly one open record',
    );
    const service = new EmployeeAttendanceService();
    const person = await employee();
    const key = randomUUID();
    const first = await service.checkIn(context(person.id), key);
    const closed = await service.checkOut(context(person.id), first.record.id);
    await service.checkIn(context(person.id), randomUUID());
    assert.deepEqual(await service.checkIn(context(person.id), key), closed);
    assert.deepEqual(
      await service.checkOut(context(person.id), first.record.id),
      closed,
    );
    const secondEmployee = await employee();
    await service.checkIn(context(secondEmployee.id), key); // Employee-scoped UUID.
    console.info(
      'PASS: closed same-key retry, scoped UUID, and delayed check-out preserve newer attendance',
    );
    const hr = await employee(hrRole, null);
    for (const transferWins of [true, false]) {
      const person = await employee();
      const rendezvous = gate();
      let releaseWinner!: () => void;
      const winnerCommitted = new Promise<void>((resolve) => {
        releaseWinner = resolve;
      });
      let attendanceRead = false;
      let targetRead = false;
      const attendance = new EmployeeAttendanceService({
        ...attendanceRepository,
        async employee(id, tx) {
          const result = await attendanceRepository.employee(id, tx);
          if (!attendanceRead) {
            attendanceRead = true;
            await rendezvous();
          }
          return result;
        },
        async create(id, stationId, requestId, tx) {
          if (transferWins) await winnerCommitted;
          return attendanceRepository.create(id, stationId, requestId, tx);
        },
      });
      const users = new UsersService({
        ...usersRepository,
        async findUser(id, scope, tx) {
          const result = await usersRepository.findUser(id, scope, tx);
          if (id === person.id && !targetRead) {
            targetRead = true;
            await rendezvous();
          }
          return result;
        },
        async update(id, data, tx) {
          if (!transferWins) await winnerCommitted;
          return usersRepository.update(id, data, tx);
        },
      });
      const checkedIn = attendance.checkIn(context(person.id), randomUUID());
      const transferred = users.transfer(
        context(hr.id, 'HR'),
        person.id,
        stationB,
      );
      // Release the losing transaction after the winning transaction commits.
      void (transferWins ? transferred : checkedIn).then(
        releaseWinner,
        releaseWinner,
      );
      const outcomes = await Promise.allSettled([checkedIn, transferred]);
      assert.equal(outcomes[0].status, 'fulfilled');
      assert.equal(outcomes[1].status, transferWins ? 'fulfilled' : 'rejected');
      const assigned = await prisma.user.findUniqueOrThrow({
        where: { id: person.id },
      });
      const open = await prisma.attendanceRecord.findFirstOrThrow({
        where: { employeeId: person.id, clockOutAt: null },
      });
      assert.equal(open.stationId, assigned.stationId);
      assert.equal(assigned.stationId, transferWins ? stationB : stationA);
    }
    console.info(
      'PASS: both transfer/check-in commit orders preserve current assignment or reject transfer',
    );
  } finally {
    await disconnect?.();
    await sql.end();
  }
}
main().catch(() => {
  console.error(
    'Disposable employee attendance verification failed or is not configured; no development fallback is used',
  );
  process.exitCode = 1;
});

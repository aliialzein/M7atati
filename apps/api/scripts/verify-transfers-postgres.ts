import assert from 'node:assert/strict';
import type pg from 'pg';
import request from 'supertest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { provisionTransferPermissions } from './transfer-permissions.js';
import { provisionAttendancePermissions } from './attendance-permissions.js';

// Only the existing disposable PostgreSQL runner invokes this with --transfers.
export async function verifyTransfersPostgres(
  prisma: PrismaClient,
  sql: pg.Client,
) {
  assert(
    /^m7atati_stage1_verify_[a-f0-9]{16}$/.test(
      (await sql.query('SELECT current_database() AS name')).rows[0].name,
    ),
  );
  const { app } = await import('../src/app.js');
  const { tokenService } = await import('../src/modules/auth/token.service.js');
  const { ACCESS_COOKIE, REFRESH_COOKIE } =
    await import('../src/modules/auth/auth.types.js');
  const { UsersService } =
    await import('../src/modules/users/users.service.js');
  const { usersRepository } =
    await import('../src/modules/users/users.repository.js');
  const hrRole = await prisma.role.create({ data: { name: 'HR' } });
  const employeeRole = await prisma.role.findUniqueOrThrow({
    where: { name: 'EMPLOYEE' },
  });
  const admin = await prisma.user.findFirstOrThrow({
    where: { role: { name: 'ADMIN' } },
  });
  const hr = await prisma.user.create({
    data: {
      name: 'TEST HR transfer',
      email: 'hr@stage3.invalid',
      roleId: hrRole.id,
      passwordHash: 'test-only-unusable-hash',
    },
  });
  const originalGrants = await prisma.rolePermission.findMany();
  await provisionTransferPermissions(prisma);
  await provisionTransferPermissions(prisma);
  const grants = await prisma.rolePermission.findMany();
  assert.equal(grants.length, originalGrants.length + 2);
  for (const grant of originalGrants)
    assert(
      grants.some(
        (row) =>
          row.roleId === grant.roleId &&
          row.permissionId === grant.permissionId,
      ),
    );
  await provisionAttendancePermissions(prisma);
  const updatePermission = await prisma.permission.upsert({
    where: { key: 'users.update' },
    update: {},
    create: { key: 'users.update' },
  });
  await prisma.rolePermission.createMany({
    data: [admin.roleId, hrRole.id].map((roleId) => ({
      roleId,
      permissionId: updatePermission.id,
    })),
    skipDuplicates: true,
  });
  const stationA = await prisma.station.create({
    data: { name: 'TEST inactive source A', isActive: false },
  });
  const stationB = await prisma.station.create({
    data: { name: 'TEST destination B' },
  });
  const stationC = await prisma.station.create({
    data: { name: 'TEST destination C' },
  });
  const employee = (label: string) =>
    prisma.user.create({
      data: {
        name: `TEST ${label}`,
        email: `${label}@stage3.invalid`,
        roleId: employeeRole.id,
        stationId: stationA.id,
        passwordHash: 'test-only-unusable-hash',
      },
    });
  async function send(
    method: 'get' | 'post' | 'patch',
    path: string,
    status: number,
    body?: object,
    actorId = hr.id,
  ) {
    const client = request(app);
    const response = await client[method](path)
      .set(
        'Cookie',
        `${ACCESS_COOKIE}=${tokenService.issue(actorId).accessToken}`,
      )
      .set('Origin', 'http://localhost:3000')
      .set('X-CSRF-Protection', '1')
      .send(body);
    assert.equal(response.status, status);
    assert(!/password|token|roleId/.test(JSON.stringify(response.body)));
    return response.body;
  }
  for (const actorId of [hr.id, admin.id]) {
    const person = await employee(`success-${actorId}`);
    const tokens = tokenService.issue(person.id);
    await prisma.refreshSession.create({
      data: {
        id: tokens.sessionId,
        userId: person.id,
        tokenHash: tokens.tokenHash,
        expiresAt: tokens.expiresAt,
      },
    });
    const shift = await prisma.shift.create({
      data: {
        employeeId: person.id,
        stationId: stationA.id,
        startsAt: new Date('2020-01-01T08:00:00Z'),
        endsAt: new Date('2020-01-01T16:00:00Z'),
      },
    });
    const attendance = await prisma.attendanceRecord.create({
      data: {
        employeeId: person.id,
        stationId: stationA.id,
        clockInAt: new Date('2020-01-01T08:01:00Z'),
        clockOutAt: new Date('2020-01-01T16:02:00Z'),
      },
    });
    const body = await send(
      'post',
      `/api/users/${person.id}/transfer`,
      200,
      { stationId: stationB.id },
      actorId,
    );
    assert.equal(body.user.stationId, stationB.id);
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: person.id },
    });
    assert.deepEqual(
      { ...after, stationId: person.stationId, updatedAt: person.updatedAt },
      person,
    );
    assert(
      (
        await prisma.refreshSession.findUniqueOrThrow({
          where: { id: tokens.sessionId },
        })
      ).revokedAt,
    );
    const me = await request(app)
      .get('/api/auth/me')
      .set('Cookie', `${ACCESS_COOKIE}=${tokens.accessToken}`);
    assert.equal(me.status, 200);
    assert.equal(me.body.user.stationId, stationB.id);
    const refreshed = await request(app)
      .post('/api/auth/refresh')
      .set('Origin', 'http://localhost:3000')
      .set('X-CSRF-Protection', '1')
      .set('Cookie', `${REFRESH_COOKIE}=${tokens.refreshToken}`);
    assert.equal(refreshed.status, 401);
    assert.deepEqual(
      await prisma.shift.findUniqueOrThrow({ where: { id: shift.id } }),
      shift,
    );
    assert.deepEqual(
      await prisma.attendanceRecord.findUniqueOrThrow({
        where: { id: attendance.id },
      }),
      attendance,
    );
    for (const path of ['shifts', 'attendance']) {
      const atA = await send(
        'get',
        `/api/${path}?stationId=${stationA.id}&employeeId=${person.id}`,
        200,
      );
      const atB = await send(
        'get',
        `/api/${path}?stationId=${stationB.id}&employeeId=${person.id}`,
        200,
      );
      assert.equal(atA.pagination.total, 1);
      assert.equal(atB.pagination.total, 0);
    }
  }
  console.info(
    'PASS: HR/ADMIN transfer, credentials/identity/history retention, new auth station and revoked refresh',
  );

  const blocked = await employee('blocked');
  const open = await prisma.attendanceRecord.create({
    data: {
      employeeId: blocked.id,
      stationId: stationA.id,
      clockInAt: new Date(),
      clockOutAt: null,
    },
  });
  const rowVersion = async () =>
    (
      await sql.query('SELECT xmin::text AS version FROM users WHERE id=$1', [
        blocked.id,
      ])
    ).rows;
  const before = await rowVersion();
  await send('post', `/api/users/${blocked.id}/transfer`, 200, {
    stationId: stationA.id,
  });
  assert.deepEqual(await rowVersion(), before);
  await send('post', `/api/users/${blocked.id}/transfer`, 409, {
    stationId: stationB.id,
  });
  for (const body of [
    { stationId: stationB.id },
    { stationId: stationB.id, role: 'SECURITY' },
    { stationId: null, role: 'HR' },
  ])
    await send('patch', `/api/users/${blocked.id}`, 409, body, admin.id);
  await send('patch', `/api/users/${blocked.id}`, 403, {
    stationId: stationB.id,
  });
  await send('patch', `/api/users/${blocked.id}/status`, 403, {
    isActive: false,
  });
  await prisma.attendanceRecord.update({
    where: { id: open.id },
    data: { clockOutAt: new Date() },
  });
  for (const future of [false, true]) {
    const now = Date.now();
    const shift = await prisma.shift.create({
      data: {
        employeeId: blocked.id,
        stationId: stationA.id,
        startsAt: new Date(now + (future ? 60000 : -60000)),
        endsAt: new Date(now + 120000),
      },
    });
    await send('post', `/api/users/${blocked.id}/transfer`, 409, {
      stationId: stationB.id,
    });
    await prisma.shift.delete({ where: { id: shift.id } });
  }
  const boundary = new Date(Date.now());
  await prisma.shift.create({
    data: {
      employeeId: blocked.id,
      stationId: stationA.id,
      startsAt: new Date(boundary.getTime() - 60000),
      endsAt: boundary,
    },
  });
  const originalNow = Date.now;
  Date.now = () => boundary.getTime();
  try {
    await send('post', `/api/users/${blocked.id}/transfer`, 200, {
      stationId: stationB.id,
    });
  } finally {
    Date.now = originalNow;
  }
  console.info(
    'PASS: same-station row no-op, open/ongoing/future conflicts, combined-role update guards and exact shift-end boundary',
  );

  const rollback = await employee('rollback');
  const rollbackTokens = tokenService.issue(rollback.id);
  await prisma.refreshSession.create({
    data: {
      id: rollbackTokens.sessionId,
      userId: rollback.id,
      tokenHash: rollbackTokens.tokenHash,
      expiresAt: rollbackTokens.expiresAt,
    },
  });
  await sql.query(
    "CREATE FUNCTION stage3_reject_revocation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Test revocation failure'; END $$",
  );
  await sql.query(
    'CREATE TRIGGER stage3_reject_revocation BEFORE UPDATE ON refresh_sessions FOR EACH ROW EXECUTE FUNCTION stage3_reject_revocation()',
  );
  try {
    for (const method of ['post', 'patch'] as const) {
      await send(
        method,
        `/api/users/${rollback.id}${method === 'post' ? '/transfer' : ''}`,
        500,
        { stationId: stationB.id },
        method === 'post' ? hr.id : admin.id,
      );
      assert.deepEqual(
        await prisma.user.findUniqueOrThrow({ where: { id: rollback.id } }),
        rollback,
      );
      assert.equal(
        (
          await prisma.refreshSession.findUniqueOrThrow({
            where: { id: rollbackTokens.sessionId },
          })
        ).revokedAt,
        null,
      );
    }
  } finally {
    await sql.query(
      'DROP TRIGGER stage3_reject_revocation ON refresh_sessions',
    );
    await sql.query('DROP FUNCTION stage3_reject_revocation()');
  }
  console.info(
    'PASS: real revocation failure rolls back assignment/session changes through both endpoints',
  );

  // Force two Serializable transactions to read source A. The C transfer waits
  // for the B commit, then must retry and discover B's blocking future shift.
  const race = await employee('race');
  const now = Date.now();
  await prisma.shift.create({
    data: {
      employeeId: race.id,
      stationId: stationB.id,
      startsAt: new Date(now + 3600000),
      endsAt: new Date(now + 7200000),
    },
  });
  let arrivals = 0;
  let releaseReads!: () => void;
  let releaseCommit!: () => void;
  const readsReady = new Promise<void>((resolve) => {
    releaseReads = resolve;
  });
  const committed = new Promise<void>((resolve) => {
    releaseCommit = resolve;
  });
  let secondTargetReads = 0;
  let secondLockAttempts = 0;
  function raceRepository(second: boolean): typeof usersRepository {
    let firstLock = true;
    return {
      ...usersRepository,
      async lockUser(id, tx) {
        if (id === race.id) {
          if (second) secondLockAttempts++;
          if (firstLock) {
            firstLock = false;
            // Both transaction snapshots exist before either target lock.
            // Waiting after locking would deadlock the test barrier itself.
            if (++arrivals === 2) releaseReads();
            await readsReady;
            if (second) await committed;
          }
        }
        return usersRepository.lockUser(id, tx);
      },
      async findUser(id, scope, tx) {
        const result = await usersRepository.findUser(id, scope, tx);
        if (id === race.id) {
          if (second) secondTargetReads++;
        }
        return result;
      },
      async update(id, data, tx) {
        if (second) await committed;
        return usersRepository.update(id, data, tx);
      },
    };
  }
  const context = {
    user: {
      id: hr.id,
      name: hr.name,
      email: hr.email,
      role: 'HR',
      stationId: null,
    },
    permissions: ['employees.transfer'],
  };
  const first = new UsersService(raceRepository(false))
    .transfer(context, race.id, stationB.id)
    .then(
      (value) => {
        releaseCommit();
        return value;
      },
      (error: unknown) => {
        releaseCommit();
        throw error;
      },
    );
  const second = new UsersService(raceRepository(true)).transfer(
    context,
    race.id,
    stationC.id,
  );
  const outcomes = await Promise.allSettled([first, second]);
  assert.equal(outcomes[0].status, 'fulfilled');
  assert.equal(outcomes[1].status, 'rejected');
  if (outcomes[1].status === 'rejected')
    assert.equal(outcomes[1].reason.statusCode, 409);
  assert(
    secondLockAttempts >= 2,
    'Serialization retry must acquire the target lock again',
  );
  assert(
    secondTargetReads >= 1,
    'Retried transaction must read the current target',
  );
  assert.equal(
    (await prisma.user.findUniqueOrThrow({ where: { id: race.id } })).stationId,
    stationB.id,
  );
  console.info(
    'PASS: concurrent real Serializable transfers retry and recheck the newly committed source station',
  );
}

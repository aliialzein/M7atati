import assert from 'node:assert/strict';
import type pg from 'pg';
import request from 'supertest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { provisionAttendancePermissions } from './attendance-permissions.js';
import { workRecordFixtures } from '../tests/fixtures/attendance.js';

// Invoked only by the existing disposable database runner with --attendance.
export async function verifyAttendancePostgres(
  prisma: PrismaClient,
  sql: pg.Client,
) {
  const database = await sql.query('SELECT current_database() AS name');
  assert(/^m7atati_stage1_verify_[a-f0-9]{16}$/.test(database.rows[0].name));
  const { app } = await import('../src/app.js');
  const { tokenService } = await import('../src/modules/auth/token.service.js');
  const { ACCESS_COOKIE } = await import('../src/modules/auth/auth.types.js');
  const hr = await prisma.role.create({ data: { name: 'HR' } });
  const admin = await prisma.role.findUniqueOrThrow({
    where: { name: 'ADMIN' },
  });
  const originalGrants = await prisma.rolePermission.findMany();
  await provisionAttendancePermissions(prisma);
  const once = await prisma.rolePermission.findMany({
    orderBy: [{ roleId: 'asc' }, { permissionId: 'asc' }],
  });
  await provisionAttendancePermissions(prisma);
  assert.deepEqual(
    await prisma.rolePermission.findMany({
      orderBy: [{ roleId: 'asc' }, { permissionId: 'asc' }],
    }),
    once,
  );
  for (const grant of originalGrants)
    assert(
      once.some(
        (item) =>
          item.roleId === grant.roleId &&
          item.permissionId === grant.permissionId,
      ),
    );
  assert.equal(once.length, originalGrants.length + 5);
  console.info(
    'PASS: targeted read provisioning twice preserves all unrelated grants',
  );

  const reader = await prisma.user.create({
    data: {
      name: 'HR test reader',
      email: 'hr-attendance@stage2.invalid',
      passwordHash: 'test-only-unusable-hash',
      roleId: hr.id,
    },
  });
  const adminReader = await prisma.user.findFirstOrThrow({
    where: { roleId: admin.id },
  });
  async function get(
    path: string,
    query: Record<string, string | number> = {},
    userId = reader.id,
    status = 200,
  ) {
    const response = await request(app)
      .get(`/api/${path}`)
      .query(query)
      .set(
        'Cookie',
        `${ACCESS_COOKIE}=${tokenService.issue(userId).accessToken}`,
      );
    assert.equal(response.status, status);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert(!/password|token|email|roleId/.test(JSON.stringify(response.body)));
    return response.body;
  }
  for (const path of ['shifts', 'attendance']) {
    const body = await get(path);
    assert.deepEqual(body[path], []);
    assert.deepEqual(body.pagination, {
      page: 1,
      limit: 20,
      total: 0,
      totalPages: 0,
    });
  }
  const columns = await sql.query(
    "SELECT data_type FROM information_schema.columns WHERE table_name IN ('shifts','attendance_records') AND column_name IN ('starts_at','ends_at','clock_in_at','clock_out_at','created_at')",
  );
  assert.equal(columns.rows.length, 6);
  assert(
    columns.rows.every((row) => row.data_type === 'timestamp with time zone'),
  );
  const stationA = await prisma.station.create({
    data: { name: 'TEST historical station A', isActive: false },
  });
  const stationB = await prisma.station.create({
    data: { name: 'TEST current station B' },
  });
  const employeeRole = await prisma.role.findUniqueOrThrow({
    where: { name: 'EMPLOYEE' },
  });
  const employeeA = await prisma.user.create({
    data: {
      name: 'TEST inactive employee now at B',
      email: 'a@stage2.invalid',
      roleId: employeeRole.id,
      stationId: stationB.id,
      isActive: false,
      passwordHash: 'test-only-unusable-hash',
    },
  });
  const employeeB = await prisma.user.create({
    data: {
      name: 'TEST employee B',
      email: 'b@stage2.invalid',
      roleId: employeeRole.id,
      stationId: stationB.id,
      passwordHash: 'test-only-unusable-hash',
    },
  });
  const fixtures = workRecordFixtures({
    employeeA: employeeA.id,
    employeeB: employeeB.id,
    stationA: stationA.id,
    stationB: stationB.id,
  });
  const shifts: { id: number }[] = [];
  for (const data of fixtures.shifts)
    shifts.push(await prisma.shift.create({ data }));
  const attendance: { id: number }[] = [];
  for (const data of fixtures.attendance)
    attendance.push(await prisma.attendanceRecord.create({ data }));
  async function rejectsConstraint(
    query: string,
    values: unknown[],
    code: string,
  ) {
    await assert.rejects(sql.query(query, values), (error: unknown) => {
      const actual =
        typeof error === 'object' && error !== null && 'code' in error
          ? error.code
          : undefined;
      if (actual !== code)
        console.error(
          `Expected PostgreSQL SQLSTATE ${code}; received ${actual}`,
        );
      return actual === code;
    });
  }
  for (const end of ['2026-11-19T08:00:00Z', '2026-11-19T07:00:00Z'])
    await rejectsConstraint(
      'INSERT INTO shifts(employee_id,station_id,starts_at,ends_at) VALUES($1,$2,$3,$4)',
      [employeeA.id, stationA.id, '2026-11-19T08:00:00Z', end],
      '23514',
    );
  await rejectsConstraint(
    'INSERT INTO attendance_records(employee_id,station_id,clock_in_at,clock_out_at) VALUES($1,$2,$3,$4)',
    [employeeA.id, stationA.id, '2026-11-19T08:00:00Z', '2026-11-19T07:00:00Z'],
    '23514',
  );
  await rejectsConstraint(
    'INSERT INTO shifts(employee_id,station_id,starts_at,ends_at) VALUES($1,$2,$3,$4)',
    [2147483647, stationA.id, '2026-11-19T08:00:00Z', '2026-11-19T09:00:00Z'],
    '23503',
  );
  await rejectsConstraint(
    'DELETE FROM stations WHERE id=$1',
    [stationA.id],
    '23001',
  );
  await rejectsConstraint(
    'DELETE FROM users WHERE id=$1',
    [employeeA.id],
    '23001',
  );
  console.info(
    'PASS: timezone-aware storage, time checks, open/equal attendance and restrictive history FKs',
  );

  for (const path of ['shifts', 'attendance']) {
    for (const id of [reader.id, adminReader.id]) {
      const all = await get(path, {}, id);
      assert.equal(all.pagination.total, path === 'shifts' ? 5 : 6);
      assert.deepEqual(
        new Set(all[path].map((row: { stationId: number }) => row.stationId)),
        new Set([stationA.id, stationB.id]),
      );
    }
    const records = path === 'shifts' ? shifts : attendance;
    const range = {
      from: '2026-11-19T10:00:00+02:00',
      to: '2026-11-19T14:00:00+02:00',
    };
    const body = await get(path, range);
    assert.deepEqual(
      body[path].map((row: { id: number }) => row.id),
      (path === 'shifts' ? [2, 3] : [3, 2, 5]).map(
        (index) => records[index].id,
      ),
    );
    const filtered = await get(path, {
      ...range,
      stationId: stationA.id,
      employeeId: employeeA.id,
      limit: 1,
    });
    assert.equal(filtered.pagination.total, path === 'shifts' ? 1 : 2);
    assert.equal(filtered[path][0].stationId, stationA.id);
    assert.equal(filtered[path][0].employee.isActive, false);
    assert.equal(filtered[path][0].station.isActive, false);
    const page = await get(path, { ...range, page: 2, limit: 1 });
    assert.equal(page[path][0].id, records[path === 'shifts' ? 3 : 2].id);
    assert.equal(page.pagination.total, path === 'shifts' ? 2 : 3);
    const overnight = await get(path, {
      from: '2026-11-19T00:00:00Z',
      to: '2026-11-19T01:00:00Z',
    });
    assert.deepEqual(
      overnight[path].map((row: { id: number }) => row.id),
      (path === 'shifts' ? [0] : [3, 0]).map((index) => records[index].id),
    );
    const future = await get(path, { from: '2026-11-20T00:00:00Z' });
    assert.equal(future.pagination.total, path === 'shifts' ? 0 : 2);
    await get(
      path,
      { from: '2026-11-19T10:00:00', to: '2026-11-19T12:00:00Z' },
      reader.id,
      400,
    );
    await get(
      path,
      { from: '2026-11-20T00:00:00Z', to: '2026-11-19T00:00:00Z' },
      reader.id,
      400,
    );
    const permission = await prisma.permission.findUniqueOrThrow({
      where: { key: path === 'shifts' ? 'shifts.read' : 'attendance.read' },
    });
    await prisma.rolePermission.delete({
      where: {
        roleId_permissionId: { roleId: hr.id, permissionId: permission.id },
      },
    });
    await get(path, {}, reader.id, 403);
    await prisma.rolePermission.create({
      data: { roleId: hr.id, permissionId: permission.id },
    });
  }
  const readPermissions = await prisma.permission.findMany({
    where: { key: { in: ['attendance.read', 'shifts.read'] } },
  });
  for (const name of ['MANAGER', 'EMPLOYEE', 'SECURITY', 'CUSTOMER']) {
    const role = await prisma.role.upsert({
      where: { name },
      update: {},
      create: { name },
    });
    await prisma.rolePermission.createMany({
      data: readPermissions.map((p) => ({
        roleId: role.id,
        permissionId: p.id,
      })),
      skipDuplicates: true,
    });
    const user = await prisma.user.create({
      data: {
        name: `TEST ${name} reader`,
        email: `${name}@stage2.invalid`,
        passwordHash: 'test-only-unusable-hash',
        roleId: role.id,
        stationId: stationB.id,
      },
    });
    for (const path of ['shifts', 'attendance'])
      await get(path, {}, user.id, 403);
    if (name === 'MANAGER') {
      await prisma.station.update({ where: { id: stationA.id }, data: { managerId: user.id } });
      const second = await prisma.station.create({ data: { name: 'TEST second managed station', managerId: user.id } });
      const discovered = await get('stations/managed', {}, user.id);
      assert.deepEqual(new Set(discovered.stations.map((s: { id: number }) => s.id)), new Set([stationA.id, second.id]));
      const path = `manager/stations/${stationA.id}/attendance`;
      const historical = await get(path, { limit: 1 }, user.id);
      assert.equal(historical.pagination.total, 4);
      assert.equal(historical.attendance[0].stationId, stationA.id);
      assert.equal(historical.attendance[0].employee.isActive, false);
      for (const suffix of ['', '/export?format=csv', '/export?format=pdf']) {
        await get(`manager/stations/${stationB.id}/attendance${suffix}`, {}, user.id, 404);
        await get('manager/stations/2147483647/attendance' + suffix, {}, user.id, 404);
      }
      for (const format of ['csv', 'pdf']) {
        const exported = await request(app).get(`/api/${path}/export`)
          .query({ format, employeeId: employeeA.id, from: '2026-11-19T00:00:00Z', to: '2026-11-19T01:00:00Z' })
          .set('Cookie', `${ACCESS_COOKIE}=${tokenService.issue(user.id).accessToken}`);
        assert.equal(exported.status, 200);
        assert.equal(exported.headers['cache-control'], 'no-store');
        assert(exported.headers['content-disposition'].includes('attachment'));
        if (format === 'csv') assert(exported.text.includes(employeeA.name));
        else assert.equal(exported.body.subarray(0, 5).toString(), '%PDF-');
      }
      console.info('PASS: manager discovery and stored-station historical list/CSV/PDF; unmanaged/unknown station denial');
    }
  }
  console.info(
    'PASS: real API cross-station HR/ADMIN reads, permission/role denial, stored station/inactive history, filters/counts/pages, boundaries/overnight/open and empty tables',
  );
}

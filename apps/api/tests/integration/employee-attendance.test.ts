import request from 'supertest';
import { app } from '../../src/app.js';
import { prisma } from '../../src/database/prisma.js';
import { ACCESS_COOKIE } from '../../src/modules/auth/auth.types.js';
import { tokenService } from '../../src/modules/auth/token.service.js';

jest.mock('../../src/database/prisma.js', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    attendanceRecord: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));
jest.mock('../../src/utils/logger.js', () => ({
  logger: { error: jest.fn() },
}));
const db = prisma as unknown as {
  user: { findUnique: jest.Mock };
  attendanceRecord: {
    findFirst: jest.Mock;
    findUnique: jest.Mock;
    create: jest.Mock;
    updateMany: jest.Mock;
  };
  $transaction: jest.Mock;
};
type Row = {
  id: number;
  employeeId: number;
  stationId: number;
  checkInRequestId: string | null;
  clockInAt: Date;
  clockOutAt: Date | null;
};
let rows: Row[];
let role: string;
let permissions: string[];
let active: boolean;
let assignment: number | null;
let stationActive: boolean;
const base = '/api/employee/attendance';
const keyA = '12345678-1234-4234-8234-123456789abc';
const keyB = '12345678-1234-4234-8234-123456789abd';

function call(
  method: 'get' | 'post',
  path: string,
  body?: object,
  auth = true,
  csrf = true,
) {
  const pending = request(app)[method](`${base}${path}`);
  if (auth)
    pending.set(
      'Cookie',
      `${ACCESS_COOKIE}=${tokenService.issue(3).accessToken}`,
    );
  if (csrf)
    pending
      .set('Origin', 'http://localhost:3000')
      .set('X-CSRF-Protection', '1');
  if (body !== undefined) pending.send(body);
  return pending;
}
function projected(row: Row | undefined) {
  if (!row) return null;
  const record = {
    id: row.id,
    employeeId: row.employeeId,
    stationId: row.stationId,
    clockInAt: row.clockInAt,
    clockOutAt: row.clockOutAt,
  };
  return {
    ...record,
    station: {
      id: row.stationId,
      name: `Station ${row.stationId}`,
      isActive: stationActive,
    },
  };
}
beforeEach(() => {
  jest.resetAllMocks();
  rows = [];
  role = 'EMPLOYEE';
  permissions = ['attendance.read', 'attendance.self.write'];
  active = true;
  assignment = 10;
  stationActive = true;
  db.user.findUnique.mockImplementation(async () => ({
    id: 3,
    name: 'Employee',
    email: 'employee@example.invalid',
    isActive: active,
    stationId: assignment,
    tokenVersion: 0,
    station:
      assignment === null
        ? null
        : {
            id: assignment,
            name: `Station ${assignment}`,
            isActive: stationActive,
          },
    role: {
      name: role,
      permissions: permissions.map((key) => ({ permission: { key } })),
    },
  }));
  db.$transaction.mockImplementation(
    async (work: (tx: typeof db) => Promise<unknown>) => work(db),
  );
  db.attendanceRecord.findFirst.mockImplementation(
    async ({
      where,
    }: {
      where: { employeeId: number; id?: number; clockOutAt?: null };
    }) =>
      projected(
        rows.find(
          (row) =>
            row.employeeId === where.employeeId &&
            (where.id === undefined || row.id === where.id) &&
            (where.clockOutAt === undefined || row.clockOutAt === null),
        ),
      ),
  );
  db.attendanceRecord.findUnique.mockImplementation(
    async ({
      where,
    }: {
      where: {
        employeeId_checkInRequestId: {
          employeeId: number;
          checkInRequestId: string;
        };
      };
    }) =>
      projected(
        rows.find(
          (row) =>
            row.employeeId === where.employeeId_checkInRequestId.employeeId &&
            row.checkInRequestId ===
              where.employeeId_checkInRequestId.checkInRequestId,
        ),
      ),
  );
  db.attendanceRecord.create.mockImplementation(
    async ({ data }: { data: Omit<Row, 'id' | 'clockOutAt'> }) => {
      if (
        rows.some(
          (row) =>
            row.employeeId === data.employeeId &&
            (row.clockOutAt === null ||
              row.checkInRequestId === data.checkInRequestId),
        )
      )
        throw { code: 'P2002' };
      const row = { ...data, id: rows.length + 1, clockOutAt: null };
      rows.push(row);
      return projected(row);
    },
  );
  db.attendanceRecord.updateMany.mockImplementation(
    async ({
      where,
      data,
    }: {
      where: { id: number; employeeId: number };
      data: { clockOutAt: Date };
    }) => {
      const row = rows.find(
        (r) =>
          r.id === where.id &&
          r.employeeId === where.employeeId &&
          r.clockOutAt === null,
      );
      if (!row) return { count: 0 };
      row.clockOutAt = data.clockOutAt;
      return { count: 1 };
    },
  );
});

const operations = [
  ['get', '/current', undefined],
  ['post', '/check-in', { requestId: keyA }],
  ['post', '/1/check-out', {}],
] as const;
it.each(operations)(
  'requires authentication for %s %s',
  async (method, path, body) => {
    const response = await call(method, path, body, false);
    expect(response.status).toBe(401);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(db.$transaction).not.toHaveBeenCalled();
  },
);
it.each(['ADMIN', 'MANAGER', 'HR', 'SECURITY', 'CUSTOMER'])(
  'denies %s even with all attendance permissions',
  async (value) => {
    role = value;
    for (const [method, path, body] of operations)
      expect((await call(method, path, body)).status).toBe(403);
    expect(db.$transaction).not.toHaveBeenCalled();
  },
);
it.each(operations)(
  'requires the relevant permission for %s %s',
  async (method, path, body) => {
    permissions = [
      method === 'get' ? 'attendance.self.write' : 'attendance.read',
      'attendance.manage',
    ];
    expect((await call(method, path, body)).status).toBe(403);
  },
);
it.each(operations.slice(1))(
  'retains CSRF protection for %s %s',
  async (method, path, body) => {
    const response = await call(method, path, body, true, false);
    expect(response.status).toBe(403);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(db.$transaction).not.toHaveBeenCalled();
  },
);
it('returns current state with action capabilities', async () => {
  const response = await call('get', '/current');
  expect(response.body).toEqual({
    state: 'CHECKED_OUT',
    openRecord: null,
    assignedStation: { id: 10, name: 'Station 10', isActive: true },
    canCheckIn: true,
    canCheckOut: false,
  });
  permissions = ['attendance.read'];
  expect((await call('get', '/current')).body.canCheckIn).toBe(false);
});
it('derives identity, assignment and timestamp inside a Serializable transaction', async () => {
  const before = Date.now();
  const response = await call('post', '/check-in', { requestId: keyA });
  expect(response.status).toBe(200);
  expect(response.body.record).toMatchObject({
    employeeId: 3,
    stationId: 10,
    clockOutAt: null,
  });
  expect(Date.parse(response.body.record.clockInAt)).toBeGreaterThanOrEqual(
    before,
  );
  expect(Date.parse(response.body.record.clockInAt)).toBeLessThanOrEqual(
    Date.now(),
  );
  expect(response.text).not.toMatch(/requestId|email|password/);
  expect(db.user.findUnique).toHaveBeenCalledTimes(2);
  expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: 'Serializable',
  });
  const current = await call('get', '/current');
  expect(current.body).toMatchObject({
    state: 'CHECKED_IN',
    canCheckIn: false,
    canCheckOut: true,
  });
});
it.each(['missing', 'inactive'])(
  'rejects new check-in with %s assignment',
  async (kind) => {
    if (kind === 'missing') assignment = null;
    else stationActive = false;
    expect((await call('get', '/current')).body.canCheckIn).toBe(false);
    expect((await call('post', '/check-in', { requestId: keyA })).status).toBe(
      409,
    );
    expect(rows).toHaveLength(0);
  },
);
it.each([
  {},
  { requestId: 'bad' },
  { requestId: keyA, employeeId: 9 },
  { requestId: keyA, stationId: 20 },
  { requestId: keyA, clockInAt: '2026-01-01T00:00:00Z' },
  { requestId: keyA, clockOutAt: null },
])('rejects check-in fields %j', async (body) => {
  expect((await call('post', '/check-in', body)).status).toBe(400);
  expect(db.$transaction).not.toHaveBeenCalled();
});
it.each([
  { employeeId: 9 },
  { stationId: 20 },
  { clockOutAt: '2026-01-01T00:00:00Z' },
])('rejects check-out fields %j', async (body) => {
  expect((await call('post', '/1/check-out', body)).status).toBe(400);
});
it('rejects query overrides and malformed path IDs', async () => {
  expect((await call('get', '/current?employeeId=9')).status).toBe(400);
  expect(
    (await call('post', '/check-in?stationId=20', { requestId: keyA })).status,
  ).toBe(400);
  expect((await call('post', '/0/check-out', {})).status).toBe(400);
});
it('returns the original record for same key, including after closure, transfer and station inactivity', async () => {
  const first = await call('post', '/check-in', { requestId: keyA });
  const same = await call('post', '/check-in', {
    requestId: keyA.toUpperCase(),
  });
  expect(same.body).toEqual(first.body);
  await call('post', '/1/check-out', {});
  assignment = null;
  stationActive = false;
  const retry = await call('post', '/check-in', { requestId: keyA });
  expect(retry.status).toBe(200);
  expect(retry.body.record.id).toBe(1);
  expect(retry.body.record.clockOutAt).not.toBeNull();
  expect(rows).toHaveLength(1);
});
it('does not acknowledge a different key while open and permits it only after closure', async () => {
  await call('post', '/check-in', { requestId: keyA });
  expect((await call('post', '/check-in', { requestId: keyB })).status).toBe(
    409,
  );
  expect(rows).toHaveLength(1);
  expect(rows.some((r) => r.checkInRequestId === keyB)).toBe(false);
  await call('post', '/1/check-out', {});
  expect((await call('post', '/check-in', { requestId: keyB })).status).toBe(
    200,
  );
  expect(rows).toHaveLength(2);
});
it('allows the same UUID for different employees', async () => {
  rows.push({
    id: 10,
    employeeId: 4,
    stationId: 20,
    checkInRequestId: keyA,
    clockInAt: new Date(),
    clockOutAt: null,
  });
  expect((await call('post', '/check-in', { requestId: keyA })).status).toBe(
    200,
  );
  expect(rows).toHaveLength(2);
});
it('returns an older closed request even while a newer request is open', async () => {
  await call('post', '/check-in', { requestId: keyA });
  const closed = await call('post', '/1/check-out', {});
  await call('post', '/check-in', { requestId: keyB });
  expect((await call('post', '/check-in', { requestId: keyA })).body).toEqual(
    closed.body,
  );
  expect(rows).toHaveLength(2);
  expect(rows[1].clockOutAt).toBeNull();
});
it('reads and closes legacy attendance without a request UUID', async () => {
  rows.push({
    id: 1,
    employeeId: 3,
    stationId: 10,
    checkInRequestId: null,
    clockInAt: new Date('2026-01-01T00:00:00Z'),
    clockOutAt: null,
  });
  expect((await call('get', '/current')).body.openRecord.id).toBe(1);
  expect(
    (await call('post', '/1/check-out', {})).body.record.clockOutAt,
  ).not.toBeNull();
});
it('returns the same clock-out for overlapping repeat check-out requests', async () => {
  await call('post', '/check-in', { requestId: keyA });
  const outcomes = await Promise.all([
    call('post', '/1/check-out', {}),
    call('post', '/1/check-out', {}),
  ]);
  expect(outcomes.map((response) => response.status)).toEqual([200, 200]);
  expect(outcomes[0].body).toEqual(outcomes[1].body);
});
it('checks out the specified historical record despite inactive, different or missing assignment', async () => {
  await call('post', '/check-in', { requestId: keyA });
  stationActive = false;
  assignment = 20;
  expect((await call('get', '/current')).body).toMatchObject({
    openRecord: { stationId: 10 },
    canCheckOut: true,
  });
  assignment = null;
  const closed = await call('post', '/1/check-out', {});
  expect(closed.status).toBe(200);
  expect(closed.body.record.stationId).toBe(10);
  expect(closed.body.record.clockOutAt).not.toBeNull();
});
it('makes check-out idempotent and never closes a newer record on a delayed retry', async () => {
  await call('post', '/check-in', { requestId: keyA });
  const first = await call('post', '/1/check-out', {});
  await call('post', '/check-in', { requestId: keyB });
  const retry = await call('post', '/1/check-out', {});
  expect(retry.body).toEqual(first.body);
  expect(rows[1].clockOutAt).toBeNull();
});
it('returns the same 404 for unknown and another employee record', async () => {
  rows.push({
    id: 1,
    employeeId: 4,
    stationId: 10,
    checkInRequestId: keyA,
    clockInAt: new Date(),
    clockOutAt: null,
  });
  for (const id of [1, 999]) {
    const response = await call('post', `/${id}/check-out`, {});
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ message: 'Attendance record not found' });
  }
});
it.each(['P2002', 'P2034'])(
  'retries %s and resolves a concurrently recorded same key',
  async (code) => {
    db.attendanceRecord.create.mockImplementationOnce(async () => {
      rows.push({
        id: 1,
        employeeId: 3,
        stationId: 10,
        checkInRequestId: keyA,
        clockInAt: new Date(),
        clockOutAt: null,
      });
      throw { code };
    });
    expect(
      (await call('post', '/check-in', { requestId: keyA })).body.record.id,
    ).toBe(1);
    expect(db.$transaction).toHaveBeenCalledTimes(2);
  },
);
it('resolves a concurrent different key as 409 rather than acknowledging it', async () => {
  db.attendanceRecord.create.mockImplementationOnce(async () => {
    rows.push({
      id: 1,
      employeeId: 3,
      stationId: 10,
      checkInRequestId: keyB,
      clockInAt: new Date(),
      clockOutAt: null,
    });
    throw { code: 'P2002' };
  });
  expect((await call('post', '/check-in', { requestId: keyA })).status).toBe(
    409,
  );
  expect(rows).toHaveLength(1);
});
it('re-reads changed assignment on serialization retry', async () => {
  db.attendanceRecord.create.mockImplementationOnce(async () => {
    assignment = 20;
    throw { code: 'P2034' };
  });
  const response = await call('post', '/check-in', { requestId: keyA });
  expect(response.status).toBe(200);
  expect(response.body.record.stationId).toBe(20);
});
it('rechecks active status and role inside the transaction', async () => {
  db.$transaction.mockImplementationOnce(
    async (work: (tx: typeof db) => Promise<unknown>) => {
      active = false;
      return work(db);
    },
  );
  expect((await call('post', '/check-in', { requestId: keyA })).status).toBe(
    401,
  );
  active = true;
  db.$transaction.mockImplementationOnce(
    async (work: (tx: typeof db) => Promise<unknown>) => {
      role = 'CUSTOMER';
      return work(db);
    },
  );
  expect((await call('post', '/check-in', { requestId: keyA })).status).toBe(
    403,
  );
});
it('bounds transaction retries and sanitizes unexpected errors', async () => {
  db.$transaction.mockRejectedValue({ code: 'P2034' });
  expect((await call('post', '/check-in', { requestId: keyA })).status).toBe(
    409,
  );
  expect(db.$transaction).toHaveBeenCalledTimes(3);
  db.$transaction.mockRejectedValue(new Error('private database details'));
  const response = await call('post', '/check-in', { requestId: keyA });
  expect(response.status).toBe(500);
  expect(response.text).not.toContain('private');
});

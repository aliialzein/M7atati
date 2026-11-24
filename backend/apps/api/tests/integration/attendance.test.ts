import request from 'supertest';
import { app } from '../../src/app.js';
import { prisma } from '../../src/database/prisma.js';
import { ACCESS_COOKIE } from '../../src/modules/auth/auth.types.js';
import { tokenService } from '../../src/modules/auth/token.service.js';
import { workRecordFixtures } from '../fixtures/attendance.js';

jest.mock('../../src/database/prisma.js', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    shift: { findMany: jest.fn(), count: jest.fn() },
    attendanceRecord: { findMany: jest.fn(), count: jest.fn() },
    $transaction: jest.fn(),
  },
}));
jest.mock('../../src/utils/logger.js', () => ({
  logger: { error: jest.fn() },
}));

const db = prisma as unknown as {
  user: { findUnique: jest.Mock };
  shift: { findMany: jest.Mock; count: jest.Mock };
  attendanceRecord: { findMany: jest.Mock; count: jest.Mock };
  $transaction: jest.Mock;
};
type Row = {
  id: number;
  employeeId: number;
  stationId: number;
  startsAt?: Date;
  endsAt?: Date;
  clockInAt?: Date;
  clockOutAt?: Date | null;
};
type Where = { OR?: Where[]; [key: string]: unknown };
let shifts: Row[];
let attendance: Row[];
let role: string;
let permissions: string[];

// Exercise the real service/repository query predicates against independent data,
// including record stations that differ from a user's current assignment.
function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR')
      return (value as Where[]).some((part) => matches(row, part));
    const actual = row[key as keyof Row];
    if (value !== null && typeof value === 'object') {
      const comparison = value as { lt?: Date; gt?: Date };
      return (
        actual instanceof Date &&
        (!comparison.lt || actual < comparison.lt) &&
        (!comparison.gt || actual > comparison.gt)
      );
    }
    return actual === value;
  });
}

function get(
  path: string,
  query: Record<string, string | number | undefined> = {},
) {
  return request(app)
    .get(`/api/${path}`)
    .query(query)
    .set('Cookie', `${ACCESS_COOKIE}=${tokenService.issue(1).accessToken}`);
}

beforeEach(() => {
  jest.resetAllMocks();
  role = 'HR';
  permissions = ['attendance.read', 'shifts.read'];
  const fixtures = workRecordFixtures({
    employeeA: 3,
    employeeB: 4,
    stationA: 10,
    stationB: 20,
  });
  shifts = fixtures.shifts.map((row, index) => ({ ...row, id: index + 1 }));
  attendance = fixtures.attendance.map((row, index) => ({
    ...row,
    id: index + 1,
  }));
  db.user.findUnique.mockImplementation(async () => ({
    id: 1,
    name: 'Reader',
    email: 'reader@example.invalid',
    isActive: true,
    tokenVersion: 0,
    stationId: null,
    role: {
      name: role,
      permissions: permissions.map((key) => ({ permission: { key } })),
    },
  }));
  db.$transaction.mockImplementation(
    async (work: (tx: typeof db) => Promise<unknown>) => work(db),
  );
  for (const [delegate, records, timeKey] of [
    [db.shift, () => shifts, 'startsAt'],
    [db.attendanceRecord, () => attendance, 'clockInAt'],
  ] as const) {
    delegate.count.mockImplementation(
      async ({ where }: { where: Where }) =>
        records().filter((row) => matches(row, where)).length,
    );
    delegate.findMany.mockImplementation(
      async ({
        where,
        skip,
        take,
      }: {
        where: Where;
        skip: number;
        take: number;
      }) =>
        records()
          .filter((row) => matches(row, where))
          .sort(
            (a, b) => Number(a[timeKey]) - Number(b[timeKey]) || a.id - b.id,
          )
          .slice(skip, skip + take)
          .map((row) => ({
            ...row,
            employee: {
              id: row.employeeId,
              name: 'Inactive employee (currently at station 20)',
              isActive: false,
            },
            station: {
              id: row.stationId,
              name: 'Inactive historical station',
              isActive: false,
            },
          })),
    );
  }
});

describe.each(['shifts', 'attendance'])('GET /api/%s', (path) => {
  it.each(['HR', 'ADMIN'])(
    'allows %s across stations, including inactive history',
    async (allowedRole) => {
      role = allowedRole;
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(
        new Set(response.body[path].map((row: Row) => row.stationId)),
      ).toEqual(new Set([10, 20]));
      expect(response.body[path][0].employee.isActive).toBe(false);
      expect(response.body[path][0].station.isActive).toBe(false);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.text).not.toMatch(/password|token|email|roleId/);
    },
  );

  it('requires authentication', async () => {
    expect((await request(app).get(`/api/${path}`)).status).toBe(401);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it.each(['MANAGER', 'EMPLOYEE', 'SECURITY', 'CUSTOMER'])(
    'denies %s even with both read permissions',
    async (deniedRole) => {
      role = deniedRole;
      expect((await get(path)).status).toBe(403);
      expect(db.$transaction).not.toHaveBeenCalled();
    },
  );

  it.each(['HR', 'ADMIN'])(
    'requires the relevant permission for %s',
    async (allowedRole) => {
      role = allowedRole;
      permissions = [path === 'shifts' ? 'attendance.read' : 'shifts.read'];
      expect((await get(path)).status).toBe(403);
      expect(db.$transaction).not.toHaveBeenCalled();
    },
  );

  it('combines record station, employee, and range before pagination/count', async () => {
    const response = await get(path, {
      stationId: 10,
      employeeId: 3,
      from: '2026-11-19T10:00:00+02:00',
      to: '2026-11-19T14:00:00+02:00',
      limit: 1,
    });
    expect(response.status).toBe(200);
    expect(response.body.pagination).toEqual({
      page: 1,
      limit: 1,
      total: path === 'shifts' ? 1 : 2,
      totalPages: path === 'shifts' ? 1 : 2,
    });
    expect(response.body[path][0].stationId).toBe(10);
    const delegate = path === 'shifts' ? db.shift : db.attendanceRecord;
    const options = delegate.findMany.mock.calls[0][0];
    expect(options.where).toMatchObject({ stationId: 10, employeeId: 3 });
    expect(options.where).not.toHaveProperty('employee');
    expect(options.where).not.toHaveProperty('station');
    expect(delegate.count).toHaveBeenCalledWith({ where: options.where });
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead',
    });
  });

  it('uses deterministic time/id pagination and total', async () => {
    const response = await get(path, { page: 2, limit: 2 });
    expect(response.status).toBe(200);
    expect(response.body[path].map((row: Row) => row.id)).toEqual(
      path === 'shifts' ? [3, 4] : [2, 3],
    );
    expect(response.body.pagination).toEqual({
      page: 2,
      limit: 2,
      total: path === 'shifts' ? 5 : 6,
      totalPages: 3,
    });
    const delegate = path === 'shifts' ? db.shift : db.attendanceRecord;
    expect(delegate.findMany.mock.calls[0][0].orderBy).toEqual([
      { [path === 'shifts' ? 'startsAt' : 'clockInAt']: 'asc' },
      { id: 'asc' },
    ]);
  });

  it('matches half-open boundaries and open records', async () => {
    const response = await get(path, {
      from: '2026-11-19T08:00:00Z',
      to: '2026-11-19T12:00:00Z',
    });
    expect(response.status).toBe(200);
    expect(response.body[path].map((row: Row) => row.id)).toEqual(
      path === 'shifts' ? [3, 4] : [4, 3, 6],
    );
  });

  it('matches overnight records and accepts either time bound alone', async () => {
    const overnight = await get(path, {
      from: '2026-11-19T00:00:00Z',
      to: '2026-11-19T01:00:00Z',
    });
    expect(overnight.body[path].map((row: Row) => row.id)).toEqual(
      path === 'shifts' ? [1] : [4, 1],
    );
    expect(
      (await get(path, { to: '2026-11-19T00:00:00Z' })).body.pagination.total,
    ).toBe(path === 'shifts' ? 1 : 2);
    expect(
      (await get(path, { from: '2026-11-20T00:00:00Z' })).body[path].map(
        (row: Row) => row.id,
      ),
    ).toEqual(path === 'shifts' ? [] : [4, 5]);
  });

  it('returns empty pages for an empty dataset or unmatched filters', async () => {
    expect((await get(path, { stationId: 999 })).body.pagination.total).toBe(0);
    shifts = [];
    attendance = [];
    const response = await get(path);
    expect(response.status).toBe(200);
    expect(response.body[path]).toEqual([]);
    expect(response.body.pagination).toEqual({
      page: 1,
      limit: 20,
      total: 0,
      totalPages: 0,
    });
  });

  it.each([
    { from: '2026-11-19' },
    { from: '2026-11-19T08:00:00' },
    { from: '2026-02-30T08:00:00Z' },
    { from: 'bad' },
    { from: '2026-11-19T08:00:00+99:99' },
    { from: '2026-11-19T08:00:00.0001Z' },
    { from: '2026-11-19T08:00:00Z', to: '2026-11-19T07:00:00Z' },
    { from: '2026-11-19T10:00:00+02:00', to: '2026-11-19T08:00:00Z' },
    { page: 0 },
    { limit: 101 },
    { employeeId: -1 },
    { stationId: '1e3' },
    { unknown: 1 },
  ])('rejects invalid filters %j', async (query) => {
    expect((await get(path, query)).status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('rejects repeated query parameters', async () => {
    expect((await get(`${path}?stationId=10&stationId=20`)).status).toBe(400);
  });

  it.each(['post', 'patch', 'delete'] as const)(
    'has no %s operation',
    async (method) => {
      const client = request(app);
      expect(
        (
          await client[method](`/api/${path}`)
            .set(
              'Cookie',
              `${ACCESS_COOKIE}=${tokenService.issue(1).accessToken}`,
            )
            .set('Origin', 'http://localhost:3000')
            .set('X-CSRF-Protection', '1')
            .send({})
        ).status,
      ).toBe(404);
      expect(db.$transaction).not.toHaveBeenCalled();
    },
  );
});

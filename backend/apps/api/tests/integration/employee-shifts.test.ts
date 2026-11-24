import request from 'supertest';
import { app } from '../../src/app.js';
import { prisma } from '../../src/database/prisma.js';
import { ACCESS_COOKIE } from '../../src/modules/auth/auth.types.js';
import { tokenService } from '../../src/modules/auth/token.service.js';

jest.mock('../../src/database/prisma.js', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    shift: { findMany: jest.fn(), count: jest.fn() },
    $transaction: jest.fn(),
  },
}));
jest.mock('../../src/utils/logger.js', () => ({
  logger: { error: jest.fn() },
}));
const db = prisma as unknown as {
  user: { findUnique: jest.Mock };
  shift: { findMany: jest.Mock; count: jest.Mock };
  $transaction: jest.Mock;
};
type Row = {
  id: number;
  employeeId: number;
  stationId: number;
  startsAt: Date;
  endsAt: Date;
};
type Where = {
  employeeId?: number;
  startsAt?: { lt: Date };
  endsAt?: { gt: Date };
};
let rows: Row[];
let role: string;
let permissions: string[];
let active: boolean;
let assigned: number | null;
const base = '/api/employee/shifts';
function row(
  id: number,
  start: string,
  end: string,
  employeeId = 3,
  stationId = 10,
): Row {
  return {
    id,
    employeeId,
    stationId,
    startsAt: new Date(start),
    endsAt: new Date(end),
  };
}
function matches(record: Row, where: Where) {
  return (
    (where.employeeId === undefined ||
      record.employeeId === where.employeeId) &&
    (!where.startsAt || record.startsAt < where.startsAt.lt) &&
    (!where.endsAt || record.endsAt > where.endsAt.gt)
  );
}
function get(
  query: Record<string, string | number | undefined> = {
    weekStart: '2026-11-16',
  },
  auth = true,
  path = base,
) {
  const pending = request(app).get(path).query(query);
  if (auth)
    pending.set(
      'Cookie',
      `${ACCESS_COOKIE}=${tokenService.issue(3).accessToken}`,
    );
  return pending;
}
beforeEach(() => {
  jest.resetAllMocks();
  role = 'EMPLOYEE';
  permissions = ['shifts.read'];
  active = true;
  assigned = 20;
  rows = [
    row(1, '2026-11-15T20:00:00Z', '2026-11-16T04:00:00Z'), // Crosses start.
    row(2, '2026-11-15T18:00:00Z', '2026-11-15T22:00:00Z'), // Ends exactly at start.
    row(3, '2026-11-16T20:00:00Z', '2026-11-17T04:00:00Z'), // Overnight.
    row(4, '2026-11-22T20:00:00Z', '2026-11-23T04:00:00Z'), // Crosses end.
    row(5, '2026-11-22T22:00:00Z', '2026-11-23T04:00:00Z'), // Starts exactly at end.
    row(6, '2026-11-16T20:00:00Z', '2026-11-17T04:00:00Z', 4), // Other employee.
    row(7, '2026-11-17T08:00:00Z', '2026-11-17T16:00:00Z', 3, 20),
    row(8, '2026-11-16T20:00:00Z', '2026-11-17T06:00:00Z'), // Timestamp tie.
  ];
  db.user.findUnique.mockImplementation(async () => ({
    id: 3,
    name: 'Employee',
    email: 'employee@example.invalid',
    stationId: assigned,
    isActive: active,
    tokenVersion: 0,
    role: {
      name: role,
      permissions: permissions.map((key) => ({ permission: { key } })),
    },
  }));
  db.$transaction.mockImplementation(
    (work: (tx: typeof db) => Promise<unknown>) => work(db),
  );
  db.shift.count.mockImplementation(
    async ({ where }: { where: Where }) =>
      rows.filter((record) => matches(record, where)).length,
  );
  db.shift.findMany.mockImplementation(
    async ({
      where,
      skip,
      take,
    }: {
      where: Where;
      skip: number;
      take: number;
    }) =>
      rows
        .filter((record) => matches(record, where))
        .sort((a, b) => Number(a.startsAt) - Number(b.startsAt) || a.id - b.id)
        .slice(skip, skip + take)
        .map((record) => ({
          ...record,
          createdAt: new Date('2026-01-01T00:00:00Z'),
          employee: { id: record.employeeId, name: 'Employee', isActive: true },
          station: {
            id: record.stationId,
            name: `Station ${record.stationId}`,
            isActive: record.stationId !== 10,
          },
        })),
  );
});
it('requires authentication and no-store caching on denial', async () => {
  const response = await get({ weekStart: '2026-11-16' }, false);
  expect(response.status).toBe(401);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(db.$transaction).not.toHaveBeenCalled();
});
it.each(['ADMIN', 'HR', 'MANAGER', 'SECURITY', 'CUSTOMER'])(
  'rejects %s despite shifts.read',
  async (value) => {
    role = value;
    expect((await get()).status).toBe(403);
    expect(db.$transaction).not.toHaveBeenCalled();
  },
);
it('requires shifts.read independently of attendance permissions', async () => {
  permissions = ['attendance.read', 'attendance.self.write'];
  const response = await get();
  expect(response.status).toBe(403);
  expect(response.headers['cache-control']).toBe('no-store');
});
it('rejects disabled employees', async () => {
  active = false;
  expect((await get()).status).toBe(401);
});
it('returns only own overlap, overnight and cross-week shifts with recorded/inactive stations', async () => {
  const response = await get();
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).toMatchObject({
    weekStart: '2026-11-16',
    timezone: 'Asia/Beirut',
    from: '2026-11-15T22:00:00.000Z',
    to: '2026-11-22T22:00:00.000Z',
    pagination: { page: 1, limit: 20, total: 5, totalPages: 1 },
  });
  expect(response.body.shifts.map((shift: Row) => shift.id)).toEqual([
    1, 3, 8, 7, 4,
  ]);
  expect(response.body.shifts[0].station).toEqual({
    id: 10,
    name: 'Station 10',
    isActive: false,
  });
  const options = db.shift.findMany.mock.calls[0][0];
  expect(options.where).toEqual({
    employeeId: 3,
    startsAt: { lt: new Date('2026-11-22T22:00:00Z') },
    endsAt: { gt: new Date('2026-11-15T22:00:00Z') },
  });
  expect(options.orderBy).toEqual([{ startsAt: 'asc' }, { id: 'asc' }]);
  expect(options.select).not.toHaveProperty('checkInRequestId');
  expect(db.shift.count).toHaveBeenCalledWith({ where: options.where });
  expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: 'RepeatableRead',
  });
  expect(response.text).not.toMatch(/password|email|token|roleId/);
});
it('retains history even if the employee has no current station assignment', async () => {
  assigned = null;
  const response = await get();
  expect(response.status).toBe(200);
  expect(response.body.pagination.total).toBe(5);
});
it('paginates after scope/range with stable ties and consistent totals', async () => {
  const seen: number[] = [];
  for (let page = 1; page <= 3; page++) {
    const response = await get({ weekStart: '2026-11-16', limit: 2, page });
    expect(response.body.pagination).toEqual({
      page,
      limit: 2,
      total: 5,
      totalPages: 3,
    });
    seen.push(...response.body.shifts.map((shift: Row) => shift.id));
  }
  expect(seen).toEqual([1, 3, 8, 7, 4]);
});
it('returns empty pages with the correct total and empty weeks with zero totals', async () => {
  const beyond = await get({
    weekStart: '2026-11-16',
    page: 1000000,
    limit: 100,
  });
  expect(beyond.body.shifts).toEqual([]);
  expect(beyond.body.pagination.total).toBe(5);
  const empty = await get({ weekStart: '2026-11-30' });
  expect(empty.body.shifts).toEqual([]);
  expect(empty.body.pagination).toEqual({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 0,
  });
});
it.each([
  ['2026-03-23', '2026-03-22T22:00:00.000Z', '2026-03-29T21:00:00.000Z', 167],
  ['2026-10-19', '2026-10-18T21:00:00.000Z', '2026-10-25T22:00:00.000Z', 169],
] as const)(
  'resolves each midnight independently for DST week %s',
  async (weekStart, from, to, hours) => {
    rows = [
      row(30, from, new Date(Date.parse(from) + 3600000).toISOString()),
      row(
        31,
        new Date(Date.parse(to) - 3600000).toISOString(),
        new Date(Date.parse(to) + 3600000).toISOString(),
      ),
      row(32, new Date(Date.parse(from) - 3600000).toISOString(), from),
      row(33, to, new Date(Date.parse(to) + 3600000).toISOString()),
    ];
    const response = await get({ weekStart });
    expect(response.status).toBe(200);
    expect(response.body.from).toBe(from);
    expect(response.body.to).toBe(to);
    expect((Date.parse(to) - Date.parse(from)) / 3600000).toBe(hours);
    expect(response.body.shifts.map((shift: Row) => shift.id)).toEqual([
      30, 31,
    ]);
  },
);
it.each(['2024-02-26', '2025-12-29'])(
  'accepts leap-year or cross-year Monday %s',
  async (weekStart) => {
    expect((await get({ weekStart })).status).toBe(200);
  },
);
it.each([
  {},
  { weekStart: '2026-11-17' },
  { weekStart: '2026-11-15' },
  { weekStart: '2026-02-30' },
  { weekStart: '2025-02-29' },
  { weekStart: '2026-13-01' },
  { weekStart: '2026-00-00' },
  { weekStart: '2026-11-16T00:00:00Z' },
  { weekStart: '2026-1-5' },
  { weekStart: '' },
  { weekStart: ' 2026-11-16' },
  { weekStart: '0000-01-03' },
  { weekStart: '2026-11-16', employeeId: 4 },
  { weekStart: '2026-11-16', stationId: 20 },
  { weekStart: '2026-11-16', from: '2026-11-16T00:00:00Z' },
  { weekStart: '2026-11-16', timezone: 'UTC' },
  { weekStart: '2026-11-16', unknown: 1 },
  { weekStart: '2026-11-16', page: 0 },
  { weekStart: '2026-11-16', page: 1000001 },
  { weekStart: '2026-11-16', page: 1.5 },
  { weekStart: '2026-11-16', limit: 0 },
  { weekStart: '2026-11-16', limit: 101 },
  { weekStart: '2026-11-16', limit: '1e2' },
])('rejects invalid dates or extra filters %j', async (query) => {
  const response = await get(query);
  expect(response.status).toBe(400);
  expect(response.body).toEqual({ message: 'Invalid request' });
  expect(response.headers['cache-control']).toBe('no-store');
  expect(db.$transaction).not.toHaveBeenCalled();
});
it.each([
  'weekStart=2026-11-16&weekStart=2026-11-23',
  'weekStart=2026-11-16&page=1&page=2',
  'weekStart=2026-11-16&limit=1&limit=2',
])('rejects repeated parameters %s', async (query) => {
  expect((await get({}, true, `${base}?${query}`)).status).toBe(400);
});
it('preserves the HR/Admin global route and its employee denial', async () => {
  expect((await get({}, true, '/api/shifts')).status).toBe(403);
  for (const value of ['HR', 'ADMIN']) {
    role = value;
    const response = await get({}, true, '/api/shifts');
    expect(response.status).toBe(200);
    expect(response.body.pagination.total).toBe(8);
  }
});

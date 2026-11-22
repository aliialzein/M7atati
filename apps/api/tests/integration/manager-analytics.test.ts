import request from 'supertest';
import { app } from '../../src/app.js';
import { prisma } from '../../src/database/prisma.js';
import { ACCESS_COOKIE } from '../../src/modules/auth/auth.types.js';
import { tokenService } from '../../src/modules/auth/token.service.js';
import { workRecordFixtures } from '../fixtures/attendance.js';
import {
  orderFixtures,
  matchesOrder,
  selectFields,
  type OrderFixture,
  type OrderWhere,
} from '../fixtures/orders.js';

jest.mock('../../src/database/prisma.js', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    station: { findFirst: jest.fn() },
    attendanceRecord: { count: jest.fn(), findMany: jest.fn() },
    fuelOrder: { groupBy: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    $transaction: jest.fn(),
  },
}));
jest.mock('../../src/utils/logger.js', () => ({
  logger: { error: jest.fn() },
}));

const db = prisma as unknown as {
  user: { findUnique: jest.Mock };
  station: { findFirst: jest.Mock };
  attendanceRecord: { count: jest.Mock; findMany: jest.Mock };
  fuelOrder: { groupBy: jest.Mock; findMany: jest.Mock; count: jest.Mock };
  $transaction: jest.Mock;
};
type Row = {
  id: number;
  employeeId: number;
  stationId: number;
  clockInAt: Date;
  clockOutAt: Date | null;
};
type Where = { AND?: Where[]; OR?: Where[]; [key: string]: unknown };
let rows: Row[];
let orders: OrderFixture[];
let stations: {
  id: number;
  name: string;
  managerId: number;
  isActive: boolean;
}[];
let role: string;
let permissions: string[];
let actorId: number;
let active: boolean;
const grants = ['reports.read', 'attendance.read', 'orders.read'];
const base = '/api/manager/stations/10/analytics';

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'AND')
      return (value as Where[]).every((part) => matches(row, part));
    if (key === 'OR')
      return (value as Where[]).some((part) => matches(row, part));
    const actual = row[key as keyof Row];
    if (value !== null && typeof value === 'object') {
      const compare = value as { lt?: Date; gt?: Date };
      return (
        actual instanceof Date &&
        (!compare.lt || actual < compare.lt) &&
        (!compare.gt || actual > compare.gt)
      );
    }
    return actual === value;
  });
}

function get(
  query: Record<string, string | number | undefined> = {},
  path = base,
  authenticated = true,
) {
  const pending = request(app).get(path).query(query);
  if (authenticated)
    pending.set(
      'Cookie',
      `${ACCESS_COOKIE}=${tokenService.issue(actorId).accessToken}`,
    );
  return pending;
}

beforeEach(() => {
  jest.restoreAllMocks();
  jest.resetAllMocks();
  role = 'MANAGER';
  permissions = [...grants];
  actorId = 1;
  active = true;
  stations = [
    {
      id: 10,
      name: 'Inactive historical station',
      managerId: 1,
      isActive: false,
    },
    { id: 11, name: 'Second managed station', managerId: 1, isActive: true },
    {
      id: 20,
      name: 'Affiliated station owned by another manager',
      managerId: 2,
      isActive: true,
    },
  ];
  rows = workRecordFixtures({
    employeeA: 3,
    employeeB: 4,
    stationA: 10,
    stationB: 20,
  }).attendance.map((row, index) => ({ ...row, id: index + 1 }));
  orders = [...orderFixtures(10), ...orderFixtures(20)];
  db.fuelOrder.groupBy.mockImplementation(
    async ({ where }: { where: OrderWhere }) => {
      const counts = new Map<string, number>();
      for (const row of orders.filter((row) => matchesOrder(row, where)))
        counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
      return [...counts].map(([status, count]) => ({
        status,
        _count: { _all: count },
      }));
    },
  );
  db.fuelOrder.count.mockImplementation(
    async ({ where }) =>
      orders.filter((row) => matchesOrder(row, where)).length,
  );
  db.fuelOrder.findMany.mockImplementation(
    async ({ where, select, skip, take }) =>
      orders
        .filter((row) => matchesOrder(row, where))
        .sort(
          (a, b) => Number(b.createdAt) - Number(a.createdAt) || b.id - a.id,
        )
        .slice(skip, skip + take)
        .map((row) => selectFields(row, select)),
  );
  db.user.findUnique.mockImplementation(async () => ({
    id: actorId,
    name: 'Manager',
    email: 'manager@example.invalid',
    isActive: active,
    stationId: 20,
    tokenVersion: 0,
    role: {
      name: role,
      permissions: permissions.map((key) => ({ permission: { key } })),
    },
  }));
  db.station.findFirst.mockImplementation(
    async ({
      where,
    }: {
      where: { AND: [{ id: number }, { managerId: number }] };
    }) =>
      stations.find(
        (s) =>
          s.id === where.AND[0].id && s.managerId === where.AND[1].managerId,
      ) ?? null,
  );
  db.$transaction.mockImplementation(
    async (work: (tx: typeof db) => Promise<unknown>) => work(db),
  );
  db.attendanceRecord.count.mockImplementation(
    async ({ where }: { where: Where }) =>
      rows.filter((row) => matches(row, where)).length,
  );
  db.attendanceRecord.findMany.mockImplementation(
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
        .filter((row) => matches(row, where))
        .sort(
          (a, b) => Number(a.clockInAt) - Number(b.clockInAt) || a.id - b.id,
        )
        .slice(skip, skip + take)
        .map((row) => ({
          ...row,
          employee: {
            id: row.employeeId,
            name: 'Inactive employee currently assigned to station 20',
            isActive: false,
          },
          station: stations.find((s) => s.id === row.stationId),
        })),
  );
});

describe('manager analytics access controls', () => {
  it('requires authentication before reading counts or order data', async () => {
    const factory = db.fuelOrder.groupBy;
    const response = await get({}, base, false);
    expect(response.status).toBe(401);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });
  it('rejects inactive managers', async () => {
    active = false;
    expect((await get()).status).toBe(401);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it.each(['ADMIN', 'HR', 'EMPLOYEE', 'SECURITY', 'CUSTOMER'])(
    'denies %s with all three permissions',
    async (value) => {
      role = value;
      const response = await get();
      expect(response.status).toBe(403);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(db.$transaction).not.toHaveBeenCalled();
    },
  );
  it.each(grants)('requires %s independently', async (missing) => {
    permissions = grants.filter((key) => key !== missing);
    expect((await get()).status).toBe(403);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it.each([{}, { from: '1900-01-01T00:00:00Z', to: '1900-01-02T00:00:00Z' }])(
    'returns identical unknown/unmanaged 404s even for empty ranges: %j',
    async (query) => {
      const factory = db.fuelOrder.groupBy;
      for (const id of [20, 999]) {
        const response = await get(query, base.replace('/10/', `/${id}/`));
        expect(response.status).toBe(404);
        expect(response.body).toEqual({ message: 'Station not found' });
        expect(response.headers['cache-control']).toBe('no-store');
      }
      expect(db.attendanceRecord.count).not.toHaveBeenCalled();
      expect(factory).not.toHaveBeenCalled();
    },
  );
  it('rechecks ownership after station management changes', async () => {
    expect((await get()).status).toBe(200);
    stations[0].managerId = 2;
    expect((await get()).status).toBe(404);
  });
});

describe('manager persisted analytics metrics', () => {
  const zero = {
    AWAITING_PAYMENT: 0,
    PENDING: 0,
    IN_PROGRESS: 0,
    COMPLETED: 0,
    CANCELLED: 0,
  };
  it('counts persisted statuses and retains attendance history without money aggregates', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      stationId: 10,
      attendance: { totalRecords: 4, openRecords: 1, closedRecords: 3 },
      orders: {
        dataSource: 'database',
        totalOrders: 8,
        countsByStatus: {
          AWAITING_PAYMENT: 0,
          PENDING: 2,
          IN_PROGRESS: 1,
          COMPLETED: 3,
          CANCELLED: 2,
        },
      },
    });
    expect(db.attendanceRecord.findMany).not.toHaveBeenCalled();
    expect(db.fuelOrder.findMany).not.toHaveBeenCalled();
    expect(db.fuelOrder.groupBy).toHaveBeenCalledWith({
      by: ['status'],
      where: { stationId: 10 },
      _count: { _all: true },
    });
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead',
    });
    expect(response.text).not.toMatch(
      /currency|Minor|payment|revenue|captured|password|email|token/,
    );
  });
  it('returns zero status counts for an owned station without orders or attendance', async () => {
    const response = await get({}, base.replace('/10/', '/11/'));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      stationId: 11,
      attendance: { totalRecords: 0, openRecords: 0, closedRecords: 0 },
      orders: { dataSource: 'database', totalOrders: 0, countsByStatus: zero },
    });
  });
  it('isolates persisted counts between managers', async () => {
    orders = orders.filter((row) => row.stationId === 10 || row.id === 2007);
    expect((await get()).body.orders.totalOrders).toBe(8);
    expect((await get({}, base.replace('/10/', '/20/'))).status).toBe(404);
    actorId = 2;
    const other = await get({}, base.replace('/10/', '/20/'));
    expect(other.body.attendance).toEqual({
      totalRecords: 2,
      openRecords: 1,
      closedRecords: 1,
    });
    expect(other.body.orders).toEqual({
      dataSource: 'database',
      totalOrders: 1,
      countsByStatus: { ...zero, IN_PROGRESS: 1 },
    });
    expect((await get()).status).toBe(404);
  });
  it('preserves unknown legacy statuses rather than silently dropping orders', async () => {
    orders[0].status = 'LEGACY';
    const summary = (await get()).body.orders;
    expect(summary.totalOrders).toBe(8);
    expect(summary.countsByStatus).toEqual({
      AWAITING_PAYMENT: 0,
      PENDING: 2,
      IN_PROGRESS: 1,
      COMPLETED: 3,
      CANCELLED: 1,
      LEGACY: 1,
    });
  });
  it('uses overlap for overnight attendance and creation time for orders', async () => {
    const response = await get({
      from: '2026-11-19T02:00:00+02:00',
      to: '2026-11-19T03:00:00+02:00',
    });
    expect(response.body.attendance).toEqual({
      totalRecords: 2,
      openRecords: 1,
      closedRecords: 1,
    });
    expect(response.body.orders).toEqual({
      dataSource: 'database',
      totalOrders: 1,
      countsByStatus: { ...zero, PENDING: 1 },
    });
  });
  it('excludes attendance ending at from and orders created at to', async () => {
    const response = await get({
      from: '2026-11-19T08:00:00Z',
      to: '2026-11-19T12:00:00Z',
    });
    expect(response.body.attendance).toEqual({
      totalRecords: 2,
      openRecords: 1,
      closedRecords: 1,
    });
    expect(response.body.orders.totalOrders).toBe(0);
  });
  it('excludes attendance starting at to and includes orders created at from', async () => {
    rows.push({
      ...rows[0],
      id: 99,
      clockInAt: new Date('2026-11-19T13:00:00Z'),
      clockOutAt: null,
    });
    const response = await get({
      from: '2026-11-19T12:00:00Z',
      to: '2026-11-19T13:00:00Z',
    });
    expect(response.body.attendance).toEqual({
      totalRecords: 1,
      openRecords: 1,
      closedRecords: 0,
    });
    expect(response.body.orders).toEqual({
      dataSource: 'database',
      totalOrders: 2,
      countsByStatus: { ...zero, PENDING: 1, COMPLETED: 1 },
    });
  });
  it('accepts from alone without inventing clock-out times', async () => {
    const response = await get({ from: '2026-11-20T00:00:00Z' });
    expect(response.body.attendance).toEqual({
      totalRecords: 1,
      openRecords: 1,
      closedRecords: 0,
    });
    expect(response.body.orders.totalOrders).toBe(4);
    expect(rows.find((row) => row.id === 4)!.clockOutAt).toBeNull();
  });
  it.each([
    { to: '2026-11-18T20:00:00Z' },
    { from: '1900-01-01T00:00:00Z', to: '1900-01-02T00:00:00Z' },
  ])('returns explicit zero counts for empty range %j', async (query) => {
    const response = await get(query);
    expect(response.body.attendance).toEqual({
      totalRecords: 0,
      openRecords: 0,
      closedRecords: 0,
    });
    expect(response.body.orders).toEqual({
      dataSource: 'database',
      totalOrders: 0,
      countsByStatus: zero,
    });
  });
  it('returns zero orders without affecting attendance', async () => {
    orders = [];
    expect((await get()).body).toEqual({
      stationId: 10,
      attendance: { totalRecords: 4, openRecords: 1, closedRecords: 3 },
      orders: { dataSource: 'database', totalOrders: 0, countsByStatus: zero },
    });
  });
  it('counts entirely open and entirely closed attendance accurately', async () => {
    rows = rows.filter((row) => row.clockOutAt !== null);
    expect((await get()).body.attendance).toEqual({
      totalRecords: 3,
      openRecords: 0,
      closedRecords: 3,
    });
    rows.forEach((row) => {
      row.clockOutAt = null;
    });
    expect((await get()).body.attendance).toEqual({
      totalRecords: 3,
      openRecords: 3,
      closedRecords: 0,
    });
  });
  it('agrees with both complete paginated lists', async () => {
    rows.push(
      ...Array.from({ length: 26 }, (_, i) => ({
        id: 100 + i,
        employeeId: 3,
        stationId: 10,
        clockInAt: new Date('2026-11-19T10:00:00Z'),
        clockOutAt: i % 2 === 0 ? null : new Date('2026-11-19T11:00:00Z'),
      })),
    );
    const range = { from: '2026-11-18T00:00:00Z', to: '2026-11-22T00:00:00Z' };
    const summary = (await get(range)).body;
    const attendance: { clockOutAt: string | null }[] = [];
    const selectedOrders: { status: string }[] = [];
    for (const path of ['attendance', 'orders']) {
      let page = 1;
      let totalPages = 1;
      do {
        const response = await get(
          { ...range, page, limit: 2 },
          base.replace('/analytics', `/${path}`),
        );
        expect(response.status).toBe(200);
        if (path === 'attendance') attendance.push(...response.body.attendance);
        else selectedOrders.push(...response.body.orders);
        totalPages = response.body.pagination.totalPages;
        expect(totalPages).toBeGreaterThan(1);
        page++;
      } while (page <= totalPages);
    }
    expect(attendance).toHaveLength(30);
    expect(summary.attendance).toEqual({
      totalRecords: attendance.length,
      openRecords: attendance.filter((row) => row.clockOutAt === null).length,
      closedRecords: attendance.filter((row) => row.clockOutAt !== null).length,
    });
    expect(selectedOrders).toHaveLength(8);
    expect(summary.orders.totalOrders).toBe(selectedOrders.length);
    for (const status of ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'])
      expect(summary.orders.countsByStatus[status]).toBe(
        selectedOrders.filter((row) => row.status === status).length,
      );
  });
});

describe('manager analytics validation', () => {
  it.each([
    { from: '2026-11-19' },
    { to: '2026-11-19T12:00:00' },
    { from: '2026-02-30T00:00:00Z' },
    { from: '2026-11-19T00:00:00.0001Z' },
    { to: '2026-11-19T12:00:00+99:99' },
    { from: '2026-11-20T00:00:00Z', to: '2026-11-19T00:00:00Z' },
    { from: '2026-11-19T14:00:00+02:00', to: '2026-11-19T12:00:00Z' },
    { stationId: 20 },
    { employeeId: 3 },
    { page: 1 },
    { limit: 20 },
    { status: 'COMPLETED' },
    { minAmountMinor: 0 },
    { unknown: 1 },
  ])('rejects invalid ranges and unsupported filters %j', async (query) => {
    const response = await get(query);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ message: 'Invalid request' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it.each([
    'from=2026-11-19T00:00:00Z&from=2026-11-20T00:00:00Z',
    'to=2026-11-19T00:00:00Z&to=2026-11-20T00:00:00Z',
  ])('rejects repeated bounds %s', async (query) => {
    expect((await get({}, `${base}?${query}`)).status).toBe(400);
  });
  it.each(['0', '-1', '1e3', '2147483648', 'invalid'])(
    'rejects malformed station ID %s',
    async (id) => {
      expect((await get({}, base.replace('/10/', `/${id}/`))).status).toBe(400);
      expect(db.$transaction).not.toHaveBeenCalled();
    },
  );
});

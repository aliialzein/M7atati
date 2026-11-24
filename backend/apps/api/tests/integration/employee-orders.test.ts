import request from 'supertest';
import { app } from '../../src/app.js';
import { prisma } from '../../src/database/prisma.js';
import { ACCESS_COOKIE } from '../../src/modules/auth/auth.types.js';
import { tokenService } from '../../src/modules/auth/token.service.js';
jest.mock('../../src/database/prisma.js', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    fuelOrder: { findMany: jest.fn(), count: jest.fn() },
    $transaction: jest.fn(),
  },
}));
jest.mock('../../src/utils/logger.js', () => ({
  logger: { error: jest.fn() },
}));
const db = prisma as unknown as {
  user: { findUnique: jest.Mock };
  fuelOrder: { findMany: jest.Mock; count: jest.Mock };
  $transaction: jest.Mock;
};
type Row = {
  id: number;
  stationId: number;
  status: string;
  createdAt: Date;
  customerPhone: string;
  orderedAmountMinor: number;
  assignedEmployeeId: number | null;
};
let rows: Row[];
let role: string;
let permissions: string[];
let assignment: number | null;
let stationActive: boolean;
let active: boolean;
let actorId: number;
const base = '/api/employee/orders';
function get(
  query: Record<string, string | number | undefined> = {},
  auth = true,
  path = base,
) {
  const pending = request(app).get(path).query(query);
  if (auth)
    pending.set(
      'Cookie',
      `${ACCESS_COOKIE}=${tokenService.issue(actorId).accessToken}`,
    );
  return pending;
}
beforeEach(() => {
  jest.resetAllMocks();
  role = 'EMPLOYEE';
  permissions = ['orders.read'];
  assignment = 10;
  stationActive = true;
  active = true;
  actorId = 3;
  rows = [
    {
      id: 3,
      stationId: 10,
      status: 'PENDING',
      createdAt: new Date('2026-11-21T08:00:00Z'),
      customerPhone: 'private-contact',
      orderedAmountMinor: 100,
    },
    {
      id: 1,
      stationId: 10,
      status: 'PENDING',
      createdAt: new Date('2026-11-21T07:00:00Z'),
      customerPhone: 'private-contact',
      orderedAmountMinor: 100,
    },
    {
      id: 2,
      stationId: 10,
      status: 'PENDING',
      createdAt: new Date('2026-11-21T08:00:00Z'),
      customerPhone: 'private-contact',
      orderedAmountMinor: 100,
    },
    {
      id: 4,
      stationId: 20,
      status: 'PENDING',
      createdAt: new Date('2026-11-21T06:00:00Z'),
      customerPhone: 'private-contact',
      orderedAmountMinor: 100,
    },
    {
      id: 5,
      stationId: 10,
      status: 'COMPLETED',
      createdAt: new Date('2026-11-21T06:00:00Z'),
      customerPhone: 'private-contact',
      orderedAmountMinor: 100,
    },
    {
      id: 6,
      stationId: 10,
      status: 'CANCELLED',
      createdAt: new Date('2026-11-21T06:00:00Z'),
      customerPhone: 'private-contact',
      orderedAmountMinor: 100,
    },
  ].map((row) => ({ ...row, assignedEmployeeId: null }));
  db.user.findUnique.mockImplementation(async () => ({
    id: actorId,
    name: 'Employee',
    email: 'staff@example.invalid',
    isActive: active,
    stationId: assignment,
    tokenVersion: 0,
    station:
      assignment === null ? null : { id: assignment, isActive: stationActive },
    role: {
      name: role,
      permissions: permissions.map((key) => ({ permission: { key } })),
    },
  }));
  db.$transaction.mockImplementation(
    (work: (tx: typeof db) => Promise<unknown>) => work(db),
  );
  const selected = (where: {
    stationId: number;
    status: string;
    assignedEmployeeId: null;
  }) =>
    rows.filter(
      (row) =>
        row.stationId === where.stationId &&
        row.status === where.status &&
        row.assignedEmployeeId === where.assignedEmployeeId,
    );
  db.fuelOrder.count.mockImplementation(
    async ({ where }) => selected(where).length,
  );
  db.fuelOrder.findMany.mockImplementation(async ({ where, skip, take }) =>
    selected(where)
      .sort((a, b) => +a.createdAt - +b.createdAt || a.id - b.id)
      .slice(skip, skip + take)
      .map((row) => ({
        id: row.id,
        status: row.status,
        createdAt: row.createdAt,
        orderedVolume: '25',
        pump: { id: row.stationId, number: 1 },
        fuelType: { id: 1, name: 'Fuel', code: 'TEST' },
      })),
  );
});
it('requires authentication and uses no-store on denial', async () => {
  const response = await get({}, false);
  expect(response.status).toBe(401);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(db.$transaction).not.toHaveBeenCalled();
});
it.each(['ADMIN', 'HR', 'MANAGER', 'SECURITY', 'CUSTOMER'])(
  'denies %s with orders.read',
  async (value) => {
    role = value;
    expect((await get()).status).toBe(403);
    expect(db.$transaction).not.toHaveBeenCalled();
  },
);
it('requires orders.read independently of attendance/shifts permissions', async () => {
  permissions = ['attendance.read', 'shifts.read'];
  expect((await get()).status).toBe(403);
  expect(db.$transaction).not.toHaveBeenCalled();
});
it('returns pending persisted rows oldest-first with safe fields and consistent totals', async () => {
  const response = await get();
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).toMatchObject({
    dataSource: 'database',
    stationId: 10,
    pagination: { page: 1, limit: 20, total: 3, totalPages: 1 },
  });
  expect(response.body.orders.map((row: Row) => row.id)).toEqual([1, 2, 3]);
  const options = db.fuelOrder.findMany.mock.calls[0][0];
  expect(options.where).toEqual({
    stationId: 10,
    status: 'PENDING',
    assignedEmployeeId: null,
  });
  expect(options.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
  expect(Object.keys(options.select).sort()).toEqual([
    'createdAt',
    'fuelType',
    'id',
    'orderedVolume',
    'pump',
    'status',
  ]);
  expect(response.text).not.toMatch(
    /customer|contact|private|Amount|Price|currency|phone|email|notes|payment/,
  );
  expect(db.fuelOrder.count).toHaveBeenCalledWith({ where: options.where });
  expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: 'RepeatableRead',
  });
});
it('accepts explicit PENDING and makes non-pending updates disappear on the next read', async () => {
  expect((await get({ status: 'PENDING' })).body.pagination.total).toBe(3);
  rows[0].status = 'IN_PROGRESS';
  rows[1].status = 'COMPLETED';
  const response = await get();
  expect(response.body.orders.map((row: Row) => row.id)).toEqual([2]);
  expect(response.body.pagination.total).toBe(1);
});

it('omits assigned pending legacy rows from both the queue and its total without changing them', async () => {
  rows[0].assignedEmployeeId = 9;
  const response = await get();
  expect(response.status).toBe(200);
  expect(response.body.orders.map((row: Row) => row.id)).toEqual([1, 2]);
  expect(response.body.pagination.total).toBe(2);
  expect(rows[0]).toMatchObject({ status: 'PENDING', assignedEmployeeId: 9 });
});
it('derives station from fresh transactional assignment rather than the authenticated profile', async () => {
  db.$transaction.mockImplementationOnce(
    (work: (tx: typeof db) => Promise<unknown>) => {
      assignment = 20;
      return work(db);
    },
  );
  const response = await get();
  expect(response.body.stationId).toBe(20);
  expect(response.body.orders.map((row: Row) => row.id)).toEqual([4]);
});
it('does not cache station data between assignment changes', async () => {
  expect((await get()).body.stationId).toBe(10);
  assignment = 20;
  expect((await get()).body.orders.map((row: Row) => row.id)).toEqual([4]);
});
it('returns the same station orders for two employees regardless of identity', async () => {
  const first = await get();
  actorId = 4;
  expect((await get()).body).toEqual(first.body);
});
it.each(['missing', 'inactive'])(
  'returns clear 409 for %s assignment without reading orders',
  async (kind) => {
    if (kind === 'missing') assignment = null;
    else stationActive = false;
    const response = await get();
    expect(response.status).toBe(409);
    expect(response.body.message).toMatch(
      /assigned station|station is inactive/,
    );
    expect(db.fuelOrder.findMany).not.toHaveBeenCalled();
    expect(db.fuelOrder.count).not.toHaveBeenCalled();
  },
);
it('rechecks role and active status inside the transaction', async () => {
  db.$transaction.mockImplementationOnce(
    (work: (tx: typeof db) => Promise<unknown>) => {
      role = 'CUSTOMER';
      return work(db);
    },
  );
  expect((await get()).status).toBe(403);
  role = 'EMPLOYEE';
  db.$transaction.mockImplementationOnce(
    (work: (tx: typeof db) => Promise<unknown>) => {
      active = false;
      return work(db);
    },
  );
  expect((await get()).status).toBe(401);
  expect(db.fuelOrder.findMany).not.toHaveBeenCalled();
});
it('paginates after filtering and returns correct totals on empty pages', async () => {
  const ids: number[] = [];
  for (let page = 1; page <= 2; page++) {
    const response = await get({ page, limit: 2 });
    ids.push(...response.body.orders.map((row: Row) => row.id));
    expect(response.body.pagination).toEqual({
      page,
      limit: 2,
      total: 3,
      totalPages: 2,
    });
  }
  expect(ids).toEqual([1, 2, 3]);
  expect((await get({ page: 1000000, limit: 100 })).body).toMatchObject({
    orders: [],
    pagination: { total: 3, totalPages: 1 },
  });
  assignment = 30;
  expect((await get()).body).toMatchObject({
    orders: [],
    pagination: { total: 0, totalPages: 0 },
  });
});
it.each([
  { status: 'COMPLETED' },
  { status: 'CANCELLED' },
  { status: 'IN_PROGRESS' },
  { status: 'pending' },
  { status: '' },
  { stationId: 20 },
  { employeeId: 4 },
  { from: '2026-11-21T00:00:00Z' },
  { unknown: 1 },
  { page: 0 },
  { page: 1000001 },
  { page: 1.5 },
  { limit: 0 },
  { limit: 101 },
  { limit: '1e2' },
])('rejects unsupported filters/status/pagination %j', async (query) => {
  const response = await get(query);
  expect(response.status).toBe(400);
  expect(response.body).toEqual({ message: 'Invalid request' });
  expect(db.$transaction).not.toHaveBeenCalled();
});
it.each(['status=PENDING&status=PENDING', 'page=1&page=2', 'limit=1&limit=2'])(
  'rejects repeated parameters %s',
  async (query) => {
    expect((await get({}, true, `${base}?${query}`)).status).toBe(400);
  },
);

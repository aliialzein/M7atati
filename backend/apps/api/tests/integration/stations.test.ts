import request from 'supertest';
import { app } from '../../src/app.js';
import { prisma } from '../../src/database/prisma.js';
import { ACCESS_COOKIE } from '../../src/modules/auth/auth.types.js';
import { tokenService } from '../../src/modules/auth/token.service.js';
import { coordinatesSchema } from '../../src/modules/stations/stations.validation.js';

// HTTP/application integration only: no PostgreSQL connection or FK/isolation claims.
jest.mock('../../src/database/prisma.js', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    station: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    fuelOrder: { findFirst: jest.fn() },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  },
}));
jest.mock('../../src/utils/logger.js', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

type Row = {
  id: number;
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  isActive: boolean;
  managerId: number | null;
  createdAt: Date;
  deviceKeyHash: string;
  users: { id: number; isActive: boolean }[];
  orders: { id: number }[];
};
type Where = {
  isActive?: boolean;
  OR?: { name?: { contains: string }; address?: { contains: string } }[];
};
type FindMany = {
  where: Where;
  skip?: number;
  take?: number;
  orderBy: unknown;
  select: object;
};
type Database = {
  user: { findUnique: jest.Mock };
  station: {
    findFirst: jest.Mock;
    findUnique: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  fuelOrder: { findFirst: jest.Mock };
  $queryRaw: jest.Mock;
  $transaction: jest.Mock;
};
const db = prisma as unknown as Database;
let rows: Row[];
let role: string;
let permissions: string[];
let candidates: Map<number, { role: string; active: boolean }>;
let orders: {
  id: number;
  stationId: number;
  status: string;
  pumpId?: number | null;
  payments?: { id: number; status: string; capturedMinor: number }[];
}[];
const grants = ['stations.read', 'stations.create', 'stations.update'];
function row(id: number, name: string, isActive = true): Row {
  return {
    id,
    name,
    address: `Road ${id}`,
    latitude: null,
    longitude: null,
    isActive,
    managerId: id === 1 ? 20 : null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    deviceKeyHash: 'device-value-must-never-leak',
    users: [{ id: 9, isActive: true }],
    orders: [{ id: 50 }],
  };
}
function matches(station: Row, where: Where) {
  return (
    (where.isActive === undefined || station.isActive === where.isActive) &&
    (!where.OR ||
      where.OR.some(
        (part) =>
          (part.name &&
            station.name
              .toLowerCase()
              .includes(part.name.contains.toLowerCase())) ||
          (part.address &&
            station.address
              ?.toLowerCase()
              .includes(part.address.contains.toLowerCase())),
      ))
  );
}
function call(
  method: 'get' | 'post' | 'patch',
  path = '',
  body?: object,
  authenticated = true,
) {
  const client = request(app);
  const pending = client[method](`/api/stations${path}`)
    .set('Origin', 'http://localhost:3000')
    .set('X-CSRF-Protection', '1');
  if (authenticated)
    pending.set(
      'Cookie',
      `${ACCESS_COOKIE}=${tokenService.issue(1).accessToken}`,
    );
  if (body !== undefined) pending.send(body);
  return pending;
}
beforeEach(() => {
  jest.resetAllMocks();
  role = 'ADMIN';
  permissions = [...grants];
  candidates = new Map([
    [20, { role: 'MANAGER', active: true }],
    [21, { role: 'MANAGER', active: true }],
    [22, { role: 'MANAGER', active: false }],
    [23, { role: 'EMPLOYEE', active: true }],
  ]);
  rows = [row(3, 'Beta'), row(2, 'Alpha', false), row(1, 'Alpha')];
  orders = [];
  db.$queryRaw.mockResolvedValue([]);
  db.fuelOrder.findFirst.mockImplementation(
    async ({ where }) =>
      orders.find(
        (order) =>
          order.stationId === where.stationId &&
          where.OR.some(
            (condition: {
              status: string;
              payments?: {
                some: { status: string; capturedMinor: { gt: number } };
              };
            }) =>
              order.status === condition.status &&
              (!condition.payments ||
                order.payments?.some(
                  (payment) =>
                    payment.status === condition.payments!.some.status &&
                    payment.capturedMinor >
                      condition.payments!.some.capturedMinor.gt,
                )),
          ),
      ) ?? null,
  );
  db.user.findUnique.mockImplementation(async ({ where }) =>
    where.id !== 1
      ? candidates.has(where.id)
        ? {
            id: where.id,
            isActive: candidates.get(where.id)!.active,
            role: { name: candidates.get(where.id)!.role, permissions: [] },
          }
        : null
      : {
          id: 1,
          name: 'Actor',
          email: 'actor@example.com',
          passwordHash: 'unused',
          isActive: true,
          stationId: null,
          tokenVersion: 0,
          role: {
            name: role,
            permissions: permissions.map((key) => ({ permission: { key } })),
          },
        },
  );
  db.$transaction.mockImplementation(
    async (work: (tx: Database) => Promise<unknown>) => work(db),
  );
  db.station.findUnique.mockImplementation(
    async ({ where }: { where: { id: number } }) =>
      rows.find((r) => r.id === where.id) ?? null,
  );
  db.station.findFirst.mockImplementation(
    async ({ where }) =>
      rows.find((station) => station.managerId === where.managerId) ?? null,
  );
  db.station.findMany.mockImplementation(
    async ({ where, skip = 0, take }: FindMany) => {
      const result = rows
        .filter((r) => matches(r, where))
        .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
      return result.slice(skip, take === undefined ? undefined : skip + take);
    },
  );
  db.station.count.mockImplementation(
    async ({ where }: { where: Where }) =>
      rows.filter((r) => matches(r, where)).length,
  );
  db.station.create.mockImplementation(
    async ({ data }: { data: Partial<Row> }) => {
      const created = { ...row(4, 'New'), managerId: null, ...data };
      rows.push(created);
      return created;
    },
  );
  db.station.update.mockImplementation(
    async ({ where, data }: { where: { id: number }; data: Partial<Row> }) => {
      const station = rows.find((r) => r.id === where.id)!;
      if (
        data.managerId !== undefined &&
        data.managerId !== null &&
        rows.some(
          (other) =>
            other.id !== station.id && other.managerId === data.managerId,
        )
      )
        throw { code: 'P2002', meta: { target: ['manager_id'] } };
      Object.assign(station, data);
      return station;
    },
  );
});

const operations = [
  ['post', '', { name: 'New', address: 'Road' }, 'stations.create'],
  ['get', '', undefined, 'stations.read'],
  ['get', '/1', undefined, 'stations.read'],
  ['patch', '/1', { name: 'Changed' }, 'stations.update'],
  ['patch', '/1/status', { isActive: false }, 'stations.update'],
  ['patch', '/1/manager', { managerId: 21 }, 'stations.update'],
] as const;

describe('ADMIN manager assignment', () => {
  it('assigns, reassigns and unassigns without changing affiliation or other relationships', async () => {
    const before = structuredClone(rows.find((station) => station.id === 3)!);
    for (const managerId of [21, 20, null]) {
      if (managerId === 20)
        expect(
          (await call('patch', '/1/manager', { managerId: null })).status,
        ).toBe(200);
      const response = await call('patch', '/3/manager', { managerId });
      expect(response.status).toBe(200);
      expect(response.body.station).toEqual({
        id: 3,
        name: before.name,
        address: before.address,
        latitude: null,
        longitude: null,
        isActive: true,
        managerId,
        createdAt: before.createdAt.toISOString(),
      });
      expect(rows.find((station) => station.id === 3)).toEqual({
        ...before,
        managerId,
      });
    }
    expect(
      db.station.update.mock.calls.every(
        ([args]) => Object.keys(args.data).join() === 'managerId',
      ),
    ).toBe(true);
  });
  it.each([20, null])(
    'treats a repeated managerId %s as a no-op',
    async (managerId) => {
      const id = managerId === null ? 3 : 1;
      expect(
        (await call('patch', `/${id}/manager`, { managerId })).status,
      ).toBe(200);
      expect(db.station.update).not.toHaveBeenCalled();
    },
  );
  it('assigns to an inactive station without reactivating it', async () => {
    const result = await call('patch', '/2/manager', { managerId: 21 });
    expect(result.status).toBe(200);
    expect(result.body.station).toMatchObject({
      isActive: false,
      managerId: 21,
    });
  });
  it.each([22, 23])(
    'rejects ineligible manager %s without changing ownership',
    async (managerId) => {
      const before = structuredClone(rows);
      const response = await call('patch', '/1/manager', { managerId });
      expect(response.status).toBe(409);
      expect(response.body.message).toBe('User must be an active MANAGER');
      expect(rows).toEqual(before);
    },
  );
  it('requires explicit unassignment before moving a manager', async () => {
    const before = structuredClone(rows);
    expect((await call('patch', '/3/manager', { managerId: 20 })).status).toBe(
      409,
    );
    expect(rows).toEqual(before);
    expect(
      (await call('patch', '/1/manager', { managerId: null })).status,
    ).toBe(200);
    expect((await call('patch', '/3/manager', { managerId: 20 })).status).toBe(
      200,
    );
  });
  it.each([
    {},
    { managerId: '21' },
    { managerId: 'manager-uuid' },
    { managerId: 0 },
    { managerId: -1 },
    { managerId: 1.5 },
    { managerId: 2147483648 },
    { managerId: true },
    { managerId: [] },
    { managerId: 21, isActive: true },
  ])('rejects malformed manager assignment %j', async (body) => {
    expect((await call('patch', '/3/manager', body)).status).toBe(400);
    expect(db.station.update).not.toHaveBeenCalled();
  });
  it('returns 404 for a missing station or manager', async () => {
    expect(
      (await call('patch', '/999/manager', { managerId: 21 })).status,
    ).toBe(404);
    expect((await call('patch', '/3/manager', { managerId: 999 })).status).toBe(
      404,
    );
    expect(db.station.update).not.toHaveBeenCalled();
  });
  it('preserves CSRF checks', async () => {
    expect(
      (
        await request(app)
          .patch('/api/stations/3/manager')
          .set(
            'Cookie',
            `${ACCESS_COOKIE}=${tokenService.issue(1).accessToken}`,
          )
          .send({ managerId: 21 })
      ).status,
    ).toBe(403);
  });
  it.each(['role', 'permission', 'active'])(
    'rechecks actor %s inside the transaction',
    async (change) => {
      const implementation = db.user.findUnique.getMockImplementation()!;
      db.user.findUnique
        .mockImplementationOnce(implementation)
        .mockImplementationOnce((...args: unknown[]) => {
          if (change === 'role') role = 'MANAGER';
          if (change === 'permission') permissions = [];
          if (change === 'active') return { id: 1, isActive: false };
          return implementation(...args);
        });
      expect(
        (await call('patch', '/3/manager', { managerId: 21 })).status,
      ).toBe(change === 'active' ? 401 : 403);
      expect(db.station.update).not.toHaveBeenCalled();
    },
  );
  it('maps the database uniqueness race to 409', async () => {
    db.station.update.mockRejectedValueOnce({
      code: 'P2002',
      meta: { target: ['manager_id'] },
    });
    const response = await call('patch', '/3/manager', { managerId: 21 });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      message: 'Manager already owns another station',
    });
  });
  it.each([
    { code: '40001' },
    { driverAdapterError: { cause: { originalCode: '40001' } } },
  ])(
    'retries raw-lock serialization failures and bounds retries: %j',
    async (meta) => {
      db.$transaction.mockRejectedValueOnce({ code: 'P2010', meta });
      expect(
        (await call('patch', '/3/manager', { managerId: 21 })).status,
      ).toBe(200);
      expect(db.$transaction).toHaveBeenCalledTimes(2);

      db.$transaction.mockClear();
      db.$transaction.mockRejectedValue({ code: 'P2010', meta });
      expect(
        (await call('patch', '/3/manager', { managerId: 21 })).status,
      ).toBe(409);
      expect(db.$transaction).toHaveBeenCalledTimes(3);
    },
  );
  it('does not retry unrelated raw SQL errors', async () => {
    db.$transaction.mockRejectedValue({
      code: 'P2010',
      meta: { driverAdapterError: { cause: { originalCode: '42501' } } },
    });
    expect((await call('patch', '/3/manager', { managerId: 21 })).status).toBe(
      500,
    );
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });
  it('allows only one conflicting assignment in the mock constraint protocol', async () => {
    const results = await Promise.all([
      call('patch', '/2/manager', { managerId: 21 }),
      call('patch', '/3/manager', { managerId: 21 }),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    expect(rows.filter((station) => station.managerId === 21)).toHaveLength(1);
  });
  it('locks the candidate before the station and retains ownership on station deactivation', async () => {
    expect((await call('patch', '/3/manager', { managerId: 21 })).status).toBe(
      200,
    );
    const locks = db.$queryRaw.mock.calls.map(([sql]) =>
      (sql as TemplateStringsArray).join(''),
    );
    expect(locks[0]).toContain('FROM users');
    expect(locks[1]).toContain('FROM stations');
    expect((await call('patch', '/3/status', { isActive: false })).status).toBe(
      200,
    );
    expect(rows.find((station) => station.id === 3)!.managerId).toBe(21);
  });
});

describe('station access controls', () => {
  it.each(operations)(
    'requires authentication for %s %s',
    async (method, path, body) => {
      expect((await call(method, path, body, false)).status).toBe(401);
      expect(db.station.update).not.toHaveBeenCalled();
    },
  );
  it.each(['MANAGER', 'EMPLOYEE', 'HR', 'SECURITY', 'CUSTOMER'])(
    'denies %s even with every station permission',
    async (actorRole) => {
      role = actorRole;
      for (const [method, path, body] of operations)
        expect((await call(method, path, body)).status).toBe(403);
      expect(db.station.findMany).not.toHaveBeenCalled();
      expect(db.station.create).not.toHaveBeenCalled();
      expect(db.station.update).not.toHaveBeenCalled();
    },
  );
  it.each(operations)(
    'requires the applicable permission for %s %s',
    async (method, path, body, permission) => {
      permissions = grants.filter((key) => key !== permission);
      expect((await call(method, path, body)).status).toBe(403);
    },
  );
  it.each(operations.filter(([method]) => method !== 'get'))(
    'retains CSRF checks on %s %s',
    async (method, path, body) => {
      const client = request(app);
      const response = await client[method](`/api/stations${path}`)
        .set('Cookie', `${ACCESS_COOKIE}=${tokenService.issue(1).accessToken}`)
        .send(body);
      expect(response.status).toBe(403);
      expect(db.station.create).not.toHaveBeenCalled();
      expect(db.station.update).not.toHaveBeenCalled();
    },
  );
});

describe('station management and picker contracts', () => {
  it('creates an active station with trimmed fields and no manager, without name uniqueness', async () => {
    const response = await call('post', '', {
      name: ' Alpha ',
      address: ' Main Road ',
      latitude: 90,
      longitude: -180,
    });
    expect(response.status).toBe(201);
    expect(response.body.station).toMatchObject({
      name: 'Alpha',
      address: 'Main Road',
      isActive: true,
      managerId: null,
      latitude: 90,
      longitude: -180,
    });
    expect(db.station.create.mock.calls[0][0].data).toEqual({
      name: 'Alpha',
      address: 'Main Road',
      latitude: 90,
      longitude: -180,
    });
    expect(response.text).not.toMatch(/deviceKeyHash|device-value|password/);
  });
  it('creates without coordinates and returns safe selected fields', async () => {
    const response = await call('post', '', { name: 'New', address: 'Road' });
    expect(response.status).toBe(201);
    expect(response.body.station).toMatchObject({
      latitude: null,
      longitude: null,
    });
    expect(db.station.create.mock.calls[0][0].select).not.toHaveProperty(
      'deviceKeyHash',
    );
  });
  it('accepts lower/upper coordinate boundaries and an explicitly absent pair', async () => {
    for (const coordinates of [
      { latitude: -90, longitude: 180 },
      { latitude: null, longitude: null },
    ]) {
      const response = await call('post', '', {
        name: 'Boundary',
        address: 'Road',
        ...coordinates,
      });
      expect(response.status).toBe(201);
      expect(response.body.station).toMatchObject(coordinates);
    }
  });
  it('has no hard-delete endpoint', async () => {
    const response = await request(app)
      .delete('/api/stations/1')
      .set('Cookie', `${ACCESS_COOKIE}=${tokenService.issue(1).accessToken}`)
      .set('Origin', 'http://localhost:3000')
      .set('X-CSRF-Protection', '1');
    expect(response.status).toBe(404);
    expect(rows).toHaveLength(3);
  });
  it('lists deterministically, paginates, and exposes inactive details safely', async () => {
    const response = await call('get', '?page=1&limit=2');
    expect(response.body.stations.map((s: { id: number }) => s.id)).toEqual([
      1, 2,
    ]);
    expect(response.body.pagination).toEqual({
      page: 1,
      limit: 2,
      total: 3,
      totalPages: 2,
    });
    expect(db.station.findMany.mock.calls[0][0]).toMatchObject({
      skip: 0,
      take: 2,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    expect(
      (await call('get', '?page=2&limit=2')).body.stations.map(
        (s: { id: number }) => s.id,
      ),
    ).toEqual([3]);
    const detail = await call('get', '/2');
    expect(detail.status).toBe(200);
    expect(detail.body.station.isActive).toBe(false);
    expect(detail.text + response.text).not.toMatch(
      /deviceKeyHash|device-value|"users"|"orders"/,
    );
  });
  it('combines case-insensitive name/address search and explicit false filtering', async () => {
    const response = await call('get', '?search=ALPHA&isActive=false');
    expect(response.body.stations.map((s: { id: number }) => s.id)).toEqual([
      2,
    ]);
    expect(db.station.findMany.mock.calls[0][0].where).toEqual({
      isActive: false,
      OR: [
        { name: { contains: 'ALPHA', mode: 'insensitive' } },
        { address: { contains: 'ALPHA', mode: 'insensitive' } },
      ],
    });
    expect(
      (await call('get', '?search=ROAD%203&isActive=true')).body.stations.map(
        (s: { id: number }) => s.id,
      ),
    ).toEqual([3]);
    expect(
      (await call('get', '?search=missing')).body.pagination.totalPages,
    ).toBe(0);
  });
  it('serves a minimal active-only public picker before /:id', async () => {
    rows[2].address = null;
    const response = await call('get', '/picker', undefined, false);
    expect(response.status).toBe(200);
    expect(response.body.stations.map((s: { id: number }) => s.id)).toEqual([
      1, 3,
    ]);
    for (const station of response.body.stations)
      expect(Object.keys(station).sort()).toEqual([
        'address',
        'id',
        'latitude',
        'longitude',
        'name',
      ]);
    expect(response.body.stations[0].address).toBeNull();
    expect(db.user.findUnique).not.toHaveBeenCalled();
    expect(db.station.findMany.mock.calls[0][0]).toMatchObject({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        address: true,
        latitude: true,
        longitude: true,
      },
    });
    expect(response.text).not.toMatch(
      /device-value|managerId|isActive|createdAt/,
    );
  });
  it('updates stored coordinate pairs and explicitly clears them', async () => {
    expect((await call('patch', '/1', { latitude: 33 })).status).toBe(400);
    expect(
      (await call('patch', '/1', { latitude: 33, longitude: 35 })).status,
    ).toBe(200);
    const changed = await call('patch', '/1', {
      latitude: 34,
      name: ' Renamed ',
      address: ' New Road ',
    });
    expect(changed.body.station).toMatchObject({
      latitude: 34,
      longitude: 35,
      name: 'Renamed',
      address: 'New Road',
    });
    expect((await call('patch', '/1', { longitude: null })).status).toBe(400);
    expect(
      (await call('patch', '/1', { latitude: null, longitude: null })).body
        .station,
    ).toMatchObject({ latitude: null, longitude: null });
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
  });
  it('validates legacy stored coordinates when merging updates', async () => {
    rows[2].latitude = 33;
    expect((await call('patch', '/1', { name: 'Changed' })).status).toBe(400);
    expect((await call('patch', '/1', { longitude: 35 })).status).toBe(200);
    rows[2].latitude = 100;
    expect((await call('patch', '/1', { name: 'Changed' })).status).toBe(400);
    expect(
      (await call('patch', '/1', { latitude: null, longitude: null })).status,
    ).toBe(200);
  });
  it('keeps legacy null addresses manageable without inventing one', async () => {
    rows[2].address = null;
    expect((await call('get', '/1')).body.station.address).toBeNull();
    expect(
      (await call('patch', '/1', { name: 'Legacy' })).body.station.address,
    ).toBeNull();
    expect((await call('patch', '/1/status', { isActive: false })).status).toBe(
      200,
    );
    expect((await call('patch', '/1', { address: ' ' })).status).toBe(400);
    expect(
      (await call('patch', '/1', { address: 'Provided' })).body.station.address,
    ).toBe('Provided');
  });
  it('deactivates/reactivates, with repeated status as a no-op and untouched relationships in emitted writes', async () => {
    const before = structuredClone(rows[2]);
    for (const isActive of [true, false, false, true, true]) {
      const response = await call('patch', '/1/status', { isActive });
      expect(response.status).toBe(200);
      expect(response.body.station.isActive).toBe(isActive);
    }
    expect(db.station.update.mock.calls.map(([args]) => args.data)).toEqual([
      { isActive: false },
      { isActive: true },
    ]);
    expect(rows[2]).toEqual(before);
    // This proves application writes only; real FK retention is not tested by this double.
  });
  it.each(['get', 'patch', 'status'] as const)(
    'returns 404 for missing station: %s',
    async (operation) => {
      expect(
        (
          await call(
            operation === 'get' ? 'get' : 'patch',
            operation === 'status' ? '/999/status' : '/999',
            operation === 'get'
              ? undefined
              : operation === 'status'
                ? { isActive: false }
                : { name: 'Changed' },
          )
        ).status,
      ).toBe(404);
    },
  );
  it('maps a raced-away update to 404 and bounds serialization retries', async () => {
    db.station.update.mockRejectedValueOnce({ code: 'P2025' });
    expect((await call('patch', '/1', { name: 'Changed' })).status).toBe(404);
    db.$transaction.mockRejectedValue({ code: 'P2034' });
    db.$transaction.mockClear();
    expect((await call('patch', '/1', { name: 'Changed' })).status).toBe(409);
    expect(db.$transaction).toHaveBeenCalledTimes(3);
  });
  it('re-reads the stored coordinates after a serialization conflict', async () => {
    rows[2].latitude = 33;
    rows[2].longitude = 35;
    db.station.update.mockImplementationOnce(async () => {
      rows[2].longitude = null;
      throw { code: 'P2034' };
    });
    expect((await call('patch', '/1', { latitude: 34 })).status).toBe(400);
    expect(db.station.findUnique).toHaveBeenCalledTimes(2);
  });
});

describe('station deactivation with claimed orders', () => {
  it('blocks paid PENDING orders and preserves station, payment and pump reservation data', async () => {
    orders.push({
      id: 90,
      stationId: 1,
      status: 'PENDING',
      pumpId: 7,
      payments: [{ id: 70, status: 'CONFIRMED', capturedMinor: 1250 }],
    });
    const before = structuredClone({ rows, orders });
    for (let retry = 0; retry < 2; retry++) {
      const response = await call('patch', '/1/status', { isActive: false });
      expect(response.status).toBe(409);
      expect(response.body.message).toMatch(/active orders/);
    }
    expect({ rows, orders }).toEqual(before);
    expect(db.station.update).not.toHaveBeenCalled();
    expect(db.fuelOrder.findFirst).toHaveBeenCalledWith({
      where: {
        stationId: 1,
        OR: [
          { status: 'IN_PROGRESS' },
          {
            status: 'PENDING',
            payments: {
              some: { status: 'CONFIRMED', capturedMinor: { gt: 0 } },
            },
          },
        ],
      },
      select: { id: true },
    });
  });

  it.each(['AWAITING_PAYMENT', 'COMPLETED', 'CANCELLED'])(
    'does not block %s history even when a payment is present',
    async (status) => {
      orders.push({
        id: 90,
        stationId: 1,
        status,
        pumpId: 7,
        payments: [{ id: 70, status: 'CONFIRMED', capturedMinor: 1250 }],
      });
      const before = structuredClone(orders);
      expect(
        (await call('patch', '/1/status', { isActive: false })).status,
      ).toBe(200);
      expect(orders).toEqual(before);
    },
  );

  it.each([
    { status: 'PENDING', capturedMinor: 0 },
    { status: 'FAILED', capturedMinor: 0 },
    { status: 'CONFIRMED', capturedMinor: 0 },
  ])(
    'does not treat an unpaid payment attempt as paid: %j',
    async (payment) => {
      orders.push({
        id: 90,
        stationId: 1,
        status: 'PENDING',
        payments: [{ id: 70, ...payment }],
      });
      expect(
        (await call('patch', '/1/status', { isActive: false })).status,
      ).toBe(200);
    },
  );

  it('ignores paid pending orders belonging to another station', async () => {
    orders.push({
      id: 90,
      stationId: 3,
      status: 'PENDING',
      payments: [{ id: 70, status: 'CONFIRMED', capturedMinor: 1250 }],
    });
    expect((await call('patch', '/1/status', { isActive: false })).status).toBe(
      200,
    );
  });

  it('rechecks newly paid pending work on a serialization retry', async () => {
    db.$transaction.mockImplementationOnce(async () => {
      orders.push({
        id: 90,
        stationId: 1,
        status: 'PENDING',
        pumpId: 7,
        payments: [{ id: 70, status: 'CONFIRMED', capturedMinor: 1250 }],
      });
      throw { code: 'P2034' };
    });
    expect((await call('patch', '/1/status', { isActive: false })).status).toBe(
      409,
    );
    expect(rows.find((station) => station.id === 1)!.isActive).toBe(true);
    expect(db.station.update).not.toHaveBeenCalled();
  });

  it('rejects deactivation with active station work and preserves every relationship', async () => {
    orders.push({ id: 90, stationId: 1, status: 'IN_PROGRESS' });
    const before = structuredClone(rows);
    const response = await call('patch', '/1/status', { isActive: false });
    expect(response.status).toBe(409);
    expect(response.body.message).toMatch(/active orders/);
    expect(rows).toEqual(before);
    expect(orders).toEqual([{ id: 90, stationId: 1, status: 'IN_PROGRESS' }]);
    expect(db.station.update).not.toHaveBeenCalled();
  });

  it.each(['PENDING', 'COMPLETED', 'CANCELLED'])(
    'allows deactivation and an identical retry with only %s orders',
    async (status) => {
      orders.push({ id: 90, stationId: 1, status });
      const first = await call('patch', '/1/status', { isActive: false });
      const retry = await call('patch', '/1/status', { isActive: false });
      expect(first.status).toBe(200);
      expect(retry.status).toBe(200);
      expect(retry.body).toEqual(first.body);
      expect(db.station.update).toHaveBeenCalledTimes(1);
      expect(orders[0].status).toBe(status);
    },
  );

  it('ignores active work at another station', async () => {
    orders.push({ id: 90, stationId: 3, status: 'IN_PROGRESS' });
    expect((await call('patch', '/1/status', { isActive: false })).status).toBe(
      200,
    );
  });

  it('allows reactivation of an inactive legacy station with active work', async () => {
    orders.push({ id: 90, stationId: 2, status: 'IN_PROGRESS' });
    expect((await call('patch', '/2/status', { isActive: false })).status).toBe(
      409,
    );
    expect((await call('patch', '/2/status', { isActive: true })).status).toBe(
      200,
    );
    expect((await call('patch', '/2/status', { isActive: true })).status).toBe(
      200,
    );
    expect(orders[0].status).toBe('IN_PROGRESS');
    expect(db.station.update).toHaveBeenCalledTimes(1);
  });

  it('permits deactivation after completion without changing the order', async () => {
    orders.push({ id: 90, stationId: 1, status: 'IN_PROGRESS' });
    expect((await call('patch', '/1/status', { isActive: false })).status).toBe(
      409,
    );
    orders[0].status = 'COMPLETED';
    expect((await call('patch', '/1/status', { isActive: false })).status).toBe(
      200,
    );
    expect(orders[0].status).toBe('COMPLETED');
  });

  it('rechecks active work on a fresh transaction after a serialization conflict', async () => {
    db.$transaction.mockImplementationOnce(async () => {
      orders.push({ id: 90, stationId: 1, status: 'IN_PROGRESS' });
      throw { code: 'P2034' };
    });
    expect((await call('patch', '/1/status', { isActive: false })).status).toBe(
      409,
    );
    expect(db.station.update).not.toHaveBeenCalled();
    expect(rows.find((station) => station.id === 1)!.isActive).toBe(true);
  });
});

describe('strict station validation', () => {
  it.each(['0', '-1', '1e3', '2147483648', 'abc', '01'])(
    'rejects invalid IDs: %s',
    async (id) => {
      for (const [method, suffix, body] of [
        ['get', '', undefined],
        ['patch', '', { name: 'Changed' }],
        ['patch', '/status', { isActive: false }],
      ] as const)
        expect((await call(method, `/${id}${suffix}`, body)).status).toBe(400);
    },
  );
  it.each([
    {},
    { name: ' ', address: 'Road' },
    { name: 'Name', address: ' ' },
    { name: 'Name' },
    { name: 'Name', address: null },
    { name: 'x'.repeat(129), address: 'Road' },
    { name: 'Name', address: 'x'.repeat(513) },
    { name: 'Name', address: 'Road', latitude: 91, longitude: 0 },
    { name: 'Name', address: 'Road', latitude: -91, longitude: 0 },
    { name: 'Name', address: 'Road', latitude: 0, longitude: 181 },
    { name: 'Name', address: 'Road', latitude: 0, longitude: -181 },
    { name: 'Name', address: 'Road', latitude: 0 },
    { name: 'Name', address: 'Road', longitude: 0 },
    { name: 'Name', address: 'Road', latitude: '33', longitude: 35 },
    ...['managerId', 'deviceKeyHash', 'isActive', 'unknown'].map((key) => ({
      name: 'Name',
      address: 'Road',
      [key]: 1,
    })),
  ])('rejects invalid creation input %#', async (body) => {
    expect((await call('post', '', body)).status).toBe(400);
    expect(db.station.create).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { name: ' ' },
    { address: '' },
    { address: null },
    { latitude: 91 },
    { longitude: -181 },
    { managerId: 1 },
    { deviceKeyHash: 'no' },
    { isActive: false },
    { unknown: true },
    { name: 'x'.repeat(129) },
    { address: 'x'.repeat(513) },
  ])('rejects invalid general PATCH %#', async (body) => {
    expect((await call('patch', '/1', body)).status).toBe(400);
    expect(db.station.update).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { isActive: 'false' },
    { isActive: null },
    { isActive: false, name: 'Changed' },
  ])('rejects invalid status PATCH %#', async (body) => {
    expect((await call('patch', '/1/status', body)).status).toBe(400);
  });
  it.each([
    '?isActive=0',
    '?isActive=False',
    '?isActive=true&isActive=false',
    '?page=0',
    '?limit=101',
    '?search=',
    '?unknown=1',
  ])('rejects invalid list query %s', async (query) => {
    expect((await call('get', query)).status).toBe(400);
  });
  it.each([NaN, Infinity, -Infinity])(
    'rejects nonfinite coordinates before database access: %s',
    (value) => {
      expect(
        coordinatesSchema.safeParse({ latitude: value, longitude: 0 }).success,
      ).toBe(false);
      expect(
        coordinatesSchema.safeParse({ latitude: 0, longitude: value }).success,
      ).toBe(false);
    },
  );
});

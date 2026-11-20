import request from 'supertest';

import { app } from '../../src/app.js';
import { prisma } from '../../src/database/prisma.js';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
} from '../../src/modules/auth/auth.types.js';
import { passwordService } from '../../src/modules/auth/password.service.js';
import { tokenService } from '../../src/modules/auth/token.service.js';
import type { UserRecord } from '../../src/modules/users/users.types.js';

jest.mock('../../src/database/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    role: { findUnique: jest.fn() },
    station: { findFirst: jest.fn(), count: jest.fn() },
    refreshSession: { updateMany: jest.fn(), findUnique: jest.fn() },
    attendanceRecord: { findFirst: jest.fn() },
    shift: { findFirst: jest.fn() },
    $transaction: jest.fn(),
  },
}));
jest.mock('../../src/utils/logger.js', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

type MockDatabase = {
  user: {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  role: { findUnique: jest.Mock };
  station: { findFirst: jest.Mock; count: jest.Mock };
  refreshSession: { updateMany: jest.Mock; findUnique: jest.Mock };
  attendanceRecord: { findFirst: jest.Mock };
  shift: { findFirst: jest.Mock };
  $transaction: jest.Mock;
};
const db = prisma as unknown as MockDatabase;
type StoredUser = UserRecord & { passwordHash: string; tokenVersion: number };
type Where = {
  id?: number;
  AND?: Where[];
  OR?: Where[];
  role?: { name: string };
  station?: { is: { managerId: number } };
  stationId?: number;
  isActive?: boolean;
  name?: { contains: string };
  email?: { contains: string };
};
const roleIds: Record<string, number> = {
  ADMIN: 1,
  MANAGER: 2,
  EMPLOYEE: 3,
  HR: 4,
  SECURITY: 5,
  CUSTOMER: 6,
};
let users: Map<number, StoredUser>;
let sessions: { userId: number; revokedAt: Date | null }[];
let permissions: string[];
let shiftRecords: {
  id: number;
  employeeId: number;
  stationId: number;
  endsAt: Date;
}[];
let attendanceRecords: {
  id: number;
  employeeId: number;
  stationId: number;
  clockOutAt: Date | null;
}[];
const stations = new Map([
  [10, { id: 10, managerId: 2, isActive: true }],
  [20, { id: 20, managerId: 9, isActive: true }],
]);
const staffInput = {
  name: ' New Employee ',
  email: ' NEW@Example.com ',
  password: 'Strong-password!123',
  role: 'EMPLOYEE',
  stationId: 10,
};

function user(
  id: number,
  role: string,
  stationId: number | null = null,
): StoredUser {
  return {
    id,
    name: `User ${id}`,
    email: `user${id}@example.com`,
    passwordHash: 'private-hash',
    role: { name: role },
    stationId,
    isActive: true,
    tokenVersion: 0,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

// Minimal database double: exercise the actual repository's filters and pagination.
function matches(row: StoredUser, where: Where): boolean {
  return (
    (!where.AND || where.AND.every((part) => matches(row, part))) &&
    (!where.OR || where.OR.some((part) => matches(row, part))) &&
    (where.id === undefined || row.id === where.id) &&
    (!where.role || row.role.name === where.role.name) &&
    (!where.station ||
      (row.stationId !== null &&
        stations.get(row.stationId)?.managerId ===
          where.station.is.managerId)) &&
    (where.stationId === undefined || row.stationId === where.stationId) &&
    (where.isActive === undefined || row.isActive === where.isActive) &&
    (!where.name ||
      row.name.toLowerCase().includes(where.name.contains.toLowerCase())) &&
    (!where.email ||
      row.email.toLowerCase().includes(where.email.contains.toLowerCase()))
  );
}

function authenticated(
  method: 'get' | 'post' | 'patch',
  path = '',
  actorId = 1,
) {
  const client = request(app);
  return client[method](`/api/users${path}`)
    .set(
      'Cookie',
      `${ACCESS_COOKIE}=${tokenService.issue(actorId).accessToken}`,
    )
    .set('Origin', 'http://localhost:3000')
    .set('X-CSRF-Protection', '1');
}

beforeEach(() => {
  stations.get(10)!.isActive = true;
  stations.get(20)!.isActive = true;
  stations.get(20)!.managerId = 9;
  jest.resetAllMocks();
  users = new Map([
    [1, user(1, 'ADMIN')],
    [2, user(2, 'MANAGER', 20)],
    [3, user(3, 'EMPLOYEE', 10)],
    [4, user(4, 'EMPLOYEE', 20)],
    [5, user(5, 'HR')],
    [6, user(6, 'ADMIN')],
    [7, user(7, 'SECURITY', 10)],
    [8, user(8, 'CUSTOMER')],
  ]);
  sessions = [
    { userId: 3, revokedAt: null },
    { userId: 3, revokedAt: null },
    { userId: 4, revokedAt: null },
  ];
  permissions = [
    'users.read',
    'users.create',
    'users.update',
    'employees.transfer',
  ];
  shiftRecords = [];
  attendanceRecords = [];
  db.shift.findFirst.mockImplementation(
    async ({
      where,
    }: {
      where: { employeeId: number; stationId: number; endsAt: { gt: Date } };
    }) =>
      shiftRecords.find(
        (row) =>
          row.employeeId === where.employeeId &&
          row.stationId === where.stationId &&
          row.endsAt > where.endsAt.gt,
      ) ?? null,
  );
  db.attendanceRecord.findFirst.mockImplementation(
    async ({
      where,
    }: {
      where: { employeeId: number; stationId: number; clockOutAt: null };
    }) =>
      attendanceRecords.find(
        (row) =>
          row.employeeId === where.employeeId &&
          row.stationId === where.stationId &&
          row.clockOutAt === where.clockOutAt,
      ) ?? null,
  );
  jest.spyOn(passwordService, 'hash').mockResolvedValue('new-private-hash');
  db.$transaction.mockImplementation(
    async (work: (tx: MockDatabase) => Promise<unknown>) => {
      const beforeUsers = structuredClone(users);
      const beforeSessions = structuredClone(sessions);
      try {
        return await work(db);
      } catch (error) {
        users = beforeUsers;
        sessions = beforeSessions;
        throw error;
      }
    },
  );
  db.user.findUnique.mockImplementation(
    ({ where }: { where: { id: number } }) => {
      const row = users.get(where.id);
      return Promise.resolve(
        row
          ? {
              ...row,
              role: {
                name: row.role.name,
                permissions: (['ADMIN', 'MANAGER', 'HR'].includes(row.role.name)
                  ? permissions
                  : []
                ).map((key) => ({ permission: { key } })),
              },
            }
          : null,
      );
    },
  );
  db.user.findFirst.mockImplementation(({ where }: { where: Where }) =>
    Promise.resolve(
      structuredClone(
        [...users.values()].find((row) => matches(row, where)) ?? null,
      ),
    ),
  );
  db.user.findMany.mockImplementation(
    ({ where, skip, take }: { where: Where; skip: number; take: number }) =>
      Promise.resolve(
        [...users.values()]
          .filter((row) => matches(row, where))
          .slice(skip, skip + take),
      ),
  );
  db.user.count.mockImplementation(({ where }: { where: Where }) =>
    Promise.resolve(
      [...users.values()].filter((row) => matches(row, where)).length,
    ),
  );
  db.role.findUnique.mockImplementation(
    ({ where }: { where: { name: string } }) =>
      Promise.resolve(roleIds[where.name] ? { id: roleIds[where.name] } : null),
  );
  db.station.findFirst.mockImplementation(
    ({
      where,
    }: {
      where: { AND: { id?: number; managerId?: number; isActive?: boolean }[] };
    }) =>
      Promise.resolve(
        [...stations.values()].find((station) =>
          where.AND.every(
            (part) =>
              (part.id === undefined || station.id === part.id) &&
              (part.managerId === undefined ||
                station.managerId === part.managerId) &&
              (part.isActive === undefined ||
                station.isActive === part.isActive),
          ),
        ) ?? null,
      ),
  );
  db.station.count.mockImplementation(
    ({ where }: { where: { managerId: number } }) =>
      Promise.resolve(
        [...stations.values()].filter(
          (station) => station.managerId === where.managerId,
        ).length,
      ),
  );
  db.user.create.mockImplementation(
    ({
      data,
    }: {
      data: {
        name: string;
        email: string;
        passwordHash: string;
        roleId: number;
        stationId: number | null;
      };
    }) => {
      if ([...users.values()].some((row) => row.email === data.email))
        return Promise.reject({ code: 'P2002' });
      const row = {
        ...user(
          100,
          Object.keys(roleIds).find((name) => roleIds[name] === data.roleId)!,
          data.stationId,
        ),
        name: data.name,
        email: data.email,
        passwordHash: data.passwordHash,
      };
      users.set(row.id, row);
      return Promise.resolve(row);
    },
  );
  db.user.update.mockImplementation(
    ({
      where,
      data,
    }: {
      where: { id: number };
      data: {
        name?: string;
        roleId?: number;
        stationId?: number | null;
        isActive?: boolean;
        tokenVersion?: { increment: number };
      };
    }) => {
      const row = users.get(where.id)!;
      if (data.name !== undefined) row.name = data.name;
      if (data.roleId !== undefined)
        row.role = {
          name: Object.keys(roleIds).find(
            (name) => roleIds[name] === data.roleId,
          )!,
        };
      if (data.stationId !== undefined) row.stationId = data.stationId;
      if (data.isActive !== undefined) row.isActive = data.isActive;
      if (data.tokenVersion) row.tokenVersion += data.tokenVersion.increment;
      return Promise.resolve(row);
    },
  );
  db.refreshSession.updateMany.mockImplementation(
    ({
      where,
      data,
    }: {
      where: { userId: number };
      data: { revokedAt: Date };
    }) => {
      const matching = sessions.filter(
        (session) => session.userId === where.userId && !session.revokedAt,
      );
      matching.forEach((session) => {
        session.revokedAt = data.revokedAt;
      });
      return Promise.resolve({ count: matching.length });
    },
  );
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('user endpoint authentication, RBAC, and CSRF', () => {
  it.each([
    ['get', ''],
    ['get', '/3'],
    ['post', ''],
    ['patch', '/3'],
    ['patch', '/3/status'],
  ] as const)('requires authentication for %s %s', async (method, path) => {
    const client = request(app);
    const response = await client[method](`/api/users${path}`)
      .set('Origin', 'http://localhost:3000')
      .set('X-CSRF-Protection', '1')
      .send({});
    expect(response.status).toBe(401);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['get', ''],
    ['get', '/3'],
    ['post', ''],
    ['patch', '/3'],
    ['patch', '/3/status'],
  ] as const)('requires permission for %s %s', async (method, path) => {
    permissions = [];
    expect((await authenticated(method, path).send({})).status).toBe(403);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('preserves CSRF protection on authenticated writes', async () => {
    const response = await request(app)
      .patch('/api/users/3/status')
      .set('Cookie', `${ACCESS_COOKIE}=${tokenService.issue(1).accessToken}`)
      .send({ isActive: false });
    expect(response.status).toBe(403);
    expect(db.user.update).not.toHaveBeenCalled();
  });
});

describe('listing and safe profiles', () => {
  it('paginates in the database and returns consistent totals and safe fields', async () => {
    const response = await authenticated('get', '?page=2&limit=3');
    expect(response.status).toBe(200);
    expect(response.body.pagination).toEqual({
      page: 2,
      limit: 3,
      total: 8,
      totalPages: 3,
    });
    expect(response.body.users.map((row: { id: number }) => row.id)).toEqual([
      4, 5, 6,
    ]);
    expect(db.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 3, take: 3, orderBy: { id: 'asc' } }),
    );
    expect(response.text).not.toMatch(/password|private-hash|tokenHash|roleId/);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('combines search and all filters before pagination', async () => {
    users.get(3)!.name = 'Alice';
    users.get(3)!.isActive = false;
    const response = await authenticated(
      'get',
      '?search=ALICE&role=EMPLOYEE&stationId=10&isActive=false',
    );
    expect(response.status).toBe(200);
    expect(response.body.users.map((row: { id: number }) => row.id)).toEqual([
      3,
    ]);
    expect(db.user.findMany.mock.calls[0][0].where.AND[1]).toMatchObject({
      role: { name: 'EMPLOYEE' },
      stationId: 10,
      isActive: false,
    });
    expect(db.user.findMany.mock.calls[0][0].where.AND[1].OR).toEqual([
      { name: { contains: 'ALICE', mode: 'insensitive' } },
      { email: { contains: 'ALICE', mode: 'insensitive' } },
    ]);
    const email = await authenticated('get', '?search=USER4@EXAMPLE.COM');
    expect(email.body.users.map((row: { id: number }) => row.id)).toEqual([4]);
  });

  it.each([
    '?page=0',
    '?limit=101',
    '?isActive=1',
    '?role=OWNER',
    '?stationId=1e3',
    '?page=1&page=2',
    '?unknown=true',
  ])('rejects invalid listing parameters %s', async (query) => {
    expect((await authenticated('get', query)).status).toBe(400);
    expect(db.user.findMany).not.toHaveBeenCalled();
  });

  it('returns a safe detail profile or 404 without exposing hidden data', async () => {
    const response = await authenticated('get', '/3');
    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({
      id: 3,
      role: 'EMPLOYEE',
      stationId: 10,
    });
    expect(response.text).not.toMatch(/password|private-hash/);
    expect((await authenticated('get', '/999')).status).toBe(404);
    expect((await authenticated('get', '/1e3')).status).toBe(400);
  });
});

describe('staff account creation', () => {
  it('allows ADMIN to create staff with shared validation and hashing', async () => {
    const response = await authenticated('post').send(staffInput);
    expect(response.status).toBe(201);
    expect(response.body.user).toMatchObject({
      name: 'New Employee',
      email: 'new@example.com',
      role: 'EMPLOYEE',
      isActive: true,
    });
    expect(passwordService.hash).toHaveBeenCalledWith(staffInput.password);
    expect(db.user.create.mock.calls[0][0].data).toEqual({
      name: 'New Employee',
      email: 'new@example.com',
      passwordHash: 'new-private-hash',
      roleId: 3,
      stationId: 10,
    });
    expect(response.text).not.toMatch(/password|private-hash/);
  });

  it('allows only ADMIN to create another ADMIN', async () => {
    expect(
      (
        await authenticated('post').send({
          ...staffInput,
          role: 'ADMIN',
          stationId: null,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await authenticated('post', '', 2).send({
          ...staffInput,
          role: 'ADMIN',
          stationId: null,
        })
      ).status,
    ).toBe(403);
  });

  it('handles normalized duplicate email conflicts safely', async () => {
    const response = await authenticated('post').send({
      ...staffInput,
      email: ' USER3@EXAMPLE.COM ',
    });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ message: 'Email already registered' });
  });

  it.each([
    { role: 'CUSTOMER', stationId: null },
    { role: 'OWNER' },
    { role: 'EMPLOYEE', stationId: null },
    { role: 'SECURITY', stationId: null },
    { role: 'ADMIN', stationId: 10 },
    { role: 'HR', stationId: 10 },
    { stationId: 999 },
    { password: 'weak' },
    { isActive: false },
    { roleId: 1 },
  ])(
    'rejects invalid staff assignments or arbitrary fields: %j',
    async (changes) => {
      expect(
        (await authenticated('post').send({ ...staffInput, ...changes }))
          .status,
      ).toBe(400);
      expect(db.user.create).not.toHaveBeenCalled();
    },
  );
});

describe('manager station boundaries', () => {
  it('uses Station.managerId rather than the manager assigned station', async () => {
    const response = await authenticated('get', '', 2);
    expect(response.status).toBe(200);
    expect(response.body.users.map((row: { id: number }) => row.id)).toEqual([
      3,
    ]);
    expect(db.user.findMany.mock.calls[0][0].where.AND[0]).toEqual({
      role: { name: 'EMPLOYEE' },
      station: { is: { managerId: 2 } },
    });
    expect((await authenticated('get', '?stationId=20', 2)).body.users).toEqual(
      [],
    );
    expect((await authenticated('get', '/4', 2)).status).toBe(404);
    expect((await authenticated('get', '/1', 2)).status).toBe(404);
  });

  it('allows manager EMPLOYEE creation within managed stations only', async () => {
    expect((await authenticated('post', '', 2).send(staffInput)).status).toBe(
      201,
    );
    expect(
      (
        await authenticated('post', '', 2).send({
          ...staffInput,
          stationId: 20,
        })
      ).status,
    ).toBe(400);
  });

  it.each(['ADMIN', 'MANAGER', 'HR', 'SECURITY'])(
    'prevents manager creation and assignment of %s',
    async (role) => {
      expect(
        (await authenticated('post', '', 2).send({ ...staffInput, role }))
          .status,
      ).toBe(403);
      expect(
        (await authenticated('patch', '/3', 2).send({ role })).status,
      ).toBe(403);
    },
  );

  it('prevents cross-station edits, deactivation, and reassignment', async () => {
    expect(
      (await authenticated('patch', '/4', 2).send({ name: 'Changed' })).status,
    ).toBe(404);
    expect(
      (await authenticated('patch', '/4/status', 2).send({ isActive: false }))
        .status,
    ).toBe(404);
    expect(
      (await authenticated('patch', '/3', 2).send({ stationId: 20 })).status,
    ).toBe(400);
    expect(
      (await authenticated('patch', '/3', 2).send({ name: 'Updated employee' }))
        .status,
    ).toBe(200);
  });
});

describe('HR employee registration and lookup', () => {
  it.each([10, 20])(
    'creates an employee at active station %i',
    async (stationId) => {
      const response = await authenticated('post', '', 5).send({
        ...staffInput,
        stationId,
      });
      expect(response.status).toBe(201);
      expect(response.body.user).toMatchObject({
        name: 'New Employee',
        email: 'new@example.com',
        role: 'EMPLOYEE',
        stationId,
        isActive: true,
      });
      expect(passwordService.hash).toHaveBeenCalledWith(staffInput.password);
      expect(db.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            passwordHash: 'new-private-hash',
            roleId: roleIds.EMPLOYEE,
            stationId,
          }),
        }),
      );
      expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: 'Serializable',
      });
      expect(response.text).not.toMatch(/password|private-hash|roleId|token/);
      expect(response.headers['cache-control']).toBe('no-store');
    },
  );

  it.each([null, 10])(
    'finds employees across stations with HR station %s',
    async (stationId) => {
      users.get(5)!.stationId = stationId;
      const response = await authenticated('get', '', 5);
      expect(response.status).toBe(200);
      expect(response.body.users.map((row: { id: number }) => row.id)).toEqual([
        3, 4,
      ]);
      expect(response.body.pagination.total).toBe(2);
      for (const [id, employeeStationId] of [
        [3, 10],
        [4, 20],
      ]) {
        const detail = await authenticated('get', `/${id}`, 5);
        expect(detail.status).toBe(200);
        expect(detail.body.user).toMatchObject({
          id,
          role: 'EMPLOYEE',
          stationId: employeeStationId,
        });
        expect(detail.text).not.toMatch(/password|private-hash|roleId|token/);
      }
    },
  );

  it('paginates only employees and applies the same scope to totals', async () => {
    const response = await authenticated('get', '?page=2&limit=1', 5);
    expect(response.status).toBe(200);
    expect(response.body.users.map((row: { id: number }) => row.id)).toEqual([
      4,
    ]);
    expect(response.body.pagination).toEqual({
      page: 2,
      limit: 1,
      total: 2,
      totalPages: 2,
    });
    const where = db.user.findMany.mock.calls[0][0].where;
    expect(where.AND[0]).toEqual({ role: { name: 'EMPLOYEE' } });
    expect(db.user.count).toHaveBeenCalledWith({ where });
  });

  it.each(['ADMIN', 'MANAGER', 'HR', 'SECURITY', 'CUSTOMER'])(
    'cannot widen results or totals using role=%s',
    async (role) => {
      const response = await authenticated('get', `?role=${role}&limit=1`, 5);
      expect(response.status).toBe(200);
      expect(response.body.users).toEqual([]);
      expect(response.body.pagination).toEqual({
        page: 1,
        limit: 1,
        total: 0,
        totalPages: 0,
      });
    },
  );

  it('combines employee scope with station, role, search and status filters', async () => {
    users.get(4)!.isActive = false;
    const response = await authenticated(
      'get',
      '?stationId=20&role=EMPLOYEE&search=USER4@EXAMPLE.COM&isActive=false',
      5,
    );
    expect(response.status).toBe(200);
    expect(response.body.users.map((row: { id: number }) => row.id)).toEqual([
      4,
    ]);
    expect(response.body.pagination.total).toBe(1);
    expect(
      (await authenticated('get', '?stationId=10', 5)).body.users.map(
        (row: { id: number }) => row.id,
      ),
    ).toEqual([3]);
  });

  it.each([1, 2, 5, 6, 7, 8, 999])(
    'hides nonemployees and missing targets: %i',
    async (id) => {
      const response = await authenticated('get', `/${id}`, 5);
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ message: 'User not found' });
    },
  );

  it.each(['ADMIN', 'MANAGER', 'HR', 'SECURITY', 'CUSTOMER'])(
    'cannot create %s accounts',
    async (role) => {
      expect(
        (await authenticated('post', '', 5).send({ ...staffInput, role }))
          .status,
      ).toBe(403);
      expect(db.user.create).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null, 999])(
    'rejects missing or invalid station %s',
    async (stationId) => {
      const response = await authenticated('post', '', 5).send({
        ...staffInput,
        stationId,
      });
      expect(response.status).toBe(400);
      expect(db.user.create).not.toHaveBeenCalled();
    },
  );

  it('rejects an inactive station with the existing assignment error', async () => {
    stations.get(20)!.isActive = false;
    const response = await authenticated('post', '', 5).send({
      ...staffInput,
      stationId: 20,
    });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      message: 'Station unavailable or outside authorized scope',
    });
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it('returns the existing conflict for a normalized duplicate email', async () => {
    const response = await authenticated('post', '', 5).send({
      ...staffInput,
      email: ' USER3@EXAMPLE.COM ',
    });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ message: 'Email already registered' });
    expect(users.size).toBe(8);
  });

  it.each([
    ['/3', { name: 'Changed' }],
    ['/3', { role: 'ADMIN', stationId: null }],
    ['/3', { stationId: 20 }],
    ['/3/status', { isActive: false }],
    ['/3/status', { isActive: true }],
  ])('denies PATCH %s even with users.update', async (path, input) => {
    const response = await authenticated('patch', path, 5).send(input);
    expect(response.status).toBe(403);
    expect(db.user.update).not.toHaveBeenCalled();
    expect(db.refreshSession.updateMany).not.toHaveBeenCalled();
  });

  it.each(['get', 'post'] as const)(
    'still requires permissions for HR %s',
    async (method) => {
      permissions = [];
      const response = await authenticated(method, '', 5).send(
        method === 'post' ? staffInput : undefined,
      );
      expect(response.status).toBe(403);
      expect(db.$transaction).not.toHaveBeenCalled();
    },
  );

  it('rejects HR creation without Origin and CSRF proof', async () => {
    const response = await request(app)
      .post('/api/users')
      .set('Cookie', `${ACCESS_COOKIE}=${tokenService.issue(5).accessToken}`)
      .send(staffInput);
    expect(response.status).toBe(403);
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it('rechecks a now-demoted HR actor inside the creation transaction', async () => {
    db.user.findFirst.mockResolvedValueOnce(user(5, 'EMPLOYEE', 10));
    expect((await authenticated('post', '', 5).send(staffInput)).status).toBe(
      403,
    );
    expect(db.user.create).not.toHaveBeenCalled();
  });
});

describe('immediate employee transfers', () => {
  const at = new Date('2026-11-19T12:00:00Z');
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(at.getTime());
  });

  it.each([1, 5])(
    'allows actor %i to transfer out of an inactive source and resolves new auth station',
    async (actorId) => {
      stations.get(10)!.isActive = false;
      const before = structuredClone(users.get(3)!);
      const tokens = tokenService.issue(3);
      const response = await authenticated('post', '/3/transfer', actorId).send(
        { stationId: 20 },
      );
      expect(response.status).toBe(200);
      expect(response.body.user).toMatchObject({
        id: 3,
        role: 'EMPLOYEE',
        stationId: 20,
      });
      expect(users.get(3)).toEqual({ ...before, stationId: 20 });
      expect(db.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { stationId: 20 } }),
      );
      expect(
        sessions.filter((s) => s.userId === 3).every((s) => s.revokedAt),
      ).toBe(true);
      expect(sessions.find((s) => s.userId === 4)!.revokedAt).toBeNull();
      const me = await request(app)
        .get('/api/auth/me')
        .set('Cookie', `${ACCESS_COOKIE}=${tokens.accessToken}`);
      expect(me.status).toBe(200);
      expect(me.body.user.stationId).toBe(20);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.text).not.toMatch(/password|token|roleId/);
    },
  );

  it('treats same-station requests as no-ops even with conflicts and an inactive station', async () => {
    stations.get(10)!.isActive = false;
    attendanceRecords.push({
      id: 1,
      employeeId: 3,
      stationId: 10,
      clockOutAt: null,
    });
    const response = await authenticated('post', '/3/transfer', 5).send({
      stationId: 10,
    });
    expect(response.status).toBe(200);
    expect(db.user.update).not.toHaveBeenCalled();
    expect(db.refreshSession.updateMany).not.toHaveBeenCalled();
    expect(db.station.findFirst).not.toHaveBeenCalled();
    expect(db.shift.findFirst).not.toHaveBeenCalled();
    expect(db.attendanceRecord.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { stationId: null },
    { stationId: '20' },
    { stationId: 0 },
    { stationId: 20, role: 'ADMIN' },
    { stationId: 20, name: 'Changed' },
    { stationId: 20, isActive: false },
  ])('requires a strict transfer body %j', async (input) => {
    expect(
      (await authenticated('post', '/3/transfer', 5).send(input)).status,
    ).toBe(400);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it.each([999, 20])(
    'rejects missing or inactive destination %i',
    async (stationId) => {
      stations.get(20)!.isActive = false;
      const response = await authenticated('post', '/3/transfer', 5).send({
        stationId,
      });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        message: 'Station unavailable or outside authorized scope',
      });
      expect(db.user.update).not.toHaveBeenCalled();
      expect(db.refreshSession.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each([1, 2, 5, 7, 8, 999])(
    'hides nonemployee or missing target %i',
    async (id) => {
      expect(
        (
          await authenticated('post', `/${id}/transfer`, 5).send({
            stationId: 20,
          })
        ).status,
      ).toBe(404);
      expect(db.user.update).not.toHaveBeenCalled();
    },
  );

  it.each([2, 3, 7, 8])(
    'denies caller %i even with employees.transfer',
    async (id) => {
      const row = users.get(id)!;
      db.user.findUnique.mockResolvedValueOnce({
        ...row,
        role: {
          name: row.role.name,
          permissions: [{ permission: { key: 'employees.transfer' } }],
        },
      });
      expect(
        (await authenticated('post', '/3/transfer', id).send({ stationId: 20 }))
          .status,
      ).toBe(403);
      expect(db.user.update).not.toHaveBeenCalled();
    },
  );

  it('requires authentication, permission, and CSRF proof', async () => {
    expect(
      (
        await request(app)
          .post('/api/users/3/transfer')
          .set('Origin', 'http://localhost:3000')
          .set('X-CSRF-Protection', '1')
          .send({ stationId: 20 })
      ).status,
    ).toBe(401);
    permissions = [];
    expect(
      (await authenticated('post', '/3/transfer', 5).send({ stationId: 20 }))
        .status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post('/api/users/3/transfer')
          .set(
            'Cookie',
            `${ACCESS_COOKIE}=${tokenService.issue(5).accessToken}`,
          )
          .send({ stationId: 20 })
      ).status,
    ).toBe(403);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it.each(['open attendance', 'ongoing shift', 'future shift'])(
    'blocks %s without modifying assignment or records',
    async (conflict) => {
      if (conflict === 'open attendance')
        attendanceRecords.push({
          id: 1,
          employeeId: 3,
          stationId: 10,
          clockOutAt: null,
        });
      else
        shiftRecords.push({
          id: 1,
          employeeId: 3,
          stationId: 10,
          endsAt: new Date(
            at.getTime() + (conflict === 'ongoing shift' ? 1000 : 86400000),
          ),
        });
      const before = structuredClone({ attendanceRecords, shiftRecords });
      expect(
        (await authenticated('post', '/3/transfer', 5).send({ stationId: 20 }))
          .status,
      ).toBe(409);
      expect(users.get(3)!.stationId).toBe(10);
      expect({ attendanceRecords, shiftRecords }).toEqual(before);
      expect(db.user.update).not.toHaveBeenCalled();
      expect(db.refreshSession.updateMany).not.toHaveBeenCalled();
    },
  );

  it('allows a shift ending exactly now and ignores other employees/stations', async () => {
    shiftRecords.push(
      { id: 1, employeeId: 3, stationId: 10, endsAt: at },
      {
        id: 2,
        employeeId: 4,
        stationId: 10,
        endsAt: new Date(at.getTime() + 1000),
      },
    );
    attendanceRecords.push({
      id: 1,
      employeeId: 3,
      stationId: 20,
      clockOutAt: null,
    });
    expect(
      (await authenticated('post', '/3/transfer', 5).send({ stationId: 20 }))
        .status,
    ).toBe(200);
    expect(shiftRecords[0].stationId).toBe(10);
    expect(db.shift.findFirst.mock.calls[0][0].where.endsAt).toEqual({
      gt: at,
    });
  });

  it.each([
    { stationId: 20 },
    { stationId: 20, role: 'SECURITY' },
    { stationId: null, role: 'HR' },
  ])('prevents generic update bypass with %j', async (input) => {
    attendanceRecords.push({
      id: 1,
      employeeId: 3,
      stationId: 10,
      clockOutAt: null,
    });
    expect((await authenticated('patch', '/3').send(input)).status).toBe(409);
    expect(users.get(3)!.role.name).toBe('EMPLOYEE');
    expect(users.get(3)!.stationId).toBe(10);
  });

  it('checks station changes when the resulting role is EMPLOYEE too', async () => {
    shiftRecords.push({
      id: 1,
      employeeId: 7,
      stationId: 10,
      endsAt: new Date(at.getTime() + 1000),
    });
    expect(
      (
        await authenticated('patch', '/7').send({
          role: 'EMPLOYEE',
          stationId: 20,
        })
      ).status,
    ).toBe(409);
    expect(users.get(7)!.role.name).toBe('SECURITY');
  });

  it('keeps manager scope and applies conflicts when both stations are managed', async () => {
    stations.get(20)!.managerId = 2;
    attendanceRecords.push({
      id: 1,
      employeeId: 3,
      stationId: 10,
      clockOutAt: null,
    });
    expect(
      (await authenticated('patch', '/3', 2).send({ stationId: 20 })).status,
    ).toBe(409);
    expect(
      (await authenticated('patch', '/3', 2).send({ name: 'Unrelated rename' }))
        .status,
    ).toBe(200);
    attendanceRecords = [];
    expect(
      (await authenticated('patch', '/3', 2).send({ stationId: 20 })).status,
    ).toBe(200);
  });

  it.each(['post', 'patch'] as const)(
    'rolls back assignment and session revocation together for %s',
    async (method) => {
      db.refreshSession.updateMany.mockImplementationOnce(async () => {
        sessions[0].revokedAt = at;
        throw new Error('test failure');
      });
      const response = await authenticated(
        method,
        method === 'post' ? '/3/transfer' : '/3',
        method === 'post' ? 5 : 1,
      ).send({ stationId: 20 });
      expect(response.status).toBe(500);
      expect(users.get(3)!.stationId).toBe(10);
      expect(
        sessions
          .filter((s) => s.userId === 3)
          .every((s) => s.revokedAt === null),
      ).toBe(true);
    },
  );

  it('rechecks actor and target when a serialization failure retries', async () => {
    db.$transaction.mockRejectedValueOnce({ code: 'P2034' });
    db.user.findFirst.mockResolvedValueOnce(user(5, 'MANAGER'));
    expect(
      (await authenticated('post', '/3/transfer', 5).send({ stationId: 20 }))
        .status,
    ).toBe(403);
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(db.user.update).not.toHaveBeenCalled();
  });
});

describe('updates, deactivation, and integrity', () => {
  it('rejects new inactive assignments but allows unchanged affiliations and unrelated edits', async () => {
    stations.get(10)!.isActive = false;
    expect((await authenticated('post').send(staffInput)).status).toBe(400);
    expect(
      (await authenticated('patch', '/4').send({ stationId: 10 })).status,
    ).toBe(400);
    expect(
      (await authenticated('patch', '/3').send({ name: 'Still assigned' }))
        .status,
    ).toBe(200);
    expect(
      (await authenticated('patch', '/3').send({ stationId: 10 })).status,
    ).toBe(200);
    expect(users.get(3)!.stationId).toBe(10);
  });
  it('reactivation cannot restore earlier access tokens and does not reset the version', async () => {
    const old = tokenService.issue(3);
    await authenticated('patch', '/3/status').send({ isActive: false });
    expect(users.get(3)!.tokenVersion).toBe(1);
    await authenticated('patch', '/3/status').send({ isActive: true });
    expect(users.get(3)!.tokenVersion).toBe(1);
    expect(
      (
        await request(app)
          .get('/api/auth/me')
          .set('Cookie', `${ACCESS_COOKIE}=${old.accessToken}`)
      ).status,
    ).toBe(401);
    const fresh = tokenService.issue(3, undefined, 1);
    expect(
      (
        await request(app)
          .get('/api/auth/me')
          .set('Cookie', `${ACCESS_COOKIE}=${fresh.accessToken}`)
      ).status,
    ).toBe(200);
  });
  it('revokes sessions for a station-only reassignment', async () => {
    const response = await authenticated('patch', '/3').send({ stationId: 20 });
    expect(response.status).toBe(200);
    expect(response.body.user.stationId).toBe(20);
    expect(
      sessions
        .filter((session) => session.userId === 3)
        .every((session) => session.revokedAt),
    ).toBe(true);
  });

  it('rechecks the actor account within the transaction', async () => {
    db.user.findFirst.mockResolvedValueOnce({
      ...users.get(1),
      isActive: false,
    });
    expect(
      (await authenticated('patch', '/3/status').send({ isActive: false }))
        .status,
    ).toBe(401);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('rejects a now-demoted actor despite an earlier authorized request context', async () => {
    db.user.findFirst.mockResolvedValueOnce(user(1, 'EMPLOYEE', 10));
    expect(
      (await authenticated('patch', '/3/status').send({ isActive: false }))
        .status,
    ).toBe(403);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('updates staff role and station explicitly and revokes refresh sessions', async () => {
    const response = await authenticated('patch', '/3').send({
      name: 'Security colleague',
      role: 'SECURITY',
      stationId: 20,
    });
    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({
      role: 'SECURITY',
      stationId: 20,
    });
    expect(
      sessions
        .filter((session) => session.userId === 3)
        .every((session) => session.revokedAt),
    ).toBe(true);
  });

  it.each([
    { email: 'new@example.com' },
    { password: 'Different!123' },
    { roleId: 1 },
    { isActive: false },
    {},
    { role: 'CUSTOMER', stationId: null },
    { stationId: 999 },
  ])('rejects unsupported updates %j', async (input) => {
    expect((await authenticated('patch', '/3').send(input)).status).toBe(400);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('requires reassignment of managed stations before demoting a MANAGER', async () => {
    expect(
      (
        await authenticated('patch', '/2').send({
          role: 'EMPLOYEE',
          stationId: 10,
        })
      ).status,
    ).toBe(409);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('allows ADMIN customer name/status management without promoting customers to staff', async () => {
    expect(
      (await authenticated('patch', '/8').send({ name: 'Customer Name' }))
        .status,
    ).toBe(200);
    expect(
      (await authenticated('patch', '/8').send({ role: 'ADMIN' })).status,
    ).toBe(400);
  });

  it('deactivates transactionally, revokes every current session, and rejects existing access/refresh JWTs', async () => {
    const access = tokenService.issue(3);
    const response = await authenticated('patch', '/3/status').send({
      isActive: false,
    });
    expect(response.status).toBe(200);
    expect(users.get(3)!.isActive).toBe(false);
    expect(
      sessions
        .filter((session) => session.userId === 3)
        .every((session) => session.revokedAt instanceof Date),
    ).toBe(true);
    expect(
      sessions.find((session) => session.userId === 4)?.revokedAt,
    ).toBeNull();
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
    expect(
      (
        await request(app)
          .get('/api/auth/me')
          .set('Cookie', `${ACCESS_COOKIE}=${access.accessToken}`)
      ).status,
    ).toBe(401);
    db.refreshSession.findUnique.mockResolvedValue({
      userId: 3,
      tokenHash: access.tokenHash,
      expiresAt: access.expiresAt,
      revokedAt: null,
      user: { ...users.get(3), role: { name: 'EMPLOYEE', permissions: [] } },
    });
    const refreshed = await request(app)
      .post('/api/auth/refresh')
      .set('Origin', 'http://localhost:3000')
      .set('X-CSRF-Protection', '1')
      .set('Cookie', `${REFRESH_COOKIE}=${access.refreshToken}`);
    expect(refreshed.status).toBe(401);
  });

  it('reactivates without restoring previously revoked sessions', async () => {
    await authenticated('patch', '/3/status').send({ isActive: false });
    const response = await authenticated('patch', '/3/status').send({
      isActive: true,
    });
    expect(response.status).toBe(200);
    expect(users.get(3)!.isActive).toBe(true);
    expect(
      sessions
        .filter((session) => session.userId === 3)
        .every((session) => session.revokedAt),
    ).toBe(true);
  });

  it('rolls back deactivation if session revocation fails', async () => {
    db.refreshSession.updateMany.mockRejectedValueOnce(
      new Error('private database error'),
    );
    const response = await authenticated('patch', '/3/status').send({
      isActive: false,
    });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ message: 'Internal Server Error' });
    expect(users.get(3)!.isActive).toBe(true);
    expect(sessions[0].revokedAt).toBeNull();
  });

  it('protects the final active ADMIN against deactivation and demotion', async () => {
    users.get(6)!.isActive = false;
    expect(
      (await authenticated('patch', '/1/status').send({ isActive: false }))
        .status,
    ).toBe(409);
    expect(
      (await authenticated('patch', '/1').send({ role: 'HR' })).status,
    ).toBe(409);
    expect(users.get(1)!.isActive).toBe(true);
    expect(users.get(1)!.role.name).toBe('ADMIN');
  });

  it('allows disabling an ADMIN when another active ADMIN remains', async () => {
    expect(
      (await authenticated('patch', '/6/status').send({ isActive: false }))
        .status,
    ).toBe(200);
    expect(users.get(1)!.isActive).toBe(true);
  });

  it('retries serialization conflicts and rechecks the final ADMIN invariant', async () => {
    db.$transaction.mockRejectedValueOnce({ code: 'P2034' });
    users.get(6)!.isActive = false;
    expect(
      (await authenticated('patch', '/1/status').send({ isActive: false }))
        .status,
    ).toBe(409);
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(users.get(1)!.isActive).toBe(true);
  });

  it('bounds serialization retries and reports a safe conflict', async () => {
    db.$transaction.mockRejectedValue({ code: 'P2034', secret: 'private' });
    const response = await authenticated('patch', '/3/status').send({
      isActive: false,
    });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      message: 'Concurrent update; retry request',
    });
    expect(db.$transaction).toHaveBeenCalledTimes(3);
  });
});

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
  $transaction: jest.Mock;
};
const db = prisma as unknown as MockDatabase;
type StoredUser = UserRecord & { passwordHash: string };
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
const stations = new Map([
  [10, { id: 10, managerId: 2 }],
  [20, { id: 20, managerId: 9 }],
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
  jest.resetAllMocks();
  users = new Map([
    [1, user(1, 'ADMIN')],
    [2, user(2, 'MANAGER', 20)],
    [3, user(3, 'EMPLOYEE', 10)],
    [4, user(4, 'EMPLOYEE', 20)],
    [5, user(5, 'HR', 10)],
    [6, user(6, 'ADMIN')],
    [7, user(7, 'SECURITY', 10)],
    [8, user(8, 'CUSTOMER')],
  ]);
  sessions = [
    { userId: 3, revokedAt: null },
    { userId: 3, revokedAt: null },
    { userId: 4, revokedAt: null },
  ];
  permissions = ['users.read', 'users.create', 'users.update'];
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
    ({ where }: { where: { AND: { id?: number; managerId?: number }[] } }) =>
      Promise.resolve(
        [...stations.values()].find((station) =>
          where.AND.every(
            (part) =>
              (part.id === undefined || station.id === part.id) &&
              (part.managerId === undefined ||
                station.managerId === part.managerId),
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

describe('manager station boundaries and HR restrictions', () => {
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

  it.each([
    ['get', ''],
    ['get', '/3'],
    ['post', ''],
    ['patch', '/3'],
    ['patch', '/3/status'],
  ] as const)(
    'denies unconfigured HR scope for %s %s despite permissions and station assignment',
    async (method, path) => {
      const response = await authenticated(method, path, 5).send(
        method === 'post'
          ? staffInput
          : method === 'patch'
            ? path.endsWith('status')
              ? { isActive: false }
              : { name: 'Changed' }
            : undefined,
      );
      expect(response.status).toBe(403);
      expect(db.user.create).not.toHaveBeenCalled();
      expect(db.user.update).not.toHaveBeenCalled();
      expect(db.user.findMany).not.toHaveBeenCalled();
    },
  );
});

describe('updates, deactivation, and integrity', () => {
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

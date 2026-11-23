import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { PrismaClient } from '../src/generated/prisma/client.js';

// Loaded only by the existing disposable PostgreSQL runner with --users.
// No database lifecycle, configuration changes or listening-server tests here.
export async function verifyUsersPostgres(
  prisma: PrismaClient,
  stationA: number,
  managerA: number,
  employeeA: number,
  password: string,
) {
  const { app } = await import('../src/app.js');
  const { passwordService } =
    await import('../src/modules/auth/password.service.js');
  const { tokenService } = await import('../src/modules/auth/token.service.js');
  const database = await prisma.$queryRaw<
    { name: string }[]
  >`SELECT current_database() AS name`;
  assert(
    /^m7atati_stage1_verify_[a-f0-9]{16}$/.test(database[0].name),
    'Explicitly disposable database required',
  );
  type Session = {
    cookie: string;
    refreshCookie: string;
    id: string;
    userId: number;
  };
  type Trace = {
    method: string;
    path: string;
    payload: unknown;
    expected?: number;
    actual: number;
    response: unknown;
  };
  const results: {
    case: string;
    result: 'PASS' | 'FAIL' | 'BLOCKED';
    requests: number;
  }[] = [];
  const observations: Record<string, unknown> = {};
  const sessions: Session[] = [];
  const cookies = new Map<string, Session>();
  const created = new Map<string, number>();
  let traces: Trace[] = [];
  let adminCookie = '';
  let loginAttempts = 0;
  class Blocked extends Error {}
  const safeKeys = [
    'createdAt',
    'email',
    'id',
    'isActive',
    'name',
    'role',
    'stationId',
    'updatedAt',
  ];
  function sanitize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          /password|token|cookie|secret|hash|session/i.test(key)
            ? '[REDACTED]'
            : sanitize(item),
        ]),
      );
    if (
      typeof value === 'string' &&
      (value.includes(password) || /eyJ[A-Za-z0-9_-]+\./.test(value))
    )
      return '[REDACTED]';
    return value;
  }
  function safeResponse(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(safeResponse);
      return;
    }
    if (value && typeof value === 'object')
      for (const [key, item] of Object.entries(value)) {
        assert(!/password|token|cookie|secret|hash|session|roleId/i.test(key));
        safeResponse(item);
      }
    else if (typeof value === 'string') {
      assert(!value.includes(password));
      assert(!/eyJ[A-Za-z0-9_-]+\./.test(value));
    }
  }
  function managedUser(value: Record<string, unknown>) {
    assert.deepEqual(Object.keys(value).sort(), safeKeys);
  }
  async function check(name: string, work: () => Promise<void>) {
    traces = [];
    try {
      await work();
      results.push({ case: name, result: 'PASS', requests: traces.length });
    } catch (error) {
      const result = error instanceof Blocked ? 'BLOCKED' : 'FAIL';
      results.push({ case: name, result, requests: traces.length });
      console.info(
        JSON.stringify({
          case: name,
          result,
          requests: traces,
          source:
            error instanceof Error
              ? error.stack
                  ?.split('\n')
                  .find((line) => line.includes('verify-users-postgres.ts:'))
                  ?.trim()
              : undefined,
          reason:
            'Assertion/setup mismatch; raw errors withheld to protect credentials',
        }),
      );
    }
    console.info(JSON.stringify(results[results.length - 1]));
  }
  function requireAdmin() {
    if (!adminCookie) throw new Blocked();
  }
  function actor(role: string) {
    const session = cookies.get(role);
    if (!session) throw new Blocked();
    return session;
  }
  async function send(
    method: 'get' | 'post' | 'patch',
    path: string,
    expected?: number,
    payload?: object,
    options: {
      cookie?: string;
      origin?: boolean;
      csrf?: boolean;
      originValue?: string;
    } = {},
  ) {
    const client = request(app);
    const pending = client[method](path);
    const cookie = options.cookie ?? adminCookie;
    if (cookie) pending.set('Cookie', cookie);
    if (options.origin !== false)
      pending.set('Origin', options.originValue ?? 'http://localhost:3000');
    if (options.csrf !== false) pending.set('X-CSRF-Protection', '1');
    if (payload !== undefined) pending.send(payload);
    const response = await pending;
    traces.push({
      method: method.toUpperCase(),
      path,
      payload: sanitize(payload),
      expected,
      actual: response.status,
      response: sanitize(response.body),
    });
    safeResponse(response.body);
    if (expected !== undefined) assert.equal(response.status, expected);
    else assert(response.status < 500);
    if (path.startsWith('/api/users') && response.status < 300) {
      assert.equal(response.headers['cache-control'], 'no-store');
      if (response.body.user) managedUser(response.body.user);
      if (response.body.users) response.body.users.forEach(managedUser);
    }
    return response;
  }
  async function login(
    email: string,
    expected = 200,
  ): Promise<Session | undefined> {
    loginAttempts++;
    assert(
      loginAttempts <= 20,
      'Acceptance run must respect the real login IP limit',
    );
    const response = await send(
      'post',
      '/api/auth/login',
      expected,
      { email, password },
      { cookie: '' },
    );
    if (expected !== 200) return undefined;
    const values = response.headers['set-cookie'] as unknown as string[];
    const refreshCookie = values
      .find((value) => value.startsWith('m7atati_refresh='))!
      .split(';')[0];
    const verified = tokenService.verifyRefresh(
      refreshCookie.slice('m7atati_refresh='.length),
    );
    const session = {
      cookie: values.map((value) => value.split(';')[0]).join('; '),
      refreshCookie,
      id: verified.sessionId,
      userId: verified.userId,
    };
    sessions.push(session);
    return session;
  }
  const roles = new Map<string, number>();
  for (const name of [
    'ADMIN',
    'MANAGER',
    'EMPLOYEE',
    'HR',
    'SECURITY',
    'CUSTOMER',
  ]) {
    const role = await prisma.role.upsert({
      where: { name },
      update: {},
      create: { name },
    });
    roles.set(name, role.id);
  }
  const permissions: { id: number; key: string }[] = [];
  for (const key of ['users.read', 'users.create', 'users.update']) {
    const permission = await prisma.permission.upsert({
      where: { key },
      update: {},
      create: { key },
    });
    permissions.push(permission);
  }
  for (const role of ['ADMIN', 'MANAGER', 'HR'])
    await prisma.rolePermission.createMany({
      data: permissions.map((permission) => ({
        roleId: roles.get(role)!,
        permissionId: permission.id,
      })),
      skipDuplicates: true,
    });
  const stationB = await prisma.station.create({
    data: {
      name: 'Employee acceptance station B',
      address: 'Disposable test location B',
    },
  });
  await prisma.station.update({
    where: { id: stationA },
    data: { name: 'Employee acceptance station A' },
  });
  const passwordHash = await passwordService.hash(password);
  const managerB = await prisma.user.create({
    data: {
      name: 'Acceptance manager B',
      email: 'manager-b@stage1.invalid',
      roleId: roles.get('MANAGER')!,
      stationId: stationA,
      passwordHash,
    },
  });
  await prisma.station.update({
    where: { id: stationB.id },
    data: { managerId: managerB.id },
  });
  // Deliberately affiliate manager A with B; authority must still come from manager_id.
  await prisma.user.update({
    where: { id: managerA },
    data: { stationId: stationB.id },
  });
  const employeeB = await prisma.user.create({
    data: {
      name: 'Acceptance employee B',
      email: 'employee-b@stage1.invalid',
      roleId: roles.get('EMPLOYEE')!,
      stationId: stationB.id,
      passwordHash,
    },
  });
  const accounts = new Map<string, { id: number; email: string }>();
  for (const role of ['ADMIN', 'MANAGER', 'EMPLOYEE']) {
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: `${role.toLowerCase()}@stage1.invalid` },
    });
    accounts.set(role, { id: user.id, email: user.email });
  }
  for (const role of ['HR', 'SECURITY', 'CUSTOMER']) {
    const user = await prisma.user.create({
      data: {
        name: `Acceptance ${role}`,
        email: `${role.toLowerCase()}@stage1.invalid`,
        roleId: roles.get(role)!,
        stationId: role === 'SECURITY' ? stationA : null,
        passwordHash,
      },
    });
    accounts.set(role, { id: user.id, email: user.email });
  }
  const customerId = accounts.get('CUSTOMER')!.id;
  const securityId = accounts.get('SECURITY')!.id;
  const adminId = accounts.get('ADMIN')!.id;
  const handoff = await prisma.callSession.create({
    data: {
      stationId: stationA,
      handoffUserId: employeeA,
      outcome: 'ACCEPTANCE_RETENTION_FIXTURE',
    },
  });
  const originalEmployee = await prisma.user.findUniqueOrThrow({
    where: { id: employeeA },
    select: { id: true, roleId: true, stationId: true, createdAt: true },
  });
  const operations = (id: number) =>
    [
      {
        method: 'get',
        path: '/api/users',
        body: undefined,
        permission: 'users.read',
      },
      {
        method: 'get',
        path: `/api/users/${id}`,
        body: undefined,
        permission: 'users.read',
      },
      {
        method: 'post',
        path: '/api/users',
        body: {
          name: 'Acceptance forbidden',
          email: 'forbidden@stage1.invalid',
          password,
          role: 'EMPLOYEE',
          stationId: stationA,
        },
        permission: 'users.create',
      },
      {
        method: 'patch',
        path: `/api/users/${id}`,
        body: { name: 'Acceptance forbidden' },
        permission: 'users.update',
      },
      {
        method: 'patch',
        path: `/api/users/${id}/status`,
        body: { isActive: false },
        permission: 'users.update',
      },
    ] as const;
  for (const [role, account] of accounts)
    await check(`${role} real login and current profile`, async () => {
      const session = await login(account.email);
      assert(session);
      cookies.set(role, session);
      if (role === 'ADMIN') adminCookie = session.cookie;
      assert.equal(
        (
          await send('get', '/api/auth/me', 200, undefined, {
            cookie: session.cookie,
          })
        ).body.user.role,
        role,
      );
    });
  await check('Second station manager real login and profile', async () => {
    const second = await login(managerB.email);
    assert(second);
    cookies.set('MANAGER_B', second);
    assert.equal(
      (
        await send('get', '/api/auth/me', 200, undefined, {
          cookie: second.cookie,
        })
      ).body.user.role,
      'MANAGER',
    );
  });
  await check('Anonymous access denied on all users operations', async () => {
    for (const op of operations(employeeA))
      await send(op.method, op.path, 401, op.body, { cookie: '' });
  });
  await check('Required permission enforced on every operation', async () => {
    requireAdmin();
    for (const op of operations(employeeA)) {
      const permission = permissions.find((p) => p.key === op.permission)!;
      await prisma.rolePermission.delete({
        where: {
          roleId_permissionId: {
            roleId: roles.get('ADMIN')!,
            permissionId: permission.id,
          },
        },
      });
      try {
        await send(op.method, op.path, 403, op.body);
      } finally {
        await prisma.rolePermission.create({
          data: { roleId: roles.get('ADMIN')!, permissionId: permission.id },
        });
      }
    }
  });
  await check('Origin and CSRF checks on every unsafe operation', async () => {
    requireAdmin();
    for (const op of operations(employeeA).filter((op) => op.method !== 'get'))
      for (const proof of [
        { origin: false },
        { csrf: false },
        { origin: false, csrf: false },
        { originValue: 'http://untrusted.invalid' },
      ])
        await send(op.method, op.path, 403, op.body, proof);
  });
  await check(
    'ADMIN creates all supported staff roles with current assignments',
    async () => {
      requireAdmin();
      for (const role of ['ADMIN', 'MANAGER', 'EMPLOYEE', 'HR', 'SECURITY']) {
        const stationId = ['EMPLOYEE', 'SECURITY'].includes(role)
          ? stationA
          : role === 'MANAGER'
            ? stationB.id
            : null;
        const response = await send('post', '/api/users', 201, {
          name: ` Acceptance staff ${role} `,
          email: ` STAFF-${role}@stage1.invalid `,
          password,
          role,
          stationId,
        });
        assert.equal(response.body.user.role, role);
        assert.equal(response.body.user.isActive, true);
        assert.equal(response.body.user.stationId, stationId);
        assert.equal(
          response.body.user.email,
          `staff-${role.toLowerCase()}@stage1.invalid`,
        );
        created.set(role, response.body.user.id);
      }
      observations.staffRoles = [
        'ADMIN',
        'MANAGER',
        'EMPLOYEE',
        'HR',
        'SECURITY',
      ];
    },
  );
  await check(
    'ADMIN lists and views both stations with safe profile envelopes',
    async () => {
      requireAdmin();
      const response = await send('get', '/api/users?limit=100', 200);
      assert(
        response.body.users.some((u: { id: number }) => u.id === employeeA),
      );
      assert(
        response.body.users.some((u: { id: number }) => u.id === employeeB.id),
      );
      for (const id of [
        employeeA,
        employeeB.id,
        managerA,
        managerB.id,
        securityId,
        customerId,
      ])
        assert.equal(
          (await send('get', `/api/users/${id}`, 200)).body.user.id,
          id,
        );
    },
  );
  await check(
    'Supported name/role/station edits and assignment changes revoke refresh capability',
    async () => {
      requireAdmin();
      const id = created.get('EMPLOYEE');
      if (!id) throw new Blocked();
      const session = await login('staff-employee@stage1.invalid');
      assert(session);
      await send('patch', `/api/users/${id}`, 200, {
        name: ' Renamed acceptance employee ',
      });
      assert.equal(
        (
          await prisma.refreshSession.findUniqueOrThrow({
            where: { id: session.id },
          })
        ).revokedAt,
        null,
      );
      const response = await send('patch', `/api/users/${id}`, 200, {
        role: 'SECURITY',
        stationId: stationB.id,
      });
      assert.equal(response.body.user.role, 'SECURITY');
      assert.equal(response.body.user.stationId, stationB.id);
      assert(
        (
          await prisma.refreshSession.findUniqueOrThrow({
            where: { id: session.id },
          })
        ).revokedAt,
      );
      await send('post', '/api/auth/refresh', 401, undefined, {
        cookie: session.refreshCookie,
      });
      const profile = await send('get', '/api/auth/me', 200, undefined, {
        cookie: session.cookie,
      });
      assert.equal(profile.body.user.role, 'SECURITY');
      assert.equal(profile.body.user.stationId, stationB.id);
      await send('patch', `/api/users/${id}`, 400, { role: 'HR' });
      await send('patch', `/api/users/${id}`, 200, {
        role: 'HR',
        stationId: null,
      });
      await send('patch', `/api/users/${id}`, 200, {
        role: 'EMPLOYEE',
        stationId: stationA,
      });
    },
  );
  await check(
    'Name/email search, all individual/combined filters and explicit false',
    async () => {
      requireAdmin();
      const queryIds: number[] = [];
      for (const [index, role] of [
        'EMPLOYEE',
        'EMPLOYEE',
        'SECURITY',
      ].entries()) {
        const response = await send('post', '/api/users', 201, {
          name: index < 2 ? 'AcceptanceQuery Twin' : 'AcceptanceQuery Third',
          email: `query-${index}@stage1.invalid`,
          password,
          role,
          stationId: index === 0 ? stationA : stationB.id,
        });
        queryIds.push(response.body.user.id);
      }
      await send('patch', `/api/users/${queryIds[1]}/status`, 200, {
        isActive: false,
      });
      const all = await prisma.user.findMany({
        select: {
          id: true,
          name: true,
          email: true,
          stationId: true,
          isActive: true,
          role: { select: { name: true } },
        },
        orderBy: { id: 'asc' },
      });
      for (const [query, expected] of [
        [
          'search=aCcEpTaNcEqUeRy',
          all.filter((u) => u.name.includes('AcceptanceQuery')),
        ],
        [
          'search=QUERY-0%40STAGE1.INVALID',
          all.filter((u) => u.email === 'query-0@stage1.invalid'),
        ],
        ['role=EMPLOYEE', all.filter((u) => u.role.name === 'EMPLOYEE')],
        [`stationId=${stationA}`, all.filter((u) => u.stationId === stationA)],
        ['isActive=false', all.filter((u) => !u.isActive)],
        ['isActive=true', all.filter((u) => u.isActive)],
        [
          `search=AcceptanceQuery&role=EMPLOYEE&stationId=${stationB.id}&isActive=false`,
          all.filter((u) => u.id === queryIds[1]),
        ],
      ] as const) {
        const response = await send(
          'get',
          `/api/users?limit=100&${query}`,
          200,
        );
        assert.deepEqual(
          response.body.users.map((u: { id: number }) => u.id),
          expected.map((u) => u.id),
        );
        assert.equal(response.body.pagination.total, expected.length);
      }
      const first = await send(
        'get',
        '/api/users?search=AcceptanceQuery&page=1&limit=2',
        200,
      );
      const second = await send(
        'get',
        '/api/users?search=AcceptanceQuery&page=2&limit=2',
        200,
      );
      assert.deepEqual(
        first.body.users.map((u: { id: number }) => u.id),
        queryIds.slice(0, 2),
      );
      assert.deepEqual(
        second.body.users.map((u: { id: number }) => u.id),
        queryIds.slice(2),
      );
      assert.deepEqual(first.body.pagination, {
        page: 1,
        limit: 2,
        total: 3,
        totalPages: 2,
      });
      assert.deepEqual(
        (
          await send(
            'get',
            '/api/users?search=AcceptanceQuery&page=1&limit=2',
            200,
          )
        ).body.users,
        first.body.users,
      );
      const empty = await send(
        'get',
        '/api/users?search=NoSuchEmployeeAcceptance',
        200,
      );
      assert.equal(empty.body.pagination.total, 0);
      assert.equal(empty.body.pagination.totalPages, 0);
    },
  );
  await check(
    'Normalized duplicate emails and whitespace/case variants return 409',
    async () => {
      requireAdmin();
      const body = {
        name: 'Acceptance duplicate',
        email: 'duplicate@stage1.invalid',
        password,
        role: 'EMPLOYEE',
        stationId: stationA,
      };
      await send('post', '/api/users', 201, body);
      for (const email of [
        body.email,
        'DUPLICATE@STAGE1.INVALID',
        ' duplicate@stage1.invalid ',
        ' DUPLICATE@Stage1.Invalid ',
      ]) {
        const response = await send('post', '/api/users', 409, {
          ...body,
          email,
        });
        assert.equal(response.body.message, 'Email already registered');
      }
      assert.equal(
        await prisma.user.count({ where: { email: body.email } }),
        1,
      );
    },
  );
  await check(
    'Concurrent normalized duplicate creation makes exactly one account',
    async () => {
      requireAdmin();
      const variants = [
        'concurrent@stage1.invalid',
        ' CONCURRENT@STAGE1.INVALID ',
        'Concurrent@stage1.invalid',
        ' concurrent@stage1.invalid ',
      ];
      const responses = await Promise.all(
        variants.map((email) =>
          send('post', '/api/users', undefined, {
            name: 'Acceptance concurrent duplicate',
            email,
            password,
            role: 'EMPLOYEE',
            stationId: stationB.id,
          }),
        ),
      );
      observations.concurrentCreateStatuses = responses
        .map((r) => r.status)
        .sort();
      assert.deepEqual(
        responses.map((r) => r.status).sort(),
        [201, 409, 409, 409],
      );
      for (const response of responses.filter((r) => r.status === 409))
        assert.equal(response.body.message, 'Email already registered');
      assert.equal(
        await prisma.user.count({
          where: { email: 'concurrent@stage1.invalid' },
        }),
        1,
      );
    },
  );
  await check(
    'Manager authority follows manager_id, not own station affiliation',
    async () => {
      const cookie = actor('MANAGER').cookie;
      const response = await send(
        'get',
        '/api/users?limit=100',
        200,
        undefined,
        { cookie },
      );
      const expected = await prisma.user.findMany({
        where: { role: { name: 'EMPLOYEE' }, stationId: stationA },
        orderBy: { id: 'asc' },
        select: { id: true },
      });
      assert.deepEqual(
        response.body.users.map((u: { id: number }) => u.id),
        expected.map((u) => u.id),
      );
      await send('get', `/api/users/${employeeA}`, 200, undefined, { cookie });
      const hidden = await send(
        'get',
        `/api/users?stationId=${stationB.id}`,
        200,
        undefined,
        { cookie },
      );
      assert.equal(hidden.body.pagination.total, 0);
      assert.deepEqual(hidden.body.users, []);
      const other = await send(
        'get',
        '/api/users?role=SECURITY',
        200,
        undefined,
        { cookie },
      );
      assert.equal(other.body.pagination.total, 0);
      const managerBResult = await send(
        'get',
        '/api/users?limit=100',
        200,
        undefined,
        { cookie: actor('MANAGER_B').cookie },
      );
      assert(
        managerBResult.body.users.some(
          (u: { id: number }) => u.id === employeeB.id,
        ),
      );
      assert(
        !managerBResult.body.users.some(
          (u: { id: number }) => u.id === employeeA,
        ),
      );
    },
  );
  await check(
    'Manager creates/edits/statuses only own-station EMPLOYEE accounts',
    async () => {
      const cookie = actor('MANAGER').cookie;
      const body = {
        name: 'Acceptance manager-created employee',
        email: 'managed@stage1.invalid',
        password,
        role: 'EMPLOYEE',
        stationId: stationA,
      };
      const made = await send('post', '/api/users', 201, body, { cookie });
      const id = made.body.user.id;
      await send(
        'patch',
        `/api/users/${id}`,
        200,
        { name: 'Acceptance manager renamed' },
        { cookie },
      );
      await send(
        'patch',
        `/api/users/${id}/status`,
        200,
        { isActive: false },
        { cookie },
      );
      await send(
        'patch',
        `/api/users/${id}/status`,
        200,
        { isActive: true },
        { cookie },
      );
      await send(
        'post',
        '/api/users',
        400,
        {
          ...body,
          email: 'cross-create@stage1.invalid',
          stationId: stationB.id,
        },
        { cookie },
      );
      await send(
        'patch',
        `/api/users/${id}`,
        400,
        { stationId: stationB.id },
        { cookie },
      );
      for (const role of ['ADMIN', 'MANAGER', 'HR', 'SECURITY']) {
        await send(
          'post',
          '/api/users',
          403,
          {
            ...body,
            role,
            stationId: ['ADMIN', 'HR'].includes(role) ? null : stationA,
          },
          { cookie },
        );
        await send(
          'patch',
          `/api/users/${id}`,
          403,
          { role, stationId: ['ADMIN', 'HR'].includes(role) ? null : stationA },
          { cookie },
        );
      }
      await send(
        'patch',
        `/api/users/${id}`,
        400,
        { role: 'CUSTOMER' },
        { cookie },
      );
    },
  );
  await check(
    'Cross-station and disallowed-role targets are hidden from managers',
    async () => {
      const cookie = actor('MANAGER').cookie;
      for (const id of [
        employeeB.id,
        adminId,
        managerB.id,
        securityId,
        customerId,
      ]) {
        await send('get', `/api/users/${id}`, 404, undefined, { cookie });
        await send(
          'patch',
          `/api/users/${id}`,
          404,
          { name: 'Acceptance forbidden target' },
          { cookie },
        );
        await send(
          'patch',
          `/api/users/${id}/status`,
          404,
          { isActive: false },
          { cookie },
        );
      }
    },
  );
  await check(
    'HR creates and finds only employees across stations, without update access',
    async () => {
      const cookie = actor('HR').cookie;
      const list = await send('get', '/api/users?limit=100', 200, undefined, {
        cookie,
      });
      assert(
        list.body.users.every((u: { role: string }) => u.role === 'EMPLOYEE'),
      );
      assert.equal(
        list.body.pagination.total,
        await prisma.user.count({ where: { role: { name: 'EMPLOYEE' } } }),
      );
      for (const id of [employeeA, employeeB.id])
        await send('get', `/api/users/${id}`, 200, undefined, { cookie });
      await send('get', `/api/users/${adminId}`, 404, undefined, { cookie });
      const filtered = await send(
        'get',
        '/api/users?role=ADMIN',
        200,
        undefined,
        { cookie },
      );
      assert.equal(filtered.body.pagination.total, 0);
      assert.deepEqual(filtered.body.users, []);
      for (const stationId of [stationA, stationB.id])
        await send(
          'post',
          '/api/users',
          201,
          {
            name: 'HR-created employee',
            email: `hr-created-${stationId}@stage1.invalid`,
            password,
            role: 'EMPLOYEE',
            stationId,
          },
          { cookie },
        );
      await send(
        'post',
        '/api/users',
        403,
        {
          name: 'Forbidden role',
          email: 'hr-forbidden@stage1.invalid',
          password,
          role: 'ADMIN',
        },
        { cookie },
      );
      for (const op of operations(employeeA).filter(
        (op) => op.method === 'patch',
      ))
        await send(op.method, op.path, 403, op.body, { cookie });
    },
  );
  for (const role of ['EMPLOYEE', 'SECURITY', 'CUSTOMER'])
    await check(
      `${role} follows actual service scope even with users permissions`,
      async () => {
        const roleId = roles.get(role)!;
        const before = await prisma.rolePermission.findMany({
          where: { roleId },
        });
        const additions = permissions.filter(
          (p) => !before.some((link) => link.permissionId === p.id),
        );
        await prisma.rolePermission.createMany({
          data: additions.map((p) => ({ roleId, permissionId: p.id })),
          skipDuplicates: true,
        });
        try {
          for (const op of operations(employeeA))
            await send(op.method, op.path, 403, op.body, {
              cookie: actor(role).cookie,
            });
        } finally {
          await prisma.rolePermission.deleteMany({
            where: { roleId, permissionId: { in: additions.map((p) => p.id) } },
          });
        }
      },
    );
  await check('Manager with managed stations cannot be demoted', async () => {
    requireAdmin();
    const response = await send('patch', `/api/users/${managerA}`, 409, {
      role: 'HR',
      stationId: null,
    });
    assert.equal(
      response.body.message,
      'Reassign managed stations before changing this role',
    );
    assert.equal(
      (await prisma.station.findUniqueOrThrow({ where: { id: stationA } }))
        .managerId,
      managerA,
    );
  });
  await check(
    'Invalid staff roles and station assignment combinations',
    async () => {
      requireAdmin();
      const base = {
        name: 'Acceptance invalid assignment',
        email: 'invalid-assignment@stage1.invalid',
        password,
        role: 'EMPLOYEE',
        stationId: stationA,
      };
      for (const changes of [
        { role: 'OWNER' },
        { role: 'CUSTOMER', stationId: null },
        { stationId: null },
        { role: 'SECURITY', stationId: null },
        { role: 'ADMIN', stationId: stationA },
        { role: 'HR', stationId: stationA },
        { stationId: 2147483647 },
        { stationId: -1 },
        { stationId: '1' },
        { stationId: 1.5 },
      ])
        await send('post', '/api/users', 400, { ...base, ...changes });
      for (const body of [
        { role: 'OWNER' },
        { role: 'CUSTOMER' },
        { stationId: null },
        { stationId: 2147483647 },
        { role: 'HR' },
      ])
        await send('patch', `/api/users/${employeeA}`, 400, body);
    },
  );
  await check(
    'Invalid IDs, missing users and strict mutation/query payloads',
    async () => {
      requireAdmin();
      for (const id of ['0', '-1', '01', 'abc', '1e3', '2147483648']) {
        await send('get', `/api/users/${id}`, 400);
        await send('patch', `/api/users/${id}`, 400, { name: 'Invalid ID' });
        await send('patch', `/api/users/${id}/status`, 400, {
          isActive: false,
        });
      }
      await send('get', '/api/users/2147483647', 404);
      await send('patch', '/api/users/2147483647', 404, { name: 'Missing' });
      await send('patch', '/api/users/2147483647/status', 404, {
        isActive: false,
      });
      for (const body of [
        {},
        { name: ' ' },
        { name: 'x'.repeat(129) },
        { isActive: false },
        { roleId: roles.get('ADMIN') },
        { passwordHash: 'REDACTED_FIXTURE' },
        { unknown: true },
      ])
        await send('patch', `/api/users/${employeeA}`, 400, body);
      for (const body of [
        {},
        { isActive: 'false' },
        { isActive: null },
        { isActive: false, name: 'No' },
      ])
        await send('patch', `/api/users/${employeeA}/status`, 400, body);
      for (const changes of [
        { name: '' },
        { email: 'invalid' },
        { password: '' },
        { isActive: false },
        { roleId: 1 },
        { unknown: true },
      ])
        await send('post', '/api/users', 400, {
          name: 'Invalid input',
          email: 'invalid-payload@stage1.invalid',
          password,
          role: 'EMPLOYEE',
          stationId: stationA,
          ...changes,
        });
      for (const query of [
        'page=0',
        'limit=101',
        'isActive=0',
        'role=OWNER',
        'stationId=1e3',
        'page=1&page=2',
        'search=',
        'unknown=1',
      ])
        await send('get', `/api/users?${query}`, 400);
    },
  );
  await check(
    'Customer creation/transitions unsupported; ADMIN can edit customer name/status',
    async () => {
      requireAdmin();
      await send('post', '/api/users', 400, {
        name: 'No customer',
        email: 'no-customer@stage1.invalid',
        password,
        role: 'CUSTOMER',
      });
      await send('patch', `/api/users/${customerId}`, 400, {
        role: 'EMPLOYEE',
        stationId: stationA,
      });
      await send('patch', `/api/users/${customerId}`, 400, {
        stationId: stationA,
      });
      await send('patch', `/api/users/${customerId}`, 200, {
        name: 'Acceptance renamed customer',
      });
      await send('patch', `/api/users/${customerId}/status`, 200, {
        isActive: false,
      });
      await send('patch', `/api/users/${customerId}/status`, 200, {
        isActive: true,
      });
    },
  );
  await check(
    'Unsupported email/password edits are rejected without credential changes',
    async () => {
      requireAdmin();
      const before = await prisma.user.findUniqueOrThrow({
        where: { id: employeeA },
        select: { email: true, passwordHash: true },
      });
      const email = await send('patch', `/api/users/${employeeA}`, 400, {
        email: 'not-updated@stage1.invalid',
      });
      const credential = await send('patch', `/api/users/${employeeA}`, 400, {
        password: randomBytes(24).toString('hex'),
      });
      assert.deepEqual(
        await prisma.user.findUniqueOrThrow({
          where: { id: employeeA },
          select: { email: true, passwordHash: true },
        }),
        before,
      );
      observations.credentialEdits = {
        email: email.status,
        password: credential.status,
      };
    },
  );
  await check('Observe assignment to an inactive station', async () => {
    requireAdmin();
    const movedId = created.get('EMPLOYEE');
    if (!movedId) throw new Blocked();
    assert.equal(
      (await prisma.user.findUniqueOrThrow({ where: { id: movedId } }))
        .stationId,
      stationA,
    );
    await prisma.station.update({
      where: { id: stationB.id },
      data: { isActive: false },
    });
    try {
      const response = await send('post', '/api/users', 400, {
        name: 'Acceptance inactive-station assignment',
        email: 'inactive-station@stage1.invalid',
        password,
        role: 'EMPLOYEE',
        stationId: stationB.id,
      });
      observations.inactiveStationAssignment = response.status;
      if (response.status === 201)
        assert.equal(response.body.user.stationId, stationB.id);
      const update = await send('patch', `/api/users/${movedId}`, 400, {
        stationId: stationB.id,
      });
      observations.inactiveStationReassignment = update.status;
      assert.equal(
        (await prisma.user.findUniqueOrThrow({ where: { id: movedId } }))
          .stationId,
        stationA,
      );
      // Existing affiliations survive station deactivation, including explicit no-change updates.
      await send('patch', `/api/users/${employeeB.id}`, 200, {
        name: 'Inactive station employee renamed',
      });
      await send('patch', `/api/users/${employeeB.id}`, 200, {
        stationId: stationB.id,
      });
      assert.equal(
        (await prisma.user.findUniqueOrThrow({ where: { id: employeeB.id } }))
          .stationId,
        stationB.id,
      );
      if (update.status === 200)
        assert.equal(
          (await prisma.user.findUniqueOrThrow({ where: { id: movedId } }))
            .stationId,
          stationB.id,
        );
    } finally {
      await prisma.station.update({
        where: { id: stationB.id },
        data: { isActive: true },
      });
      await send('patch', `/api/users/${movedId}`, 200, {
        stationId: stationA,
      });
    }
  });
  await check(
    'Deactivation revokes separate real sessions and blocks login/refresh/access',
    async () => {
      requireAdmin();
      const one = await login('employee@stage1.invalid');
      const two = await login('employee@stage1.invalid');
      assert(one && two);
      assert.notEqual(one.id, two.id);
      cookies.set('OLD_ONE', one);
      cookies.set('OLD_TWO', two);
      const response = await send(
        'patch',
        `/api/users/${employeeA}/status`,
        200,
        { isActive: false },
      );
      assert.equal(response.body.user.isActive, false);
      await login('employee@stage1.invalid', 401);
      for (const session of [one, two]) {
        await send('post', '/api/auth/refresh', 401, undefined, {
          cookie: session.refreshCookie,
        });
        await send('get', '/api/auth/me', 401, undefined, {
          cookie: session.cookie,
        });
        await send('get', '/api/users', 401, undefined, {
          cookie: session.cookie,
        });
      }
      assert.equal(
        await prisma.refreshSession.count({
          where: { userId: employeeA, revokedAt: null },
        }),
        0,
      );
      assert.deepEqual(
        await prisma.user.findUniqueOrThrow({
          where: { id: employeeA },
          select: { id: true, roleId: true, stationId: true, createdAt: true },
        }),
        originalEmployee,
      );
      assert.equal(
        (
          await prisma.callSession.findUniqueOrThrow({
            where: { id: handoff.id },
          })
        ).handoffUserId,
        employeeA,
      );
      assert.equal(
        (
          await prisma.station.findUniqueOrThrow({
            where: { id: stationA },
            select: { users: { select: { id: true } } },
          })
        ).users.some((u) => u.id === employeeA),
        true,
      );
      assert.equal(
        (
          await prisma.refreshSession.findUniqueOrThrow({
            where: { id: actor('ADMIN').id },
          })
        ).revokedAt,
        null,
      );
    },
  );
  await check(
    'Reactivation allows fresh login; observe old access/refresh behavior',
    async () => {
      requireAdmin();
      const one = actor('OLD_ONE');
      const two = actor('OLD_TWO');
      await send('patch', `/api/users/${employeeA}/status`, 200, {
        isActive: true,
      });
      const fresh = await login('employee@stage1.invalid');
      assert(fresh);
      await send('get', '/api/auth/me', 200, undefined, {
        cookie: fresh.cookie,
      });
      const access: number[] = [];
      const refresh: number[] = [];
      for (const session of [one, two]) {
        access.push(
          (
            await send('get', '/api/auth/me', 401, undefined, {
              cookie: session.cookie,
            })
          ).status,
        );
        refresh.push(
          (
            await send('post', '/api/auth/refresh', 401, undefined, {
              cookie: session.refreshCookie,
            })
          ).status,
        );
        assert(
          (
            await prisma.refreshSession.findUniqueOrThrow({
              where: { id: session.id },
            })
          ).revokedAt,
        );
      }
      observations.afterReactivation = {
        oldAccessStatuses: access,
        oldRefreshStatuses: refresh,
        freshLogin: 200,
      };
    },
  );
  await check(
    'Assigned manager deactivation is rejected without changing ownership or sessions',
    async () => {
      requireAdmin();
      const before = await prisma.station.findMany({
        where: { managerId: managerA },
        select: { id: true, managerId: true },
        orderBy: { id: 'asc' },
      });
      const managerBefore = await prisma.user.findUniqueOrThrow({
        where: { id: managerA },
      });
      const sessionsBefore = await prisma.refreshSession.findMany({
        where: { userId: managerA },
        orderBy: { id: 'asc' },
      });
      const response = await send(
        'patch',
        `/api/users/${managerA}/status`,
        409,
        { isActive: false },
      );
      observations.managerDeactivation = response.status;
      assert.deepEqual(
        await prisma.user.findUniqueOrThrow({ where: { id: managerA } }),
        managerBefore,
      );
      assert.deepEqual(
        await prisma.refreshSession.findMany({
          where: { userId: managerA },
          orderBy: { id: 'asc' },
        }),
        sessionsBefore,
      );
      assert.deepEqual(
        await prisma.station.findMany({
          where: { managerId: managerA },
          select: { id: true, managerId: true },
          orderBy: { id: 'asc' },
        }),
        before,
      );
      assert.equal(
        (await prisma.user.findUniqueOrThrow({ where: { id: employeeA } }))
          .isActive,
        true,
      );
      observations.managerLinksPreserved = true;
    },
  );
  await check(
    'Final active ADMIN cannot be deactivated or demoted',
    async () => {
      requireAdmin();
      const otherAdmins = await prisma.user.findMany({
        where: {
          role: { name: 'ADMIN' },
          id: { not: adminId },
          isActive: true,
        },
        select: { id: true },
      });
      for (const other of otherAdmins)
        await send('patch', `/api/users/${other.id}/status`, 200, {
          isActive: false,
        });
      assert.equal(
        await prisma.user.count({
          where: { role: { name: 'ADMIN' }, isActive: true },
        }),
        1,
      );
      for (const response of [
        await send('patch', `/api/users/${adminId}/status`, 409, {
          isActive: false,
        }),
        await send('patch', `/api/users/${adminId}`, 409, {
          role: 'HR',
          stationId: null,
        }),
      ])
        assert.equal(
          response.body.message,
          'Cannot remove the final active ADMIN',
        );
      const admin = await prisma.user.findUniqueOrThrow({
        where: { id: adminId },
        include: { role: true },
      });
      assert(admin.isActive);
      assert.equal(admin.role.name, 'ADMIN');
    },
  );
  await check(
    'Safe managed-user fields on list/detail/mutations and all error JSON',
    async () => {
      requireAdmin();
      await send('get', '/api/users?limit=100', 200);
      await send('get', `/api/users/${employeeA}`, 200);
      // Every preceding JSON response was recursively checked, including auth/errors.
    },
  );
  await check('Logout every isolated smoke session', async () => {
    for (const session of sessions)
      await send('post', '/api/auth/logout', 204, undefined, {
        cookie: session.cookie,
      });
    assert.equal(
      await prisma.refreshSession.count({ where: { revokedAt: null } }),
      0,
    );
  });
  console.info('USER POLICY OBSERVATIONS ' + JSON.stringify(observations));
  const summary = {
    passed: results.filter((r) => r.result === 'PASS').length,
    failed: results.filter((r) => r.result === 'FAIL').length,
    blocked: results.filter((r) => r.result === 'BLOCKED').length,
    requests: results.reduce((sum, r) => sum + r.requests, 0),
    loginAttempts,
  };
  console.info('USERS ACCEPTANCE SUMMARY ' + JSON.stringify(summary));
  if (summary.failed || summary.blocked) process.exitCode = 1;
}

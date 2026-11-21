import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';
import pg from 'pg';
import request from 'supertest';
import type { PrismaClient } from '../src/generated/prisma/client.js';

// Explicit, opt-in real PostgreSQL verification. Never included in routine Jest.
// Creates a uniquely named database on the existing local development cluster;
// never migrates, resets, seeds, or changes application data in the source DB.
async function main() {
  dotenv.config({
    path: [resolve('apps/api/.env'), resolve('.env')],
    quiet: true,
  });
  const sourceUrl = process.env.DATABASE_URL;
  assert(sourceUrl, 'Database configuration missing');
  const source = new URL(sourceUrl);
  assert(
    ['localhost', '127.0.0.1', '[::1]'].includes(source.hostname),
    'Local PostgreSQL required',
  );
  assert.equal(
    decodeURIComponent(source.pathname.slice(1)),
    'm7atati',
    'Expected local M7atati database',
  );
  assert.equal(
    process.env.NODE_ENV ?? 'development',
    'development',
    'Development configuration required',
  );
  const databaseName = `m7atati_stage1_verify_${randomBytes(8).toString('hex')}`;
  assert(/^m7atati_stage1_verify_[a-f0-9]{16}$/.test(databaseName));
  const testUrl = new URL(sourceUrl);
  testUrl.pathname = `/${databaseName}`;
  testUrl.searchParams.delete('schema');
  const admin = new pg.Client({
    connectionString: sourceUrl,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
  });
  const scratch = new pg.Client({
    connectionString: testUrl.toString(),
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
  });
  const repositoryRoot = resolve('.');
  const temporaryRoot = mkdtempSync(
    resolve('apps/api/prisma/.stage1-verification-'),
  );
  const migrationsPath = join(temporaryRoot, 'migrations');
  mkdirSync(migrationsPath);
  let created = false;
  let scratchConnected = false;
  let prisma: PrismaClient | undefined;
  let stage = 'isolated database creation';
  function migrationCommand(action: 'deploy' | 'status') {
    const result = spawnSync(
      process.execPath,
      [
        resolve('node_modules/prisma/build/index.js'),
        'migrate',
        action,
        '--config',
        join(temporaryRoot, 'prisma.config.ts'),
      ],
      {
        env: { ...process.env, DATABASE_URL: testUrl.toString() },
        encoding: 'utf8',
      },
    );
    assert.equal(
      result.status,
      0,
      `Isolated migrate ${action} failed (output withheld to protect configuration)`,
    );
  }
  try {
    await admin.connect();
    assert.equal(
      (await admin.query('SELECT current_database() AS name')).rows[0].name,
      'm7atati',
    );
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    await admin.query(
      `COMMENT ON DATABASE "${databaseName}" IS 'Disposable isolated M7atati Stage 1 verification database'`,
    );
    console.info(`Isolated PostgreSQL database created: ${databaseName}`);
    const names = readdirSync('apps/api/prisma/migrations')
      .filter((name) => /^\d/.test(name))
      .sort();
    assert.deepEqual(names, [
      '20261104110906_init',
      '20261105085846_add_authentication',
      '20261114150000_add_station_status',
      '20261117090000_add_user_token_version',
      '20261117100000_add_reference_fuel_prices',
      '20261117110000_preserve_provider_price_units',
      '20261119090000_add_shifts_and_attendance',
      '20261121130000_employee_attendance',
    ]);
    cpSync(
      'apps/api/prisma/migrations/migration_lock.toml',
      join(migrationsPath, 'migration_lock.toml'),
    );
    for (const name of names.slice(0, 2))
      cpSync(
        join('apps/api/prisma/migrations', name),
        join(migrationsPath, name),
        { recursive: true },
      );
    writeFileSync(
      join(temporaryRoot, 'prisma.config.ts'),
      `import { defineConfig, env } from 'prisma/config';\nexport default defineConfig({schema:${JSON.stringify(resolve('apps/api/prisma/schema.prisma'))},migrations:{path:${JSON.stringify(migrationsPath)}},datasource:{url:env('DATABASE_URL')}});\n`,
    );
    stage = 'historical migration deployment';
    migrationCommand('deploy');
    await scratch.connect();
    scratchConnected = true;
    assert.equal(
      (await scratch.query('SELECT current_database() AS name')).rows[0].name,
      databaseName,
    );
    assert.equal(
      (
        await scratch.query(
          "SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema='public' AND table_name='stations' AND column_name='is_active'",
        )
      ).rows[0].count,
      0,
    );
    const legacyId = (
      await scratch.query(
        "INSERT INTO stations(name,address,device_key_hash) VALUES ('Legacy verification station',NULL,'isolated-test-device-hash') RETURNING id",
      )
    ).rows[0].id as number;
    const legacyFuelType = (
      await scratch.query(
        "INSERT INTO fuel_types(name,code) VALUES ('Legacy unknown grade','legacy_unknown') RETURNING id",
      )
    ).rows[0].id;
    const legacyPrice = (
      await scratch.query(
        "INSERT INTO fuel_prices(fuel_type_id,price_minor,currency,source) VALUES ($1,12345,'USD','legacy fixture') RETURNING id",
        [legacyFuelType],
      )
    ).rows[0].id;
    stage = 'station migration deployment and existing-row default';
    for (const name of names.slice(2))
      cpSync(
        join('apps/api/prisma/migrations', name),
        join(migrationsPath, name),
        { recursive: true },
      );
    migrationCommand('deploy');
    migrationCommand('status');
    const retainedPrice = (
      await scratch.query('SELECT * FROM fuel_prices WHERE id=$1', [
        legacyPrice,
      ])
    ).rows[0];
    assert.equal(retainedPrice.price_minor, 12345);
    assert.equal(retainedPrice.fuel_type_id, legacyFuelType);
    assert.equal(retainedPrice.provenance, 'legacy');
    for (const field of ['price', 'market', 'unit', 'provider', 'effective_at'])
      assert.equal(retainedPrice[field], null);
    console.info(
      'PASS: additive pricing migration retains legacy IDs/amounts without invented metadata',
    );
    assert.equal(
      (
        await scratch.query('SELECT is_active FROM stations WHERE id=$1', [
          legacyId,
        ])
      ).rows[0].is_active,
      true,
    );
    const column = (
      await scratch.query(
        "SELECT is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='stations' AND column_name='is_active'",
      )
    ).rows[0];
    assert.equal(column.is_nullable, 'NO');
    assert.equal(column.column_default, 'true');
    console.info(
      'PASS: all repository migrations, pre-migration row default, NOT NULL/default metadata',
    );

    // Test-only keys stay in this isolated process; no dev configuration is saved.
    process.env.DATABASE_URL = testUrl.toString();
    process.env.NODE_ENV = 'test';
    process.env.JWT_ACCESS_SECRET = randomBytes(32).toString('hex');
    process.env.JWT_REFRESH_SECRET = randomBytes(32).toString('hex');
    process.env.ALLOWED_ORIGINS = 'http://localhost:3000';
    ({ prisma } = await import('../src/database/prisma.js'));
    stage = 'isolated role and account fixtures';
    const adminRole = await prisma.role.create({ data: { name: 'ADMIN' } });
    const managerRole = await prisma.role.create({ data: { name: 'MANAGER' } });
    const employeeRole = await prisma.role.create({
      data: { name: 'EMPLOYEE' },
    });
    const unrelated = await prisma.permission.create({
      data: { key: 'users.read' },
    });
    await prisma.rolePermission.createMany({
      data: [adminRole.id, managerRole.id].map((roleId) => ({
        roleId,
        permissionId: unrelated.id,
      })),
    });
    const grants = () =>
      prisma!.rolePermission.findMany({
        select: { roleId: true, permissionId: true },
        orderBy: [{ roleId: 'asc' }, { permissionId: 'asc' }],
      });
    const unrelatedBefore = await grants();
    stage = 'targeted provisioning twice';
    for (let i = 0; i < 2; i++) {
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          'apps/api/scripts/provision-station-permissions.ts',
        ],
        {
          env: {
            ...process.env,
            JWT_ACCESS_SECRET: '',
            JWT_REFRESH_SECRET: '',
          },
          encoding: 'utf8',
        },
      );
      assert.equal(
        result.status,
        0,
        'Targeted CLI provisioning failed (output withheld)',
      );
    }
    const stationPermissions = await prisma.permission.findMany({
      where: { key: { startsWith: 'stations.' } },
      include: { roles: true },
      orderBy: { key: 'asc' },
    });
    assert.deepEqual(
      stationPermissions.map((p) => p.key),
      ['stations.create', 'stations.read', 'stations.update'],
    );
    for (const permission of stationPermissions)
      assert.deepEqual(
        permission.roles.map((r) => r.roleId),
        [adminRole.id],
      );
    assert.equal((await grants()).length, unrelatedBefore.length + 3);
    assert.deepEqual(
      (await grants()).filter((g) => g.permissionId === unrelated.id),
      unrelatedBefore,
    );
    console.info(
      'PASS: targeted CLI twice, exactly three ADMIN-only grants, unrelated grants preserved, no auth keys needed',
    );

    const { passwordService } =
      await import('../src/modules/auth/password.service.js');
    const password = `Aa1!${randomBytes(20).toString('hex')}`;
    const passwordHash = await passwordService.hash(password);
    await prisma.user.create({
      data: {
        name: 'Isolated admin',
        email: 'admin@stage1.invalid',
        roleId: adminRole.id,
        passwordHash,
      },
    });
    const manager = await prisma.user.create({
      data: {
        name: 'Isolated manager',
        email: 'manager@stage1.invalid',
        roleId: managerRole.id,
        passwordHash,
      },
    });
    const employee = await prisma.user.create({
      data: {
        name: 'Isolated employee',
        email: 'employee@stage1.invalid',
        roleId: employeeRole.id,
        stationId: legacyId,
        passwordHash,
      },
    });
    await prisma.station.update({
      where: { id: legacyId },
      data: { managerId: manager.id },
    });
    if (process.argv.includes('--transfers')) {
      stage =
        'employee transfer PostgreSQL transaction and concurrency acceptance';
      const { verifyTransfersPostgres } =
        await import('./verify-transfers-postgres.js');
      await verifyTransfersPostgres(prisma, scratch);
    } else if (process.argv.includes('--attendance')) {
      stage = 'shift and attendance PostgreSQL and in-process HTTP acceptance';
      const { verifyAttendancePostgres } =
        await import('./verify-attendance-postgres.js');
      await verifyAttendancePostgres(prisma, scratch);
    } else if (process.argv.includes('--prices')) {
      stage = 'reference-price PostgreSQL and in-process HTTP acceptance';
      const { verifyPricesPostgres } =
        await import('./verify-prices-postgres.js');
      await verifyPricesPostgres(prisma, password);
    } else if (process.argv.includes('--users')) {
      stage = 'independent employee API acceptance cases';
      const { verifyUsersPostgres } =
        await import('./verify-users-postgres.js');
      await verifyUsersPostgres(
        prisma,
        legacyId,
        manager.id,
        employee.id,
        password,
      );
    } else {
      stage = 'independent station API acceptance cases';
      await runStationAcceptance(
        prisma,
        legacyId,
        manager.id,
        employee.id,
        password,
      );
    }
    const migrationRows = (
      await scratch.query(
        'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
      )
    ).rows;
    assert.deepEqual(
      migrationRows.map((m) => m.migration_name),
      names,
    );
    console.info(
      'PASS: isolated migration metadata recheck; acceptance outcomes are reported individually above',
    );
  } catch (error) {
    // Report only the source location, never raw database errors or credentials.
    const location =
      error instanceof Error
        ? error.stack
            ?.split('\n')
            .filter((line) =>
              /verify-(attendance|transfers)-postgres\.ts:/.test(line),
            )
            .join('\n')
        : undefined;
    if (location) console.error(location.trim());
    console.error(
      `FAIL: ${stage}; details withheld to protect configuration and test credentials`,
    );
    process.exitCode = 1;
  } finally {
    await prisma?.$disconnect();
    if (scratchConnected) await scratch.end();
    if (created) {
      assert(/^m7atati_stage1_verify_[a-f0-9]{16}$/.test(databaseName));
      assert.notEqual(
        databaseName,
        decodeURIComponent(source.pathname.slice(1)),
      );
      await admin.query(`DROP DATABASE "${databaseName}"`);
      console.info(
        'Isolated verification database removed; development data untouched by verification',
      );
    }
    await admin.end();
    const safeRoot = resolve('apps/api/prisma') + sep;
    assert(
      temporaryRoot.startsWith(safeRoot) &&
        temporaryRoot.includes(`${sep}.stage1-verification-`),
    );
    assert(temporaryRoot.startsWith(repositoryRoot + sep));
    rmSync(temporaryRoot, { recursive: true });
  }
}
// Acceptance cases use real login cookies, real middleware and real PostgreSQL.
// A failed case is recorded without preventing independent cases from running.
async function runStationAcceptance(
  prisma: PrismaClient,
  legacyId: number,
  managerId: number,
  employeeId: number,
  password: string,
) {
  const { app } = await import('../src/app.js');
  type Trace = {
    method: string;
    path: string;
    payload?: unknown;
    expected: number;
    actual: number;
    response: unknown;
  };
  const results: {
    case: string;
    result: 'PASS' | 'FAIL' | 'BLOCKED';
    requests: number;
  }[] = [];
  const sessions = new Map<string, string>();
  let traces: Trace[] = [];
  let adminCookie = '';
  let createdId: number | undefined;
  class Blocked extends Error {}
  function sanitize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          /password|token|cookie|secret|device.?key/i.test(key)
            ? '[REDACTED]'
            : sanitize(item),
        ]),
      );
    if (
      typeof value === 'string' &&
      (value.includes(password) ||
        value.includes('isolated-test-device-hash') ||
        /eyJ[A-Za-z0-9_-]+\./.test(value))
    )
      return '[REDACTED]';
    return value;
  }
  async function check(name: string, work: () => Promise<void>) {
    traces = [];
    try {
      await work();
      results.push({ case: name, result: 'PASS', requests: traces.length });
    } catch (error) {
      const result = error instanceof Blocked ? 'BLOCKED' : 'FAIL';
      results.push({ case: name, result, requests: traces.length });
      // Print sanitized traces, never raw assertions or authentication material.
      console.info(
        JSON.stringify({
          case: name,
          result,
          requests: traces,
          source:
            error instanceof Error
              ? error.stack
                  ?.split('\n')
                  .find((line) => line.includes('verify-stations-postgres.ts:'))
                  ?.trim()
              : undefined,
          reason:
            result === 'BLOCKED'
              ? 'Required successful fixture/login unavailable'
              : 'Status or response/database assertion mismatch; inspect case source',
        }),
      );
    }
    console.info(JSON.stringify(results[results.length - 1]));
  }
  function requireAdmin() {
    if (!adminCookie) throw new Blocked();
  }
  function requireCreated() {
    requireAdmin();
    if (createdId === undefined) throw new Blocked();
    return createdId;
  }
  function safeResponse(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(safeResponse);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        assert(!/password|token|secret|cookie|device.?key/i.test(key));
        safeResponse(item);
      }
    } else if (typeof value === 'string') {
      assert(!value.includes(password));
      assert(!value.includes('isolated-test-device-hash'));
      assert(!/eyJ[A-Za-z0-9_-]+\./.test(value));
    }
  }
  async function send(
    method: 'get' | 'post' | 'patch',
    path: string,
    expected: number,
    payload?: object | string,
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
    if (payload !== undefined)
      pending.set('Content-Type', 'application/json').send(payload);
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
    assert.equal(response.status, expected);
    return response;
  }
  async function login(email: string) {
    const response = await send(
      'post',
      '/api/auth/login',
      200,
      { email, password },
      { cookie: '' },
    );
    const cookie = (response.headers['set-cookie'] as unknown as string[])
      .map((item) => item.split(';')[0])
      .join('; ');
    assert(cookie.includes('m7atati_access='));
    sessions.set(email, cookie);
    return cookie;
  }
  const permissions = await prisma.permission.findMany({
    where: {
      key: { in: ['stations.read', 'stations.create', 'stations.update'] },
    },
  });
  const adminRole = await prisma.role.findUniqueOrThrow({
    where: { name: 'ADMIN' },
  });
  const roleAccounts = new Map<string, { roleId: number; email: string }>();
  for (const role of ['MANAGER', 'EMPLOYEE', 'HR', 'SECURITY', 'CUSTOMER']) {
    const roleRecord = await prisma.role.upsert({
      where: { name: role },
      update: {},
      create: { name: role },
    });
    const email = `${role.toLowerCase()}@stage1.invalid`;
    if (!['MANAGER', 'EMPLOYEE'].includes(role)) {
      const { passwordService } =
        await import('../src/modules/auth/password.service.js');
      await prisma.user.create({
        data: {
          name: `Isolated acceptance ${role}`,
          email,
          roleId: roleRecord.id,
          passwordHash: await passwordService.hash(password),
          stationId: role === 'SECURITY' ? legacyId : null,
        },
      });
    }
    roleAccounts.set(role, { roleId: roleRecord.id, email });
  }
  const customer = await prisma.user.findUniqueOrThrow({
    where: { email: 'customer@stage1.invalid' },
  });
  // Historical rows are storage fixtures only, not an order/payment workflow test.
  const fuel = await prisma.fuelType.create({
    data: { name: 'Acceptance history fixture', code: 'ACCEPTANCE_TEST' },
  });
  const pump = await prisma.pump.create({
    data: { stationId: legacyId, number: 1, status: 'TEST_FIXTURE' },
  });
  const order = await prisma.fuelOrder.create({
    data: {
      stationId: legacyId,
      pumpId: pump.id,
      fuelTypeId: fuel.id,
      userId: customer.id,
      createdBy: employeeId,
      source: 'TEST_FIXTURE',
      status: 'TEST_HISTORY',
      unitPriceMinor: 100,
      orderedVolume: 1,
      orderedAmountMinor: 100,
      finalMinor: 100,
    },
  });
  await prisma.orderEvent.create({
    data: {
      orderId: order.id,
      actorUserId: employeeId,
      actorType: 'TEST_FIXTURE',
      toStatus: 'TEST_HISTORY',
    },
  });
  await prisma.payment.create({
    data: {
      orderId: order.id,
      method: 'TEST_FIXTURE',
      currency: 'TST',
      amountMinor: 100,
      capturedMinor: 100,
      status: 'TEST_HISTORY',
    },
  });
  const retained = async () => ({
    station: await prisma.station.findUniqueOrThrow({
      where: { id: legacyId },
      select: {
        id: true,
        managerId: true,
        users: {
          select: { id: true, stationId: true, isActive: true },
          orderBy: { id: 'asc' },
        },
      },
    }),
    staff: await prisma.user.findMany({
      where: { id: { in: [managerId, employeeId] } },
      select: { id: true, roleId: true, stationId: true, isActive: true },
      orderBy: { id: 'asc' },
    }),
    order: await prisma.fuelOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: {
        events: { orderBy: { id: 'asc' } },
        payments: { orderBy: { id: 'asc' } },
      },
    }),
    pump: await prisma.pump.findUniqueOrThrow({ where: { id: pump.id } }),
  });
  const historyBefore = await retained();
  const operations = (id: number) =>
    [
      {
        method: 'post',
        path: '/api/stations',
        body: {
          name: 'Acceptance forbidden creation',
          address: 'Acceptance Road',
        },
        permission: 'stations.create',
      },
      {
        method: 'get',
        path: '/api/stations',
        body: undefined,
        permission: 'stations.read',
      },
      {
        method: 'get',
        path: `/api/stations/${id}`,
        body: undefined,
        permission: 'stations.read',
      },
      {
        method: 'patch',
        path: `/api/stations/${id}`,
        body: { name: 'Acceptance forbidden edit' },
        permission: 'stations.update',
      },
      {
        method: 'patch',
        path: `/api/stations/${id}/status`,
        body: { isActive: false },
        permission: 'stations.update',
      },
    ] as const;
  await check('Anonymous management rejected on every operation', async () => {
    for (const op of operations(legacyId))
      await send(op.method, op.path, 401, op.body, { cookie: '' });
  });
  await check(
    'Public picker without authentication and minimal fields',
    async () => {
      const response = await send(
        'get',
        '/api/stations/picker',
        200,
        undefined,
        { cookie: '' },
      );
      assert(
        response.body.stations.some((s: { id: number }) => s.id === legacyId),
      );
      for (const item of response.body.stations)
        assert.deepEqual(Object.keys(item).sort(), [
          'address',
          'id',
          'latitude',
          'longitude',
          'name',
        ]);
    },
  );
  await check('ADMIN normal login and current profile', async () => {
    adminCookie = await login('admin@stage1.invalid');
    const response = await send('get', '/api/auth/me', 200);
    assert.equal(response.body.user.role, 'ADMIN');
  });
  for (const [role, account] of roleAccounts) {
    let cookie = '';
    await check(`${role} real login and management denied`, async () => {
      cookie = await login(account.email);
      for (const op of operations(legacyId))
        await send(op.method, op.path, 403, op.body, { cookie });
    });
    await check(
      `${role} denied even with all station permissions`,
      async () => {
        if (!cookie) throw new Blocked();
        await prisma.rolePermission.createMany({
          data: permissions.map((p) => ({
            roleId: account.roleId,
            permissionId: p.id,
          })),
          skipDuplicates: true,
        });
        try {
          for (const op of operations(legacyId))
            await send(op.method, op.path, 403, op.body, { cookie });
        } finally {
          await prisma.rolePermission.deleteMany({
            where: {
              roleId: account.roleId,
              permissionId: { in: permissions.map((p) => p.id) },
            },
          });
        }
      },
    );
  }
  await check(
    'ADMIN denied when applicable permission is missing on every operation',
    async () => {
      requireAdmin();
      for (const op of operations(legacyId)) {
        const permission = permissions.find((p) => p.key === op.permission)!;
        await prisma.rolePermission.delete({
          where: {
            roleId_permissionId: {
              roleId: adminRole.id,
              permissionId: permission.id,
            },
          },
        });
        try {
          await send(op.method, op.path, 403, op.body);
        } finally {
          await prisma.rolePermission.upsert({
            where: {
              roleId_permissionId: {
                roleId: adminRole.id,
                permissionId: permission.id,
              },
            },
            update: {},
            create: { roleId: adminRole.id, permissionId: permission.id },
          });
        }
      }
    },
  );
  await check('Unsafe requests require Origin and CSRF proof', async () => {
    requireAdmin();
    for (const op of operations(legacyId).filter((op) => op.method !== 'get')) {
      for (const proof of [
        { origin: false },
        { csrf: false },
        { origin: false, csrf: false },
        { originValue: 'http://untrusted.invalid' },
      ])
        await send(op.method, op.path, 403, op.body, proof);
    }
  });
  await check(
    'ADMIN creation defaults, trimming, safe envelope and no manager assignment',
    async () => {
      requireAdmin();
      const response = await send('post', '/api/stations', 201, {
        name: ' Acceptance created ',
        address: ' Acceptance Road ',
        latitude: 33.89,
        longitude: 35.5,
      });
      createdId = response.body.station.id;
      assert.equal(response.body.station.name, 'Acceptance created');
      assert.equal(response.body.station.address, 'Acceptance Road');
      assert.equal(response.body.station.isActive, true);
      assert.equal(response.body.station.managerId, null);
      assert.equal(
        (await prisma.station.findUniqueOrThrow({ where: { id: createdId } }))
          .isActive,
        true,
      );
    },
  );
  await check('ADMIN list and detail', async () => {
    const id = requireCreated();
    const listed = await send('get', '/api/stations', 200);
    assert(listed.body.stations.some((s: { id: number }) => s.id === id));
    assert.equal(
      (await send('get', `/api/stations/${id}`, 200)).body.station.id,
      id,
    );
  });
  await check('General edit and merged-coordinate update', async () => {
    const id = requireCreated();
    const response = await send('patch', `/api/stations/${id}`, 200, {
      name: 'Acceptance edited',
      address: 'Acceptance edited Road',
      latitude: 34,
    });
    assert.equal(response.body.station.name, 'Acceptance edited');
    assert.equal(response.body.station.address, 'Acceptance edited Road');
    assert.equal(response.body.station.latitude, 34);
    assert.equal(response.body.station.longitude, 35.5);
    assert.equal(response.body.station.managerId, null);
  });
  await check(
    'Reject partial clearing, clear both coordinates, reject incomplete resulting pair',
    async () => {
      const id = requireCreated();
      await send('patch', `/api/stations/${id}`, 400, { longitude: null });
      const response = await send('patch', `/api/stations/${id}`, 200, {
        latitude: null,
        longitude: null,
      });
      assert.equal(response.body.station.latitude, null);
      assert.equal(response.body.station.longitude, null);
      await send('patch', `/api/stations/${id}`, 400, { latitude: 33 });
    },
  );
  await check(
    'Deactivate: public picker exclusion and ADMIN inactive detail',
    async () => {
      const id = requireCreated();
      assert.equal(
        (
          await send('patch', `/api/stations/${id}/status`, 200, {
            isActive: false,
          })
        ).body.station.isActive,
        false,
      );
      const picker = await send('get', '/api/stations/picker', 200, undefined, {
        cookie: '',
      });
      assert(!picker.body.stations.some((s: { id: number }) => s.id === id));
      assert.equal(
        (await send('get', `/api/stations/${id}`, 200)).body.station.isActive,
        false,
      );
    },
  );
  await check('Repeat inactive status is a PostgreSQL row no-op', async () => {
    const id = requireCreated();
    await send('patch', `/api/stations/${id}/status`, 200, { isActive: false });
    const before =
      await prisma.$queryRaw`SELECT xmin::text AS version FROM stations WHERE id=${id}`;
    await send('patch', `/api/stations/${id}/status`, 200, { isActive: false });
    assert.deepEqual(
      await prisma.$queryRaw`SELECT xmin::text AS version FROM stations WHERE id=${id}`,
      before,
    );
  });
  await check(
    'Reactivate: picker inclusion and repeated active no-op',
    async () => {
      const id = requireCreated();
      assert.equal(
        (
          await send('patch', `/api/stations/${id}/status`, 200, {
            isActive: true,
          })
        ).body.station.isActive,
        true,
      );
      assert(
        (
          await send('get', '/api/stations/picker', 200, undefined, {
            cookie: '',
          })
        ).body.stations.some((s: { id: number }) => s.id === id),
      );
      const before =
        await prisma.$queryRaw`SELECT xmin::text AS version FROM stations WHERE id=${id}`;
      await send('patch', `/api/stations/${id}/status`, 200, {
        isActive: true,
      });
      assert.deepEqual(
        await prisma.$queryRaw`SELECT xmin::text AS version FROM stations WHERE id=${id}`,
        before,
      );
    },
  );
  await check(
    'Manager, employee and historical order/event/payment/pump retention',
    async () => {
      requireAdmin();
      for (const isActive of [false, false, true, true]) {
        await send('patch', `/api/stations/${legacyId}/status`, 200, {
          isActive,
        });
        assert.deepEqual(await retained(), historyBefore);
      }
    },
  );
  await check(
    'Legacy null-address detail/edit/status remain manageable',
    async () => {
      requireAdmin();
      assert.equal(
        (await send('get', `/api/stations/${legacyId}`, 200)).body.station
          .address,
        null,
      );
      assert.equal(
        (
          await send('patch', `/api/stations/${legacyId}`, 200, {
            name: 'Acceptance legacy renamed',
          })
        ).body.station.address,
        null,
      );
      await send('patch', `/api/stations/${legacyId}`, 400, { address: ' ' });
      await send('patch', `/api/stations/${legacyId}`, 400, { address: null });
    },
  );
  await check(
    'Merged updates validate existing malformed coordinates',
    async () => {
      requireAdmin();
      await prisma.station.update({
        where: { id: legacyId },
        data: { latitude: 33, longitude: null },
      });
      try {
        await send('patch', `/api/stations/${legacyId}`, 400, {
          name: 'Acceptance malformed legacy',
        });
        const repaired = await send('patch', `/api/stations/${legacyId}`, 200, {
          longitude: 35,
        });
        assert.equal(repaired.body.station.latitude, 33);
        assert.equal(repaired.body.station.longitude, 35);
        await prisma.station.update({
          where: { id: legacyId },
          data: { latitude: 100 },
        });
        await send('patch', `/api/stations/${legacyId}`, 400, {
          name: 'Acceptance out-of-range legacy',
        });
        await send('patch', `/api/stations/${legacyId}`, 200, {
          latitude: null,
          longitude: null,
        });
      } finally {
        await prisma.station.update({
          where: { id: legacyId },
          data: { latitude: null, longitude: null },
        });
      }
    },
  );
  await check('Invalid IDs on detail/update/status', async () => {
    requireAdmin();
    for (const id of ['0', '-1', 'abc', '1e3', '01', '2147483648']) {
      await send('get', `/api/stations/${id}`, 400);
      await send('patch', `/api/stations/${id}`, 400, {
        name: 'Acceptance invalid ID',
      });
      await send('patch', `/api/stations/${id}/status`, 400, {
        isActive: false,
      });
    }
  });
  await check('Missing stations on detail/update/status', async () => {
    requireAdmin();
    await send('get', '/api/stations/2147483647', 404);
    await send('patch', '/api/stations/2147483647', 404, {
      name: 'Acceptance missing',
    });
    await send('patch', '/api/stations/2147483647/status', 404, {
      isActive: false,
    });
  });
  await check('Blank/missing/oversized names and addresses', async () => {
    requireAdmin();
    for (const body of [
      {},
      { name: ' ', address: 'Road' },
      { name: 'Valid' },
      { name: 'Valid', address: ' ' },
      { name: 'Valid', address: null },
      { name: 'x'.repeat(129), address: 'Road' },
      { name: 'Valid', address: 'x'.repeat(513) },
    ])
      await send('post', '/api/stations', 400, body);
    for (const body of [
      { name: ' ' },
      { address: '' },
      { address: null },
      { name: 'x'.repeat(129) },
      { address: 'x'.repeat(513) },
    ])
      await send('patch', `/api/stations/${legacyId}`, 400, body);
  });
  await check(
    'Invalid coordinate ranges, strings, pairs and nonfinite JSON number',
    async () => {
      requireAdmin();
      for (const coordinates of [
        { latitude: 91, longitude: 0 },
        { latitude: -91, longitude: 0 },
        { latitude: 0, longitude: 181 },
        { latitude: 0, longitude: -181 },
        { latitude: '33', longitude: 35 },
        { latitude: 33 },
        { longitude: 35 },
        { latitude: null, longitude: 35 },
      ])
        await send('post', '/api/stations', 400, {
          name: 'Acceptance invalid coordinate',
          address: 'Road',
          ...coordinates,
        });
      for (const body of [
        { latitude: 91 },
        { longitude: -181 },
        { latitude: '33', longitude: 35 },
      ])
        await send('patch', `/api/stations/${legacyId}`, 400, body);
      await send(
        'post',
        '/api/stations',
        400,
        '{"name":"Acceptance overflow","address":"Road","latitude":1e309,"longitude":35}',
      );
    },
  );
  await check(
    'Coordinate boundaries, no coordinates, explicit null pair and nonunique names',
    async () => {
      requireAdmin();
      for (const coordinates of [
        { latitude: -90, longitude: 180 },
        { latitude: 90, longitude: -180 },
        {},
        { latitude: null, longitude: null },
      ]) {
        const response = await send('post', '/api/stations', 201, {
          name: 'Acceptance boundary duplicate',
          address: 'Road',
          ...coordinates,
        });
        assert.equal(response.body.station.isActive, true);
      }
    },
  );
  await check('Empty update and forbidden mutation fields', async () => {
    requireAdmin();
    await send('patch', `/api/stations/${legacyId}`, 400, {});
    for (const key of [
      'managerId',
      'deviceKeyHash',
      'isActive',
      'id',
      'createdAt',
      'unknown',
    ]) {
      await send('post', '/api/stations', 400, {
        name: 'Acceptance forbidden field',
        address: 'Road',
        [key]: key === 'isActive' ? false : 1,
      });
      await send('patch', `/api/stations/${legacyId}`, 400, {
        name: 'Acceptance forbidden field',
        [key]: key === 'isActive' ? false : 1,
      });
    }
  });
  await check('Strict status payload and explicit boolean typing', async () => {
    requireAdmin();
    for (const body of [
      {},
      { isActive: 'false' },
      { isActive: null },
      { isActive: false, name: 'Forbidden' },
    ])
      await send('patch', `/api/stations/${legacyId}/status`, 400, body);
  });
  await check(
    'Search, address search, pages, name/ID tie-break and explicit inactive filter',
    async () => {
      requireAdmin();
      const a = await prisma.station.create({
        data: { name: 'Acceptance Query Same', address: 'UniqueAddressNeedle' },
      });
      const b = await prisma.station.create({
        data: {
          name: 'Acceptance Query Same',
          address: 'Query Road',
          isActive: false,
        },
      });
      const c = await prisma.station.create({
        data: { name: 'Acceptance Query Zulu', address: 'Query Road' },
      });
      const first = await send(
        'get',
        '/api/stations?search=aCcEpTaNcE%20qUeRy&page=1&limit=2',
        200,
      );
      assert.deepEqual(
        first.body.stations.map((s: { id: number }) => s.id),
        [a.id, b.id],
      );
      assert.deepEqual(first.body.pagination, {
        page: 1,
        limit: 2,
        total: 3,
        totalPages: 2,
      });
      const second = await send(
        'get',
        '/api/stations?search=Acceptance%20Query&page=2&limit=2',
        200,
      );
      assert.deepEqual(
        second.body.stations.map((s: { id: number }) => s.id),
        [c.id],
      );
      const inactive = await send(
        'get',
        '/api/stations?search=Acceptance%20Query&isActive=false',
        200,
      );
      assert.deepEqual(
        inactive.body.stations.map((s: { id: number }) => s.id),
        [b.id],
      );
      const active = await send(
        'get',
        '/api/stations?search=Acceptance%20Query&isActive=true',
        200,
      );
      assert.deepEqual(
        active.body.stations.map((s: { id: number }) => s.id),
        [a.id, c.id],
      );
      const address = await send(
        'get',
        '/api/stations?search=uniqueaddressneedle',
        200,
      );
      assert.deepEqual(
        address.body.stations.map((s: { id: number }) => s.id),
        [a.id],
      );
      const empty = await send(
        'get',
        '/api/stations?search=NoSuchAcceptanceStation',
        200,
      );
      assert.equal(empty.body.pagination.total, 0);
      assert.equal(empty.body.pagination.totalPages, 0);
      const picker = await send('get', '/api/stations/picker', 200, undefined, {
        cookie: '',
      });
      assert(!picker.body.stations.some((s: { id: number }) => s.id === b.id));
      const sameName = picker.body.stations.filter(
        (s: { name: string }) => s.name === a.name,
      );
      assert.deepEqual(
        sameName.map((s: { id: number }) => s.id),
        [a.id],
      );
    },
  );
  await check('Invalid listing parameters', async () => {
    requireAdmin();
    for (const query of [
      'isActive=0',
      'isActive=False',
      'isActive=true&isActive=false',
      'page=0',
      'page=1&page=2',
      'limit=101',
      'search=',
      'unknown=1',
    ])
      await send('get', `/api/stations?${query}`, 400);
  });
  await check(
    'Safe response mapping and exact public fields on every picker row',
    async () => {
      requireAdmin();
      await send('get', `/api/stations/${legacyId}`, 200);
      const picker = await send('get', '/api/stations/picker', 200, undefined, {
        cookie: '',
      });
      for (const item of picker.body.stations)
        assert.deepEqual(Object.keys(item).sort(), [
          'address',
          'id',
          'latitude',
          'longitude',
          'name',
        ]);
      const duplicates = picker.body.stations.filter(
        (s: { name: string }) => s.name === 'Acceptance boundary duplicate',
      );
      const duplicateIds = duplicates.map((s: { id: number }) => s.id);
      assert.equal(duplicateIds.length, 4);
      assert.deepEqual(
        duplicateIds,
        [...duplicateIds].sort((a: number, b: number) => a - b),
      );
      // All preceding responses were checked recursively by send(), including errors.
    },
  );
  await check('Logout every isolated smoke session', async () => {
    for (const cookie of sessions.values())
      await send('post', '/api/auth/logout', 204, undefined, { cookie });
    assert.equal(
      await prisma.refreshSession.count({ where: { revokedAt: null } }),
      0,
    );
  });
  const summary = {
    passed: results.filter((r) => r.result === 'PASS').length,
    failed: results.filter((r) => r.result === 'FAIL').length,
    blocked: results.filter((r) => r.result === 'BLOCKED').length,
    requests: results.reduce((sum, r) => sum + r.requests, 0),
  };
  console.info('ACCEPTANCE SUMMARY ' + JSON.stringify(summary));
  if (summary.failed || summary.blocked) process.exitCode = 1;
}

main().catch(() => {
  console.error(
    'PostgreSQL verification blocked or cleanup failed; details withheld',
  );
  process.exitCode = 1;
});

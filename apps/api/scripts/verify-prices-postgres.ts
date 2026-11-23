import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import request from 'supertest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { oilApiFixture } from '../tests/fixtures/oilapi.js';

// Called only by the guarded disposable-database harness. Real Express/auth/Prisma,
// synthetic provider transport; never claims live upstream or listening-server verification.
export async function verifyPricesPostgres(
  database: PrismaClient,
  password: string,
) {
  const { app } = await import('../src/app.js');
  const { fuelPricesRepository: repository } =
    await import('../src/modules/fuel-prices/fuel-prices.repository.js');
  const { parseOilApi, providerUrl } =
    await import('../src/modules/fuel-prices/oilapi.provider.js');
  const { ACCESS_COOKIE } = await import('../src/modules/auth/auth.types.js');
  let passed = 0;
  const check = async (name: string, work: () => Promise<void>) => {
    try {
      await work();
      passed++;
      console.info(`PASS: ${name}`);
    } catch {
      console.error(`FAIL: ${name}; sanitized assertions only`);
      throw new Error('Pricing acceptance failed');
    }
  };
  const admin = await database.role.findUniqueOrThrow({
    where: { name: 'ADMIN' },
  });
  const manager = await database.role.findUniqueOrThrow({
    where: { name: 'MANAGER' },
  });
  const before = await database.rolePermission.findMany({
    orderBy: [{ roleId: 'asc' }, { permissionId: 'asc' }],
  });
  await check(
    'targeted pricing CLI twice; ADMIN grants only; unrelated grants unchanged',
    async () => {
      for (let i = 0; i < 2; i++) {
        const r = spawnSync(
          process.execPath,
          [
            '--import',
            'tsx',
            'apps/api/scripts/provision-pricing-permissions.ts',
          ],
          { env: process.env, encoding: 'utf8' },
        );
        assert.equal(r.status, 0);
      }
      const permissions = await database.permission.findMany({
        where: { key: { startsWith: 'pricing.' } },
        include: { roles: true },
      });
      assert.equal(permissions.length, 2);
      for (const permission of permissions)
        assert.deepEqual(
          permission.roles.map((x) => x.roleId),
          [admin.id],
        );
      const after = await database.rolePermission.findMany({
        orderBy: [{ roleId: 'asc' }, { permissionId: 'asc' }],
      });
      assert.equal(after.length, before.length + 2);
      assert.deepEqual(
        after.filter((x) =>
          before.some(
            (b) => b.roleId === x.roleId && b.permissionId === x.permissionId,
          ),
        ),
        before,
      );
    },
  );
  const login = async (email: string) => {
    const r = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'http://localhost:3000')
      .set('X-CSRF-Protection', '1')
      .send({ email, password });
    assert.equal(r.status, 200);
    return (r.headers['set-cookie'] as unknown as string[])
      .map((x) => x.split(';')[0])
      .join('; ');
  };
  const adminCookie = await login('admin@stage1.invalid');
  const managerCookie = await login('manager@stage1.invalid');
  const api = (
    method: 'get' | 'post',
    path: string,
    cookie = adminCookie,
    csrf = true,
  ) => {
    const call = request(app)[method](`/api/fuel-prices${path}`);
    if (cookie) call.set('Cookie', cookie);
    if (csrf)
      call.set('Origin', 'http://localhost:3000').set('X-CSRF-Protection', '1');
    return method === 'post' ? call.send({}) : call;
  };
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.OILAPI_API_KEY;
  try {
    await check(
      'anonymous 401; non-admin 403 even with pricing grants; all other roles denied',
      async () => {
        for (const path of ['/current', '/history'])
          assert.equal((await api('get', path, '')).status, 401);
        const grants = await database.permission.findMany({
          where: { key: { startsWith: 'pricing.' } },
        });
        await database.rolePermission.createMany({
          data: grants.map((p) => ({ roleId: manager.id, permissionId: p.id })),
        });
        assert.equal((await api('get', '/current', managerCookie)).status, 403);
        for (const name of ['EMPLOYEE', 'HR', 'SECURITY', 'CUSTOMER']) {
          const role = await database.role.upsert({
            where: { name },
            update: {},
            create: { name },
          });
          const original = await database.user.findUniqueOrThrow({
            where: { email: 'manager@stage1.invalid' },
          });
          await database.user.update({
            where: { id: original.id },
            data: { roleId: role.id },
          });
          assert.equal(
            (await api('get', '/current', managerCookie)).status,
            403,
          );
        }
        await database.user.update({
          where: { email: 'manager@stage1.invalid' },
          data: { roleId: manager.id },
        });
      },
    );
    await check('ADMIN requires each applicable permission', async () => {
      for (const [key, method, path] of [
        ['pricing.read', 'get', '/current'],
        ['pricing.update', 'post', '/refresh'],
      ] as const) {
        const permission = await database.permission.findUniqueOrThrow({
          where: { key },
        });
        await database.rolePermission.delete({
          where: {
            roleId_permissionId: {
              roleId: admin.id,
              permissionId: permission.id,
            },
          },
        });
        assert.equal((await api(method, path)).status, 403);
        await database.rolePermission.create({
          data: { roleId: admin.id, permissionId: permission.id },
        });
      }
    });
    await check(
      'refresh requires CSRF; GET is stored-only, meaningful empty history excludes legacy',
      async () => {
        assert.equal(
          (await api('post', '/refresh', adminCookie, false)).status,
          403,
        );
        const r = await api('get', '/history');
        assert.equal(r.status, 200);
        assert.equal(r.body.pagination.total, 0);
        assert.deepEqual(r.body.prices, []);
        const r2 = await api('get', '/current');
        assert.equal(r2.status, 200);
        assert.deepEqual(r2.body.prices, []);
      },
    );
    await check(
      'missing optional key yields sanitized 503 without disabling stored reads',
      async () => {
        delete process.env.OILAPI_API_KEY;
        const missing = await api('post', '/refresh');
        assert.equal(missing.status, 503);
        assert.equal(
          missing.body.message,
          'OilAPI pricing credentials are not configured',
        );
        assert.equal((await api('get', '/current')).status, 200);
      },
    );
    process.env.OILAPI_API_KEY = 'isolated-fixture-key';
    let upstreamCalls = 0;
    globalThis.fetch = async (input) => {
      assert.equal(input, providerUrl);
      upstreamCalls++;
      return new Response(oilApiFixture, {
        headers: { 'content-type': 'application/json' },
      });
    };
    await check(
      'real HTTP refresh ingests complete fixture with exact PostgreSQL decimals',
      async () => {
        const r = await api('post', '/refresh');
        assert.equal(r.status, 200);
        assert.equal(r.body.inserted, 2);
        const rows = await database.fuelPrice.findMany({
          where: { provenance: 'external_reference' },
          orderBy: { fuelCode: 'desc' },
        });
        assert.equal(
          rows.find((x) => x.fuelCode === 'gasoline_95')!.price!.toFixed(),
          '72750.123456789012',
        );
        assert.equal(
          rows.find((x) => x.fuelCode === 'diesel')!.price!.toFixed(),
          '70000.012345678901',
        );
        assert.equal(rows[0].priceMinor, null);
      },
    );
    await check(
      'persistent cooldown blocks simultaneous upstream calls',
      async () => {
        const results = await Promise.all([
          api('post', '/refresh'),
          api('post', '/refresh'),
        ]);
        assert.deepEqual(
          results.map((r) => r.status),
          [429, 429],
        );
        assert.equal(upstreamCalls, 1);
        await database.fuelPriceRefresh.updateMany({
          data: { nextAllowedAt: new Date(0) },
        });
        const competing = await Promise.all([
          api('post', '/refresh'),
          api('post', '/refresh'),
        ]);
        assert.deepEqual(competing.map((r) => r.status).sort(), [200, 429]);
        assert.equal(upstreamCalls, 2);
      },
    );
    const quotes = parseOilApi(oilApiFixture);
    await check(
      'database uniqueness prevents duplicate and concurrent ingestion',
      async () => {
        const results = await Promise.all([
          repository.ingest(quotes, new Date()),
          repository.ingest(quotes, new Date()),
        ]);
        assert.equal(
          results.reduce((n, x) => n + x.inserted, 0),
          0,
        );
        assert.equal(
          await database.fuelPrice.count({
            where: { provenance: 'external_reference' },
          }),
          2,
        );
        await assert.rejects(() =>
          database.fuelPrice.create({
            data: {
              ...quotes[0],
              fuelTypeId: 1,
              provenance: 'external_reference',
              lastSeenAt: new Date(),
            },
          }),
        );
        const fresh = quotes.map((q) => ({
          ...q,
          effectiveAt: new Date('2026-09-01T00:00:00Z'),
        }));
        const competing = await Promise.all([
          repository.ingest([...fresh].reverse(), new Date()),
          repository.ingest(fresh, new Date()),
        ]);
        assert.equal(
          competing.reduce((n, x) => n + x.inserted, 0),
          2,
        );
        assert.equal(
          competing.reduce((n, x) => n + x.skipped, 0),
          2,
        );
      },
    );
    await check(
      'corrections append observations; older effective date fetched later stays historical',
      async () => {
        const corrected = quotes.map((q) => ({
          ...q,
          price: q.fuelCode === 'diesel' ? '70001.000000000001' : q.price,
          // This synthetic feed is per litre (divisor 1). A correction must
          // preserve price * conversionDivisor = providerPrice in PostgreSQL.
          providerPrice:
            q.fuelCode === 'diesel' ? '70001.000000000001' : q.providerPrice,
        }));
        assert.equal(
          (await repository.ingest(corrected, new Date(Date.now() + 10)))
            .inserted,
          1,
        );
        const older = quotes.map((q) => ({
          ...q,
          effectiveAt: new Date('2026-10-01T00:00:00Z'),
        }));
        await repository.ingest(older, new Date(Date.now() + 20));
        const r = await api('get', '/current');
        assert.equal(r.status, 200);
        assert.equal(r.body.prices.length, 2);
        for (const price of r.body.prices)
          assert.equal(price.effectiveAt, '2026-11-01');
        assert.equal(
          r.body.prices.find(
            (x: { fuelCode: string }) => x.fuelCode === 'diesel',
          ).price,
          '70001.000000000001',
        );
        assert.equal(
          await database.fuelPrice.count({
            where: { provenance: 'external_reference' },
          }),
          7,
        );
      },
    );
    await check(
      'history filters/date bounds/pagination/stable ordering/safe output',
      async () => {
        const r = await api(
          'get',
          '/history?fuel=diesel&from=2026-11-01&to=2026-11-01&limit=1&page=1',
        );
        assert.equal(r.status, 200);
        assert.equal(r.body.pagination.total, 2);
        assert.equal(r.body.prices.length, 1);
        const again = await api(
          'get',
          '/history?fuel=diesel&from=2026-11-01&to=2026-11-01&limit=1&page=1',
        );
        assert.equal(again.body.prices[0].id, r.body.prices[0].id);
        const second = await api(
          'get',
          '/history?fuel=diesel&from=2026-11-01&to=2026-11-01&limit=1&page=2',
        );
        assert.notEqual(second.body.prices[0].id, r.body.prices[0].id);
        for (const path of [
          '/history?from=2026-02-30',
          '/history?from=2026-11-01&to=2026-01-01',
          '/history?fuel=gasoline_98',
          '/history?page=0',
          '/current?url=https://untrusted.invalid',
        ])
          assert.equal((await api('get', path)).status, 400);
        const text = JSON.stringify(r.body);
        for (const secret of [
          'passwordHash',
          'tokenHash',
          'deviceKeyHash',
          'isolated-fixture-key',
          ACCESS_COOKIE,
        ])
          assert(!text.includes(secret));
        assert.equal(typeof r.body.prices[0].price, 'string');
        assert.equal(r.body.metadata.market, 'LB');
      },
    );
    await check(
      'failed/partial refresh leaves stored observations unchanged',
      async () => {
        const before = await database.fuelPrice.findMany({
          orderBy: { id: 'asc' },
        });
        for (const response of [
          new Response('{}', { status: 429 }),
          new Response('{"data":{"country":"LB","fuels":[]}}', {
            headers: { 'content-type': 'application/json' },
          }),
        ]) {
          await database.fuelPriceRefresh.updateMany({
            data: { nextAllowedAt: new Date(0) },
          });
          globalThis.fetch = async () => response;
          const r = await api('post', '/refresh');
          assert([429, 502].includes(r.status));
        }
        assert.deepEqual(
          await database.fuelPrice.findMany({ orderBy: { id: 'asc' } }),
          before,
        );
      },
    );
    await check(
      'database metadata CHECK rejects invalid reference rows',
      async () => {
        await assert.rejects(() =>
          database.fuelPrice.create({
            data: {
              fuelTypeId: 1,
              currency: 'LBP',
              provenance: 'external_reference',
            },
          }),
        );
      },
    );
    console.info(
      `Pricing PostgreSQL acceptance: ${passed} groups passed; provider transport synthetic, real in-process HTTP/auth/Prisma`,
    );
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.OILAPI_API_KEY;
    else process.env.OILAPI_API_KEY = savedKey;
    // Sessions and fixtures reside exclusively in the disposable DB dropped by the caller.
  }
}

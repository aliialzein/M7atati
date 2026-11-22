import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse } from 'dotenv';
import {
  ordersVerificationTarget,
  requireOrdersVerificationMutations,
} from './orders-verification-safety.js';
import {
  ordersDatabasePreflight,
  verifyOrdersConstraints,
} from './orders-verification-preflight.js';

// No imports of application configuration/database until the target is checked.
// Never creates/drops databases, runs seeds, resets data or resolves migrations.
async function main() {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const mode = process.argv[2] ?? '--preflight';
  assert(
    ['--preflight', '--migrate', '--verify'].includes(mode) &&
      process.argv.length <= 3,
    'Choose --preflight, --migrate or --verify',
  );
  const protectedUrls = ['.env', 'apps/api/.env'].flatMap((name) => {
    const file = resolve(repo, name);
    const url = existsSync(file)
      ? parse(readFileSync(file)).DATABASE_URL
      : undefined;
    return url ? [url] : [];
  });
  const target = ordersVerificationTarget(process.env, protectedUrls);
  if (mode !== '--preflight') requireOrdersVerificationMutations(process.env);
  const { PrismaPg } = await import('@prisma/adapter-pg');
  const { PrismaClient } = await import('../src/generated/prisma/client.js');
  const database = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: target.url,
      connectionTimeoutMillis: 5000,
      query_timeout: 10000,
    }),
    log: [],
  });
  try {
    const directory = resolve(repo, 'apps/api/prisma/migrations');
    const before = await ordersDatabasePreflight(
      database,
      target.name,
      directory,
    );
    console.info(JSON.stringify(before, null, 2));
    assert.equal(
      before.conflicts.length,
      0,
      'Preflight conflicts require explicit review; no records were repaired',
    );
    if (mode === '--preflight') return;
    if (mode === '--migrate') {
      const result = spawnSync(
        process.execPath,
        [
          resolve(repo, 'node_modules/prisma/build/index.js'),
          'migrate',
          'deploy',
          '--config',
          'apps/api/prisma.config.ts',
        ],
        {
          cwd: repo,
          shell: false,
          stdio: 'inherit',
          env: { ...process.env, DATABASE_URL: target.url },
        },
      );
      assert.equal(
        result.status,
        0,
        'Disposable migration deployment failed; no automatic reset/resolve attempted',
      );
      const after = await ordersDatabasePreflight(
        database,
        target.name,
        directory,
      );
      assert.equal(after.pending.length, 0, 'Migrations remain pending');
      assert.equal(
        after.conflicts.length,
        0,
        'Post-migration integrity conflicts detected',
      );
      await verifyOrdersConstraints(database);
      console.info(
        'PASS: migration order/checksums, applied history and required constraints',
      );
      return;
    }
    assert.equal(
      before.pending.length,
      0,
      'Run the guarded --migrate command on this target first',
    );
    await verifyOrdersConstraints(database);
    process.env.DATABASE_URL = target.url;
    process.env.NODE_ENV = 'test';
    process.env.JWT_ACCESS_SECRET = randomBytes(32).toString('hex');
    process.env.JWT_REFRESH_SECRET = randomBytes(32).toString('hex');
    // This import happens only after isolation, identity and schema checks.
    const { runOrdersPostgresScenarios } =
      await import('./orders-postgres-scenarios.js');
    await runOrdersPostgresScenarios();
    const after = await ordersDatabasePreflight(
      database,
      target.name,
      directory,
    );
    assert.equal(
      after.conflicts.length,
      0,
      'Post-verification integrity conflicts detected',
    );
    assert(
      after.customerCancelProvisioned,
      'Customer cancellation permission missing',
    );
    // Preserve and run the existing Stage 2 real database concurrency checks.
    const legacy = spawnSync(
      process.execPath,
      [
        resolve(repo, 'node_modules/tsx/dist/cli.mjs'),
        'apps/api/scripts/verify-employee-order-consistency-postgres.ts',
      ],
      {
        cwd: repo,
        shell: false,
        stdio: 'inherit',
        env: {
          ...process.env,
          EMPLOYEE_ORDERS_TEST_DATABASE_URL: target.url,
          ALLOW_EMPLOYEE_ORDER_FIXTURES: 'yes',
        },
      },
    );
    assert.equal(
      legacy.status,
      0,
      'Stage 2 PostgreSQL consistency checks failed',
    );
    const final = await ordersDatabasePreflight(
      database,
      target.name,
      directory,
    );
    assert.equal(
      final.conflicts.length,
      0,
      'Stage 2 verification left integrity conflicts',
    );
    console.info(
      'PASS: all Stage 2–8 PostgreSQL verification phases; marked fixtures retained',
    );
  } finally {
    await database.$disconnect();
  }
}

main().catch(() => {
  // Do not dump URLs, auth/guest tokens, request bodies or driver credentials.
  console.error(
    'FAIL: Stage 9 stopped. Check target confirmation, preflight output and the last scenario label. No development fallback or automatic data repair.',
  );
  process.exitCode = 1;
});

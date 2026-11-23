import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import {
  ordersVerificationTarget,
  requireOrdersVerificationMutations,
} from '../../scripts/orders-verification-safety.js';
import { ordersMigrationInventory } from '../../scripts/orders-verification-preflight.js';
import { provisionCustomerOrderCancellation } from '../../scripts/customer-order-permissions.js';

const name = 'm7atati_employee_orders_verify_stage9';
const target = `postgresql://test:secret@127.0.0.1:5432/${name}?schema=public`;
const environment = () => ({
  ORDERS_VERIFY_DATABASE_URL: target,
  ORDERS_VERIFY_CONFIRM_DATABASE: name,
});
it('requires an explicit target and exact name confirmation with no application URL fallback', () => {
  expect(() => ordersVerificationTarget({ DATABASE_URL: target })).toThrow();
  expect(() =>
    ordersVerificationTarget({ ORDERS_VERIFY_DATABASE_URL: target }),
  ).toThrow();
  expect(() =>
    ordersVerificationTarget({
      ...environment(),
      ORDERS_VERIFY_CONFIRM_DATABASE: 'yes',
    }),
  ).toThrow();
  expect(ordersVerificationTarget(environment())).toEqual({
    url: target,
    name,
  });
});
it.each([
  'postgresql://test:secret@example.com/' + name,
  'postgresql://test:secret@localhost/m7atati_dev',
  'postgresql://test:secret@localhost/postgres',
  'mysql://localhost/' + name,
  'not-a-url',
  target + '&host=example.com',
  target + '&options=unsafe',
  target + '&schema=private',
  target + '&schema=public',
])('rejects unsafe target %s', (url) => {
  expect(() =>
    ordersVerificationTarget({
      ...environment(),
      ORDERS_VERIFY_DATABASE_URL: url,
    }),
  ).toThrow();
});
it('rejects a database named in application environment files, regardless of host aliases', () => {
  expect(() =>
    ordersVerificationTarget(environment(), [
      `postgresql://other:password@localhost/${name}`,
    ]),
  ).toThrow();
  expect(() =>
    ordersVerificationTarget(environment(), ['invalid-config']),
  ).toThrow();
});
it.each([undefined, '', 'true', 'YES', 'no'])(
  'requires explicit mutation authorization: %s',
  (value) => {
    expect(() =>
      requireOrdersVerificationMutations({
        ALLOW_ORDERS_VERIFY_MUTATIONS: value,
      }),
    ).toThrow();
  },
);
it('allows mutation only after the separate authorization guard', () => {
  expect(() =>
    requireOrdersVerificationMutations({
      ALLOW_ORDERS_VERIFY_MUTATIONS: 'yes',
    }),
  ).not.toThrow();
});
it('discovers the complete ordered migration history and hashes every SQL file', () => {
  const migrations = ordersMigrationInventory(resolve('prisma/migrations'));
  expect(migrations).toHaveLength(13);
  expect(migrations.slice(-3).map((row) => row.name)).toEqual([
    '20261122210000_cash_confirmation',
    '20261122220000_active_pump_reservations',
    '20261123160000_unique_station_manager',
  ]);
  expect(migrations.every((row) => /^[a-f0-9]{64}$/.test(row.checksum))).toBe(
    true,
  );
});
it.each([
  ['verify-orders-postgres.ts', 'Stage 9 stopped'],
  ['verify-station-pumps-postgres.ts', 'Pump lookup verification stopped'],
  [
    'verify-manager-ownership-postgres.ts',
    'Manager ownership verification stopped',
  ],
])(
  'fails closed before database imports without target confirmation: %s',
  (script, diagnostic) => {
    const childEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: 'not-a-database-url',
    };
    delete childEnvironment.ORDERS_VERIFY_DATABASE_URL;
    delete childEnvironment.ORDERS_VERIFY_CONFIRM_DATABASE;
    delete childEnvironment.ALLOW_ORDERS_VERIFY_MUTATIONS;
    const repo = resolve('../..');
    const child = spawnSync(
      process.execPath,
      [
        resolve(repo, 'node_modules/tsx/dist/cli.mjs'),
        `apps/api/scripts/${script}`,
        '--verify',
      ],
      { cwd: repo, env: childEnvironment, encoding: 'utf8', timeout: 10000 },
    );
    expect(child.status).toBe(1);
    expect(child.stderr).toContain(diagnostic);
    expect(child.stderr).not.toContain('not-a-database-url');
    expect(child.stdout).not.toContain('Fixtures');
  },
);
it.each([
  ['m7atati_employee_orders_verify_manager_task03', 'yes'],
  ['m7atati_employee_orders_verify_pumps_task05', 'no'],
])(
  'pump verifier rejects an earlier-task target or absent write opt-in: %s',
  (name, mutation) => {
    const repo = resolve('../..');
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'apps/api/scripts/verify-station-pumps-postgres.ts',
        '--verify',
      ],
      {
        cwd: repo,
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          DATABASE_URL: 'not-a-database-url',
          ORDERS_VERIFY_DATABASE_URL: `postgresql://127.0.0.1:1/${name}`,
          ORDERS_VERIFY_CONFIRM_DATABASE: name,
          ALLOW_ORDERS_VERIFY_MUTATIONS: mutation,
        },
      },
    );
    expect(child.status).toBe(1);
    expect(child.stderr).toContain('stopped during target safety');
    expect(child.stderr).not.toContain('not-a-database-url');
    expect(child.stdout).toBe('');
  },
);
it('provisions only Customer orders.cancel, preserving unrelated grants and replaying safely', async () => {
  const grants = new Set(['7:80']);
  const tx = {
    role: { findUnique: jest.fn(async () => ({ id: 2 })) },
    permission: { upsert: jest.fn(async () => ({ id: 10 })) },
    rolePermission: {
      upsert: jest.fn(
        async ({
          create,
        }: {
          create: { roleId: number; permissionId: number };
        }) => {
          grants.add(`${create.roleId}:${create.permissionId}`);
        },
      ),
    },
  };
  const database = {
    $transaction: async (work: (client: typeof tx) => Promise<void>) =>
      work(tx),
  };
  await provisionCustomerOrderCancellation(database as unknown as PrismaClient);
  await provisionCustomerOrderCancellation(database as unknown as PrismaClient);
  expect([...grants].sort()).toEqual(['2:10', '7:80']);
  expect(tx.role.findUnique).toHaveBeenCalledWith({
    where: { name: 'CUSTOMER' },
    select: { id: true },
  });
  expect(tx.permission.upsert).toHaveBeenCalledWith(
    expect.objectContaining({ where: { key: 'orders.cancel' }, update: {} }),
  );
});
it('does not create roles or grant permissions if the Customer role is absent', async () => {
  const upsert = jest.fn();
  const tx = { role: { findUnique: async () => null }, permission: { upsert } };
  const database = {
    $transaction: async (work: (client: typeof tx) => Promise<void>) =>
      work(tx),
  };
  await expect(
    provisionCustomerOrderCancellation(database as unknown as PrismaClient),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect(upsert).not.toHaveBeenCalled();
});

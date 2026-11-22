import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Prisma, PrismaClient } from '../src/generated/prisma/client.js';

export function ordersMigrationInventory(directory: string) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const sql = readFileSync(join(directory, entry.name, 'migration.sql'));
      return {
        name: entry.name,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function ordersDatabasePreflight(
  database: PrismaClient,
  name: string,
  directory: string,
) {
  // Every statement in this phase runs in a database-enforced READ ONLY transaction.
  return database.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const [identity] = await tx.$queryRaw<{ name: string; schema: string }[]>`
      SELECT current_database() AS name, current_schema() AS schema`;
      assert.equal(
        identity.name,
        name,
        'Connected database differs from confirmation',
      );
      assert.equal(identity.schema, 'public', 'Public schema required');
      const exists = async (relation: string) => {
        const [row] = await tx.$queryRaw<
          { present: boolean }[]
        >`SELECT to_regclass(${`public.${relation}`}) IS NOT NULL AS present`;
        return row.present;
      };
      const inventory = ordersMigrationInventory(directory);
      const applied = (await exists('_prisma_migrations'))
        ? await tx.$queryRaw<
            {
              migration_name: string;
              checksum: string;
              finished_at: Date | null;
              rolled_back_at: Date | null;
            }[]
          >`SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at`
        : [];
      const successful = applied.filter(
        (row) => row.finished_at && !row.rolled_back_at,
      );
      for (const row of applied.filter((row) => !row.rolled_back_at)) {
        const local = inventory.find(
          (item) => item.name === row.migration_name,
        );
        assert(local, 'Applied migration is absent from repository');
        assert.equal(
          local.checksum,
          row.checksum,
          `Migration checksum differs: ${row.migration_name}`,
        );
        assert(
          row.finished_at,
          `Failed/incomplete migration requires review: ${row.migration_name}`,
        );
      }
      const names = successful.map((row) => row.migration_name);
      assert.deepEqual(
        [...names].sort(),
        inventory.slice(0, names.length).map((row) => row.name),
        'Applied migrations are not a repository prefix',
      );
      const conflicts: { kind: string; ids: unknown }[] = [];
      if (
        (await exists('users')) &&
        !names.includes('20261105085846_add_authentication')
      ) {
        const [row] = await tx.$queryRaw<
          { count: bigint }[]
        >`SELECT count(*) FROM users`;
        if (row.count > 0n)
          conflicts.push({
            kind: 'authentication migration requires explicit legacy user backfill',
            ids: 'users present',
          });
      }
      if (await exists('attendance_records')) {
        const rows = await tx.$queryRaw<
          { employee_id: number }[]
        >`SELECT employee_id FROM attendance_records
        WHERE clock_out_at IS NULL GROUP BY employee_id HAVING count(*) > 1`;
        if (rows.length)
          conflicts.push({
            kind: 'duplicate open attendance',
            ids: rows.map((row) => row.employee_id),
          });
      }
      if (await exists('orders')) {
        const duplicates = await tx.$queryRaw<
          { pump_id: number; ids: number[] }[]
        >`
        SELECT pump_id, array_agg(id ORDER BY id) AS ids FROM orders
        WHERE status IN ('PENDING', 'IN_PROGRESS') AND pump_id IS NOT NULL
        GROUP BY pump_id HAVING count(*) > 1`;
        if (duplicates.length)
          conflicts.push({
            kind: 'duplicate active pump reservations',
            ids: duplicates,
          });
        const missing = await tx.$queryRaw<
          { id: number }[]
        >`SELECT id FROM orders
        WHERE status IN ('PENDING', 'IN_PROGRESS') AND pump_id IS NULL`;
        if (missing.length)
          conflicts.push({
            kind: 'active orders without pumps',
            ids: missing.map((row) => row.id),
          });
        const columns = await tx.$queryRaw<
          { column_name: string }[]
        >`SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'orders' AND column_name IN ('assigned_employee_id', 'claimed_at')`;
        if (columns.length === 2) {
          const stranded = await tx.$queryRaw<
            { id: number }[]
          >`SELECT id FROM orders
          WHERE (status = 'PENDING' AND (assigned_employee_id IS NOT NULL OR claimed_at IS NOT NULL))
            OR (status = 'AWAITING_PAYMENT' AND (pump_id IS NOT NULL OR assigned_employee_id IS NOT NULL OR claimed_at IS NOT NULL))`;
          if (stranded.length)
            conflicts.push({
              kind: 'inconsistent pending/unpaid assignments',
              ids: stranded.map((row) => row.id),
            });
          const orphaned = await tx.$queryRaw<
            { id: number }[]
          >`SELECT o.id FROM orders o
          LEFT JOIN users u ON u.id = o.assigned_employee_id LEFT JOIN roles r ON r.id = u.role_id
          LEFT JOIN stations s ON s.id = o.station_id
          WHERE o.status = 'IN_PROGRESS' AND (o.assigned_employee_id IS NULL OR o.claimed_at IS NULL
            OR u.id IS NULL OR NOT u.is_active OR r.name <> 'EMPLOYEE' OR u.station_id IS DISTINCT FROM o.station_id OR NOT s.is_active)`;
          if (orphaned.length)
            conflicts.push({
              kind: 'orphaned claimed orders',
              ids: orphaned.map((row) => row.id),
            });
        }
        const mismatched = await tx.$queryRaw<
          { id: number }[]
        >`SELECT o.id FROM orders o JOIN pumps p ON p.id = o.pump_id WHERE p.station_id <> o.station_id`;
        if (mismatched.length)
          conflicts.push({
            kind: 'cross-station pump assignments',
            ids: mismatched.map((row) => row.id),
          });
        if (await exists('payments')) {
          const invalid = await tx.$queryRaw<
            { id: number }[]
          >`SELECT DISTINCT o.id FROM orders o JOIN payments p ON p.order_id = o.id
          WHERE o.status IN ('AWAITING_PAYMENT', 'CANCELLED')`;
          if (invalid.length)
            conflicts.push({
              kind: 'unpaid/cancelled orders with payment records',
              ids: invalid.map((row) => row.id),
            });
        }
      }
      const permission = (await exists('role_permissions'))
        ? await tx.$queryRaw<{ present: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
        JOIN permissions p ON p.id = rp.permission_id WHERE r.name = 'CUSTOMER' AND p.key = 'orders.cancel') AS present`
        : [{ present: false }];
      return {
        database: name,
        pending: inventory
          .filter((row) => !names.includes(row.name))
          .map((row) => row.name),
        applied: names,
        conflicts,
        customerCancelProvisioned: permission[0].present,
      };
    },
    { isolationLevel: 'RepeatableRead', timeout: 15000 },
  );
}

export async function verifyOrdersConstraints(tx: Prisma.TransactionClient) {
  const indexes = await tx.$queryRaw<
    { indexname: string; indexdef: string }[]
  >`SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname = 'public' AND indexname IN ('orders_active_pump_key', 'payments_confirmed_cash_order_key',
      'orders_quote_id_key', 'orders_creation_key_key', 'selling_prices_fuel_type_id_currency_effective_at_key', 'attendance_one_open_per_employee')`;
  assert.equal(indexes.length, 6, 'Required unique indexes are missing');
  for (const index of indexes)
    assert(index.indexdef.includes('UNIQUE'), 'Required index is not unique');
  const pump = indexes.find(
    (row) => row.indexname === 'orders_active_pump_key',
  )!;
  assert(
    pump.indexdef.includes('pump_id') &&
      pump.indexdef.includes('PENDING') &&
      pump.indexdef.includes('IN_PROGRESS') &&
      pump.indexdef.includes('WHERE'),
    'Active pump index predicate differs',
  );
  const cash = indexes.find(
    (row) => row.indexname === 'payments_confirmed_cash_order_key',
  )!;
  assert(
    cash.indexdef.includes('order_id') &&
      cash.indexdef.includes('CASH') &&
      cash.indexdef.includes('confirmed_at') &&
      cash.indexdef.includes('IS NOT NULL'),
    'Cash index predicate differs',
  );
  const constraints = await tx.$queryRaw<
    { conname: string; convalidated: boolean }[]
  >`SELECT conname, convalidated FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace AND conname IN ('orders_active_pump_required_check',
      'payments_cash_confirmation_check', 'orders_checkout_snapshot_check', 'order_quotes_identity_check',
      'order_quotes_positive_values', 'order_quotes_expiry_check', 'selling_prices_positive_price', 'payments_confirmed_by_id_fkey')`;
  assert.equal(
    constraints.length,
    8,
    'Required database constraints are missing',
  );
  assert(
    constraints.every((row) => row.convalidated),
    'A required constraint is not validated',
  );
}

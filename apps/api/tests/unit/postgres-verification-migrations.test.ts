import { resolve } from 'node:path';
import { assertReviewedMigrationHistory } from '../../scripts/postgres-verification-migrations.js';
import { ordersMigrationInventory } from '../../scripts/orders-verification-preflight.js';

const names = ordersMigrationInventory(resolve('prisma/migrations')).map(
  (migration) => migration.name,
);

it('accepts the reviewed repository history including current order/payment/pump constraints', () => {
  expect(() => assertReviewedMigrationHistory(names)).not.toThrow();
});

it.each([
  ['historical attendance-only history', names.slice(0, 8)],
  ['missing historical migration', names.slice(1)],
  ['missing current migration', names.slice(0, -1)],
  ['unreviewed later migration', [...names, '20990101000000_unreviewed']],
  ['renamed migration', [...names.slice(0, -1), '20261122220000_renamed']],
  ['reordered history', [...names].reverse()],
  ['duplicate migration', [...names, names[names.length - 1]]],
])('fails closed for %s', (_label, history) => {
  expect(() => assertReviewedMigrationHistory(history)).toThrow(
    'Review PostgreSQL verification scenarios',
  );
});

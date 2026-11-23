import assert from 'node:assert/strict';

// These harnesses contain historical migration scenarios. New migrations must
// be reviewed for fixture/constraint compatibility before either harness writes.
const reviewedMigrations = [
  '20261104110906_init',
  '20261105085846_add_authentication',
  '20261114150000_add_station_status',
  '20261117090000_add_user_token_version',
  '20261117100000_add_reference_fuel_prices',
  '20261117110000_preserve_provider_price_units',
  '20261119090000_add_shifts_and_attendance',
  '20261121130000_employee_attendance',
  '20261121170000_employee_order_work',
  '20261122190000_selling_prices_order_quotes',
  '20261122210000_cash_confirmation',
  '20261122220000_active_pump_reservations',
  '20261123160000_unique_station_manager',
] as const;

export function assertReviewedMigrationHistory(names: readonly string[]) {
  const message =
    'Review PostgreSQL verification scenarios before using a changed migration history';
  // Compare length and primitive names in order. Array prototypes can belong
  // to different realms under Jest; that must not reject identical histories.
  assert.equal(names.length, reviewedMigrations.length, message);
  reviewedMigrations.forEach((name, index) => {
    assert.equal(names[index], name, message);
  });
}

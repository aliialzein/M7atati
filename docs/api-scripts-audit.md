# API scripts audit

Current frontend contracts and the mounted 52-endpoint inventory are in the
[frontend API guide](frontend-api-guide.md). Task-specific counts and verification
claims below are dated historical snapshots, not current backend readiness.

## Task 01 verification baseline (2026-11-23)

The current repository has 31 files in `apps/api/scripts` and 12 existing SQL
migrations. This section supersedes the historical migration-guard limitations
below. No application policy, API contract, Prisma schema or migration was changed.

Runtime support is Node >=24.0.0 (`package.json`); CI selects Node 25. npm has no
declared version constraint or `packageManager` pin. Baseline execution used Node
25.1.0 and npm 10.9.0 with the already installed dependencies. No install ran.

The original database-free Jest baseline passed: 32 suites / 1,083 tests (16 unit
suites / 155 tests; 16 HTTP/lifecycle suites / 928 tests), no skipped/todo tests.
All HTTP suites mock Prisma; lifecycle tests also mock listening. Other tests use
pure functions or supplied doubles. The PDF subprocess reads stdin, and the
verification-safety subprocess deliberately fails before database imports.
Supertest uses temporary local listeners; no persistent application server is
started. No routine suite depends on existing database data or a live provider.

After repairs, the full run passed **33 suites / 1,091 tests** (17 unit suites /
163 tests and 16 HTTP/lifecycle suites / 928 tests), exit 0, no skipped/todo tests
or snapshots. The eight added tests cover only the migration guard. An intermediate
run failed one new test because Node 25's strict array equality compared realm
prototypes under Jest; exact length and ordered primitive-name comparisons fixed
that without relaxing the allowlist. Its targeted rerun passed all eight tests.
The original run took 84.801 s; the final run took 976.246 s, including unusually
slow order-creation and manager-order suites. Functional results reproduced, but
timing stability is not established and the slowdown's cause was not verified.
Negative HTTP cases emit expected error logs and the mocked readiness failure
emits a warning; neither demonstrates a live database failure.

Final no-emit TypeScript, API ESLint, API build and `git diff --check` all exited 0.
Test JSON evidence is in the OS temporary directory as
`m7atati-task01-jest-before.json`, `m7atati-task01-jest-after.json` (intermediate
failure), and `m7atati-task01-jest-final.json`; no test report was committed.

Backend no-emit TypeScript, ESLint, the backend emitting build and `git diff
--check` passed before repairs. Build output is confined to ignored `apps/api/dist`
and includes compiled source, tests and scripts. The build does not run them.

Database-backed execution remains **BLOCKED**: sanitized configuration inspection
found only the primary `localhost:5432/m7atati` target, with no explicit disposable
target. No database connection, database creation/drop, migrations, fixture writes,
seed, provisioning or real PostgreSQL acceptance ran for Task 01. An unconfigured
disposable target is not a passed database check. Earlier rollout claims in other
documents are historical evidence, not execution during this task.

### Verification-only repairs

- `postgres-verification-migrations.ts` shares the exact reviewed 12-migration
  allowlist between the historical station and employee-attendance harnesses.
  Missing, renamed, reordered or additional migrations still fail closed. Both
  callers check it before connecting or creating temporary directories/databases.
- Station verification retains its historical two-migration stage and then deploys
  the remaining reviewed existing migrations. Application-database guards remain.
- Employee-attendance verification applies only migrations preceding its target,
  proves duplicate-open rejection and successful index creation, and then applies
  later reviewed SQL before importing current services. It still requires an
  initially empty disposable database and does not create Prisma migration ledger
  entries: do not reuse that database with `migrate deploy` or the order runner.
- Its transfer/check-in barrier now waits before the transfer's user row lock.
  This avoids holding a lock needed by the winning check-in's FK insertion while
  waiting for that insertion to commit. Both winner assertions remain unchanged.
- Queue claim-race fixtures allocate a distinct pump under the fixture advisory
  lock. They preserve existing reservations instead of violating the current
  one-active-order-per-pump constraint before the race begins.
- The reference-price correction fixture updates original provider price together
  with normalized price, preserving the existing conversion-metadata CHECK.

The new unit guard tests validate acceptance of current history and rejection of
seven changed-history cases. These tests do not claim PostgreSQL verification.

### PostgreSQL entry points and mutation boundaries

| Entry point | Reads/writes and coverage | Lifecycle and prerequisites |
| --- | --- | --- |
| `verify-stations-postgres.ts` (default) | Migration metadata; stations/users/roles/grants/sessions, fuel types/reference prices, pumps/orders/events/payments; real station HTTP/coordinate/status/scope and relationship preservation checks; invokes station-grant provisioning | Connects to configured local `m7atati` only as the source/administrative connection. Creates a random `m7atati_stage1_verify_<hex>` database, deploys copied existing migrations there, and attempts to drop it and remove scratch files in `finally`. Requires explicit approval for creation/drop and PostgreSQL CREATEDB privileges. Never run merely to inspect configuration. |
| Same runner `--users` / `verify-users-postgres.ts` | Users, roles, permissions, links, stations, sessions and call sessions; real login, role/scope, lifecycle and user mutation acceptance | Helper relies on isolated caller and confirms disposable database identity; writes persist until caller drops DB. |
| Same runner `--prices` / `verify-prices-postgres.ts` | Fuel types/prices/refresh cooldown, users/roles/grants/sessions; precision, uniqueness, correction/history and ingestion races | Provider transport is synthetic. Pricing CLI grants are provisioned inside disposable target. Fetch/key overrides restored in `finally`; caller owns database cleanup. |
| Same runner `--attendance` / `verify-attendance-postgres.ts` | Roles/grants/users/stations/shifts/attendance; storage/time/FK rejection, scoped reads and CSV/PDF exports | Includes attempted user/station DELETE statements expected to fail under FK constraints; disposable only. Caller drops fixtures. |
| Same runner `--transfers` / `verify-transfers-postgres.ts` | Users/stations/roles/grants/sessions/shifts/attendance; transfer history/conflicts, real rollback and Serializable races | Creates temporary revocation trigger/function, removes these in `finally`; also deletes its test shifts. Caller owns whole-database cleanup. |
| `verify-employee-attendance-postgres.ts` | Existing migration SQL; roles/users/stations/attendance; duplicate-open migration failure, unique index, idempotency, check-in and transfer races; service queries also touch shifts/orders/sessions | Explicit `EMPLOYEE_ATTENDANCE_TEST_DATABASE_URL`, loopback `m7atati_employee_verify_*`, `ALLOW_EMPLOYEE_ATTENDANCE_TEST_WRITES=yes`, initially empty public schema. Deletes only its manufactured duplicate, but retains schema/fixtures. Disconnects; does not drop/reset DB. |
| `verify-employee-orders-postgres.ts` | Roles/grants/fuel types/stations/pumps/users/orders/events; repeatable fixture, persisted queue across API restarts, cross-station isolation and two-process claim race | Explicit `EMPLOYEE_ORDERS_TEST_DATABASE_URL`, loopback `m7atati_employee_orders_verify_*`, `ALLOW_EMPLOYEE_ORDER_FIXTURES=yes`, valid fixture password, current migrated schema. Spawns short-lived HTTP probes. Retains fixtures/new race pump/order. |
| `verify-employee-order-consistency-postgres.ts` | Above order fixtures plus admin/security users; claim/completion event rollback, employee transfer/role/status versus claims, station status versus claims in both orders | Same fixture URL guard, existing current schema. Temporarily replaces repository methods and restores them in `finally`. Appends retained fixtures; disconnects without data cleanup. |
| `verify-orders-postgres.ts --preflight` | Database-enforced READ ONLY transaction: identity/schema, ordered migration prefix/checksums, legacy-data conflicts, grants | Exact dedicated URL/name confirmation; excludes application environment database names; no primary URL fallback. No mutations. A valid connection is still required. |
| Same runner `--migrate` | Runs existing `migrate deploy` on confirmed disposable target, then checks metadata, six unique indexes and eight validated constraints | Separate `ALLOW_ORDERS_VERIFY_MUTATIONS=yes`; no reset, db push, seed or automatic repair. Requires reviewed preflight and authorized dedicated database. |
| Same runner `--verify` / `orders-postgres-scenarios.ts` | Roles/grants/users/stations/pumps/fuel/tariffs/quotes/orders/payments/events, plus consistency-runner fixtures; real quote/create/tracking/cancel/cash/fulfillment, concurrency and event-FK rollback | Requires all existing migrations applied and constraints present. Provisions CUSTOMER cancellation grant only in disposable DB. Calls consistency verifier afterward. Retains marked fixtures; no global rollback. |
| `preflight-employee-attendance.sql` | Duplicate-open SELECT in explicit READ ONLY transaction | No writes or database lifecycle; choose target explicitly. Not executed during Task 01. |

None of these multi-step writing verifiers is wrapped in one global rollback.
Individual business transactions roll back on failure; earlier successful setup
writes remain unless the station harness successfully drops its entire database.
Cleanup is **not guaranteed** after process termination, connection loss, or an
earlier awaited cleanup failure. Use fresh, approved disposable targets and inspect
failures; never automatically delete/reset a database to make a retry pass.

Provisioning entry points (`create-admin`, all six `provision-*` CLIs), their
permission/bootstrap helpers and `customer-order-permissions.ts` are writers, not
read-only verifiers. They update users/roles/permissions/role links as implemented;
they are not startup tasks. `employee-orders-fixture.ts` is also a writer except
its queue-read probe; its `--race` probe changes orders/events. The general seed
replaces role-permission links and is not part of baseline verification.

### Reproduce database-free checks

Run from the monorepo root in PowerShell, using installed dependencies:

```powershell
node .\node_modules\typescript\bin\tsc -p apps/api/tsconfig.json --noEmit --incremental false
npm.cmd run lint --workspace @smart-fuel-station/api
git diff --check
npm.cmd run test --workspace @smart-fuel-station/api -- --verbose=false
npm.cmd run build --workspace @smart-fuel-station/api
```

For machine-readable test counts without a tracked artifact:

```powershell
$reportPath = Join-Path ([IO.Path]::GetTempPath()) 'm7atati-task01-jest.json'
npm.cmd run test --workspace @smart-fuel-station/api -- --json --outputFile $reportPath --silent --verbose=false
```

### Disposable PostgreSQL commands (not executed for Task 01)

Supply credentials through a protected process environment; never paste a real URL
into documentation/output. Have an administrator identify a disposable database,
check it differs from all application databases, inspect its migration state and
approve the retained writes first. No database-creation or cleanup command is
authorized by these examples.

The order runner requires `ORDERS_VERIFY_DATABASE_URL` naming a loopback database
`m7atati_employee_orders_verify_*` and `ORDERS_VERIFY_CONFIRM_DATABASE` equal to its
exact database name. It also checks the connected identity and public schema.

```powershell
if (-not $env:ORDERS_VERIFY_DATABASE_URL -or -not $env:ORDERS_VERIFY_CONFIRM_DATABASE) { throw 'Set an approved disposable URL and exact database name first.' }
node --import tsx apps/api/scripts/verify-orders-postgres.ts --preflight
if ($LASTEXITCODE -ne 0) { throw 'Preflight failed; stop and review.' }
# Only after reviewing preflight and authorizing existing migrations/fixture writes:
$env:ALLOW_ORDERS_VERIFY_MUTATIONS = 'yes'
node --import tsx apps/api/scripts/verify-orders-postgres.ts --migrate
if ($LASTEXITCODE -ne 0) { throw 'Disposable migration check failed; stop and review.' }
node --import tsx apps/api/scripts/verify-orders-postgres.ts --verify
if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL verification failed; inspect retained fixtures.' }
```

Do not continue to the next command after a nonzero exit. `--verify` additionally
requires current migrations/constraints and retains marked data. It is not a
substitute for the station/users/pricing/attendance/transfer acceptance paths.

For the station harness, separately approve its random database creation/drop and
scratch-file writes, inspect source configuration (local `m7atati`, development),
and confirm CREATEDB/drop privileges before running each isolated invocation:

```powershell
node --import tsx apps/api/scripts/verify-stations-postgres.ts
node --import tsx apps/api/scripts/verify-stations-postgres.ts --users
node --import tsx apps/api/scripts/verify-stations-postgres.ts --prices
node --import tsx apps/api/scripts/verify-stations-postgres.ts --attendance
node --import tsx apps/api/scripts/verify-stations-postgres.ts --transfers
```

For dedicated attendance migration verification, approve a separate initially
empty `m7atati_employee_verify_*` database and set its explicit URL/write flag:

```powershell
if (-not $env:EMPLOYEE_ATTENDANCE_TEST_DATABASE_URL) { throw 'Set an approved empty disposable attendance URL first.' }
$env:ALLOW_EMPLOYEE_ATTENDANCE_TEST_WRITES = 'yes'
node --import tsx apps/api/scripts/verify-employee-attendance-postgres.ts
```

For retained queue fixtures, set `EMPLOYEE_ORDERS_TEST_DATABASE_URL` to a separate
approved current-schema target and `EMPLOYEE_ORDER_FIXTURE_PASSWORD` to an explicit
test-only password satisfying registration validation. Do not reuse an arbitrary
existing database based only on its name:

```powershell
if (-not $env:EMPLOYEE_ORDERS_TEST_DATABASE_URL -or -not $env:EMPLOYEE_ORDER_FIXTURE_PASSWORD) { throw 'Set an approved migrated disposable URL and test-only fixture password first.' }
$env:ALLOW_EMPLOYEE_ORDER_FIXTURES = 'yes'
node --import tsx apps/api/scripts/verify-employee-orders-postgres.ts
node --import tsx apps/api/scripts/verify-employee-order-consistency-postgres.ts
```

### Future hardening coverage locations (no future-policy tests added)

| Planned task | Extend database-free coverage | Extend real PostgreSQL coverage |
| --- | --- | --- |
| Employee role changes with open attendance | `tests/integration/users.test.ts`, `employee-attendance.test.ts` | `verify-users-postgres.ts`, `verify-employee-attendance-postgres.ts` |
| Paid PENDING / IN_PROGRESS station deactivation | `stations.test.ts`, `cash-confirmation.test.ts`, `unit/order-station-concurrency.test.ts` | `orders-postgres-scenarios.ts`, `verify-employee-order-consistency-postgres.ts` |
| One manager per station / one station per manager, reassignment | `stations.test.ts`, `users.test.ts`, `manager-orders.test.ts`, `manager-attendance.test.ts` | `verify-stations-postgres.ts`, `verify-users-postgres.ts`; future SQL uniqueness/concurrency checks |
| Pump lookup/availability and reservations | `cash-confirmation.test.ts`, future lookup HTTP cases | `orders-postgres-scenarios.ts` already covers competing reservations and release |
| Fuel-type lookup authorization | Extend existing order/pricing HTTP suites with actual future route | `orders-postgres-scenarios.ts` / `verify-prices-postgres.ts` |
| Effective permissions in auth responses | `auth.test.ts`, session/role regression cases in `users.test.ts` | `verify-users-postgres.ts` login/refresh/me and revocation cases |

Current ownership tests intentionally allow a manager to own multiple stations;
future uniqueness work must update those fixtures and assertions after the policy
and migration are implemented. Current auth responses intentionally omit effective
permissions. No future business decision was implemented in this task.

## Historical inventory

Audited the current `feat/Employee_Functionalities` checkout at HEAD
`edb027ddaf4d34f9f7922e00016b177ad89b7f5d`, including uncommitted Employee Stages
1–4. No script was deleted, moved or executed for this audit. The only script
edit changes two imports in `verify-employee-attendance-postgres.ts` to the
consolidated attendance directory.

Evidence checked: root and API package scripts, `.github/workflows/ci.yml`,
README/docs, all API tests, script-to-script imports/dynamic imports and subprocess
arguments, and application imports. Standalone manual tools are not unused just
because they have no npm entry. Helper modules are not standalone CLIs.

## Invocation conventions

All commands below start at the repository root:

- **N(name)**: `npm run <name> --workspace @smart-fuel-station/api`.
- **T(file)**: `node --import tsx apps/api/scripts/<file>`.
- **H(flag)**: `node --import tsx apps/api/scripts/verify-stations-postgres.ts <flag>`.

These document existing entry points, not permission to run them. Deployment
tools write to the configured database. PostgreSQL verification and fixture tools
also perform writes and require a separately authorized disposable target.

## Deployment tools (including imported helpers)

| File in `apps/api/scripts`                     | Purpose                                                                                                | Invocation and references                                                                                                          | Classification             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `create-admin.ts`                              | Bootstrap the first ADMIN from explicit environment credentials; refuses when an ADMIN already exists. | N(create-admin); `docs/user-management.md`; imports admin-provisioning.                                                            | Deployment CLI; retain.    |
| `admin-provisioning.ts`                        | Validate/hash initial admin credentials and create the initial account transactionally.                | Imported by create-admin; exercised by `tests/unit/admin-provisioning.test.ts`. No standalone invocation.                          | Deployment helper; retain. |
| `provision-station-permissions.ts`             | Add missing ADMIN station grants using the configured database.                                        | N(provision-station-permissions); station-management docs; subprocess in verify-stations.                                          | Deployment CLI; retain.    |
| `station-permissions.ts`                       | Definitions and additive ADMIN stations.read/create/update grants.                                     | Imported by provision-station-permissions; `tests/unit/station-permissions.test.ts`; user-management docs reference the helper.    | Deployment helper; retain. |
| `provision-pricing-permissions.ts`             | Add missing ADMIN pricing grants.                                                                      | N(provision-pricing-permissions); fuel-prices docs; subprocess in verify-prices.                                                   | Deployment CLI; retain.    |
| `pricing-permissions.ts`                       | Definitions and additive ADMIN pricing.read/update grants.                                             | Imported by provision-pricing-permissions. Pricing verification exercises the CLI/helper through the guarded harness.              | Deployment helper; retain. |
| `provision-attendance-permissions.ts`          | Add attendance/shift read grants without replacing unrelated grants.                                   | N(provision-attendance-permissions); attendance and manager-attendance docs.                                                       | Deployment CLI; retain.    |
| `attendance-permissions.ts`                    | Add ADMIN/HR attendance.read and shifts.read, and MANAGER attendance.read.                             | Imported by provision-attendance-permissions, verify-attendance and verify-transfers; `tests/unit/attendance-permissions.test.ts`. | Deployment helper; retain. |
| `provision-transfer-permissions.ts`            | Add missing employee-transfer grants.                                                                  | N(provision-transfer-permissions); user-management docs.                                                                           | Deployment CLI; retain.    |
| `transfer-permissions.ts`                      | Add employees.transfer to ADMIN/HR while preserving other grants.                                      | Imported by provision-transfer-permissions and verify-transfers; `tests/unit/transfer-permissions.test.ts`.                        | Deployment helper; retain. |
| `provision-employee-attendance-permissions.ts` | Add the targeted employee attendance write grant.                                                      | N(provision-employee-attendance-permissions); employee-attendance docs.                                                            | Deployment CLI; retain.    |
| `employee-attendance-permissions.ts`           | Add EMPLOYEE attendance.self.write only.                                                               | Imported by provision-employee-attendance-permissions; `tests/unit/employee-attendance-permissions.test.ts`.                       | Deployment helper; retain. |
| `provision-employee-shift-permissions.ts`      | Add the targeted employee schedule-read grant.                                                         | N(provision-employee-shift-permissions); employee-shifts docs.                                                                     | Deployment CLI; retain.    |
| `employee-shift-permissions.ts`                | Add EMPLOYEE shifts.read only; preserve HR/Admin grants.                                               | Imported by provision-employee-shift-permissions; `tests/unit/employee-shift-permissions.test.ts`.                                 | Deployment helper; retain. |

## Verification tools

| File in `apps/api/scripts`               | Purpose                                                                                                                                                                                                                                                                 | Invocation and references                                                                                                                                                                                                                                     | Classification                                                             |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `preflight-employee-attendance.sql`      | Read-only duplicate-open-attendance report before the unique-index migration; changes no records.                                                                                                                                                                       | `psql "$env:DATABASE_URL" -X -v ON_ERROR_STOP=1 -f apps/api/scripts/preflight-employee-attendance.sql`; employee-attendance and employee-order-work docs.                                                                                                     | Verification/preflight tool; retain.                                       |
| `verify-stations-postgres.ts`            | Main disposable PostgreSQL harness: creates a randomly named database, checks migration history, executes station acceptance or a flagged verification module, then drops the disposable DB and temporary migration directory.                                          | T(verify-stations-postgres.ts), optionally --users/--prices/--attendance/--transfers; station-management, authentication, user-management, fuel-prices, attendance and manager-attendance docs. Invokes provisioning CLIs only against its disposable target. | Verification CLI; retain, migration guard currently blocks it (see below). |
| `verify-users-postgres.ts`               | Real auth/user-management acceptance, role/station isolation, permissions, CSRF, safe responses and account lifecycle cases.                                                                                                                                            | Dynamic import by H(--users); documented through the harness in authentication/user-management/fuel-prices docs. Exports a helper, not a standalone main.                                                                                                     | Verification helper; retain.                                               |
| `verify-prices-postgres.ts`              | Real PostgreSQL/Express pricing acceptance and targeted permission CLI checks with a synthetic upstream-provider transport.                                                                                                                                             | Dynamic import by H(--prices); fuel-prices docs. Exports a helper, not a standalone main.                                                                                                                                                                     | Verification helper; retain.                                               |
| `verify-attendance-postgres.ts`          | Real attendance/shift and Manager-report acceptance, filtering/history, authorization and permission-provisioning checks.                                                                                                                                               | Dynamic import by H(--attendance); attendance and manager-attendance docs; imports attendance permission helper and attendance test fixtures.                                                                                                                 | Verification helper; retain.                                               |
| `verify-transfers-postgres.ts`           | Real employee-transfer acceptance, authorization, session/assignment behavior and transaction races.                                                                                                                                                                    | Dynamic import by H(--transfers); user-management docs; imports transfer and attendance permission helpers.                                                                                                                                                   | Verification helper; retain.                                               |
| `verify-employee-attendance-postgres.ts` | Against an explicitly authorized empty disposable database: verify migration rejection for duplicate open records, unique index, idempotency, concurrent check-ins and transfer races. Applies test migrations and manufactures test records on that disposable target. | T(verify-employee-attendance-postgres.ts); employee-attendance docs. Requires EMPLOYEE_ATTENDANCE_TEST_DATABASE_URL and ALLOW_EMPLOYEE_ATTENDANCE_TEST_WRITES=yes. Imports the relocated employee attendance service/repository and user service/repository.  | Verification CLI; retain, migration guard currently blocks it (see below). |
| `verify-employee-orders-postgres.ts`     | Reuse guarded fixtures, check two employees share persisted station rows across API process restarts, check station isolation, and race two claims to verify one winner/event and matching persisted metadata. Adds a marked race order per run.                        | T(verify-employee-orders-postgres.ts); employee-orders and employee-order-work docs. Imports employee-orders-fixtures and spawns employee-orders-fixture --probe/--race.                                                                                      | Verification CLI; retain.                                                  |

## Fixtures

| File in `apps/api/scripts`    | Purpose                                                                                                                                                                                                               | Invocation and references                                                                                                                                                         | Classification                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `employee-orders-fixture.ts`  | Explicit guarded fixture CLI; creates/reuses two stations, matching pumps, PENDING orders/initial events and three test employees. Also provides listening API subprocess probes and the claim race for verification. | N(fixture-employee-orders); employee-orders/employee-order-work docs; spawned by verify-employee-orders-postgres with --probe, --employee and optionally --race/--second/--order. | Fixture CLI and verification probe; retain. |
| `employee-orders-fixtures.ts` | Disposable URL/write-authorization guard and repeatable transactional fixture helper; adds only needed fixture role grants and preserves existing fixture state.                                                      | Imported by employee-orders-fixture and verify-employee-orders-postgres; `tests/unit/employee-orders-fixtures.test.ts`. No startup registration.                                  | Fixture helper; retain.                     |

Order fixture/probe/verifier paths require EMPLOYEE_ORDERS_TEST_DATABASE_URL,
ALLOW_EMPLOYEE_ORDER_FIXTURES=yes, and the guarded local database-name convention.
Fixture creation and the verifier additionally require the explicit fixture
password. The existing schema must already be installed. No development URL
fallback exists.

## CI and current limitations

CI runs root `npm run lint`, `npm run test`, and `npm run build`. The API lint and
TypeScript configuration cover scripts; routine Jest imports the unit-tested
helpers listed above with mocked databases. CI does not directly run provisioning,
fixtures, the SQL preflight or any PostgreSQL verifier.

Two existing migration guards intentionally reject this checkout's later
`20261121170000_employee_order_work` migration:

- `verify-stations-postgres.ts` asserts an exact migration list ending at
  `20261121130000_employee_attendance`. It creates its disposable database before
  that assertion, then cleans it up on failure. All its flagged helper runs share
  this limitation.
- `verify-employee-attendance-postgres.ts` asserts that employee-attendance is the
  latest migration before applying any test migration.

These are referenced tools needing a separately scoped verifier update, **not
deletion candidates**. Their guards and behavior are unchanged by this refactor.
No PostgreSQL verifier, provisioning CLI or fixture command was run here.

All 24 files have an npm, documented manual, import, test or subprocess use path.
There are **no confirmed unused scripts or deletion candidates** in this audit.

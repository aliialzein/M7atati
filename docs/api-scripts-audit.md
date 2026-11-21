# API scripts audit

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

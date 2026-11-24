# API scripts audit

Current API contracts remain in the authoritative [frontend API guide](frontend-api-guide.md).
This inventory reflects the post-cleanup repository on 2026-11-24, branch
`Backend_Hardening`. PostgreSQL acceptance runners were intentionally removed.
Historical successful acceptance remains evidence, but it cannot be rerun with
this checkout's remaining tooling. No PostgreSQL connection or database-mutating
command was used during this review.

## Remaining scripts: 18 files

All paths below are relative to `apps/api/scripts/`. All are retained. CLI commands
are maintenance/development entry points; helper modules do not execute simply
because they are imported. The TypeScript checks cover every remaining TS script.
No provisioning, fixture, seed or database operation was executed for this audit.

| File | Purpose and callers | Dependencies | Operational / development | Database writes |
| --- | --- | --- | --- | --- |
| `admin-provisioning.ts` | Bootstrap first administrator; `create-admin.ts` and unit test | Auth validator/password service, users repository/mapper | Operational helper | Creates first admin transactionally; rejects existing admin |
| `create-admin.ts` | API package `create-admin` CLI | Prisma/config, admin helper, Zod/HttpError | Operational CLI | Calls bootstrap helper |
| `attendance-permissions.ts` | Global attendance/shift read grants; provisioning CLI and unit tests | Generated Prisma types, HttpError | Operational helper | Additive permission/grant upserts |
| `customer-order-permissions.ts` | Customer `orders.cancel` grant; dedicated unit tests, exported maintenance helper | Generated Prisma types, HttpError | Operational helper; no standalone CLI | Additive permission/grant upserts; never creates missing role |
| `employee-attendance-permissions.ts` | Self-attendance grant; provisioning CLI and unit tests | Generated Prisma types, HttpError | Operational helper | Additive employee grant upserts |
| `employee-orders-fixture.ts` | API package `fixture-employee-orders`; explicit fixture CLI and optional HTTP probe | Guarded fixture helper, Prisma adapter/client, auth/app for probe | Development only | Default writes fixtures; probe reads queue, probe race claims orders |
| `employee-orders-fixtures.ts` | Fixture creation and target guard; fixture CLI and unit tests | Generated Prisma types, Node assert | Development helper | Transactional fixture/grant writes; advisory lock; no migration or database creation |
| `employee-shift-permissions.ts` | Weekly-shift grant; provisioning CLI and unit tests | Generated Prisma types, HttpError | Operational helper | Additive employee grant upserts |
| `preflight-employee-attendance.sql` | Manual duplicate-open-attendance inspection; employee attendance/order docs | PostgreSQL attendance table | Operational read-only SQL | None; explicit READ ONLY transaction |
| `pricing-permissions.ts` | ADMIN pricing grants; provisioning CLI | Generated Prisma types, HttpError | Operational helper | Additive permission/grant upserts |
| `provision-attendance-permissions.ts` | API package command, attendance docs | dotenv, adapter/client, attendance helper | Operational CLI | Calls grant helper |
| `provision-employee-attendance-permissions.ts` | API package command, employee-attendance docs | dotenv, adapter/client, employee-attendance helper | Operational CLI | Calls grant helper |
| `provision-employee-shift-permissions.ts` | API package command, employee-shifts docs | dotenv, adapter/client, employee-shift helper | Operational CLI | Calls grant helper |
| `provision-pricing-permissions.ts` | API package command, fuel-prices docs | dotenv, adapter/client, pricing helper | Operational CLI | Calls grant helper |
| `provision-station-permissions.ts` | API package command, station docs | dotenv, adapter/client, station helper | Operational CLI | Calls grant helper |
| `provision-transfer-permissions.ts` | API package command, user docs | dotenv, adapter/client, transfer helper | Operational CLI | Calls grant helper |
| `station-permissions.ts` | ADMIN station grants; CLI and unit tests | Generated Prisma types, HttpError | Operational helper | Additive permission/grant upserts |
| `transfer-permissions.ts` | ADMIN/HR transfer grants; CLI and unit tests | Generated Prisma types, HttpError | Operational helper | Additive permission/grant upserts |

All six permission-provisioning CLI commands remain available. No essential
operational file was among the manual deletions. The customer-grant helper is
retained with its two original tests; it is an exported function requiring an
explicit Prisma client, not a package command. The seed independently defines
customer cancellation grants.

The fixture CLI remains supported, but there is no automated queue/restart/race
acceptance orchestrator. Its target guard requires explicit local disposable URL
and write authorization; it never creates a database or falls back to `m7atati`.
The developer reports that all five earlier targets were deleted. Do not use the
primary or maintenance database for fixtures. No new target is authorized by this
review.

## Removed files and classifications

The developer manually deleted these 11 PostgreSQL verification scripts (some
were modules invoked by the station runner):

- `verify-attendance-postgres.ts`: attendance/shift/report verification module.
- `verify-employee-attendance-postgres.ts`: self-attendance/migration/role races.
- `verify-employee-order-consistency-postgres.ts`: employee lifecycle/claim races.
- `verify-employee-orders-postgres.ts`: queue persistence/restart/HTTP claim races.
- `verify-manager-ownership-postgres.ts`: ownership/eligibility concurrency.
- `verify-orders-postgres.ts`: guarded order acceptance orchestrator.
- `verify-prices-postgres.ts`: reference price/ingestion verification module.
- `verify-station-pumps-postgres.ts`: pump availability/concurrency/rollback.
- `verify-stations-postgres.ts`: disposable database/migration/domain orchestrator.
- `verify-transfers-postgres.ts`: transfer/session/rollback verification module.
- `verify-users-postgres.ts`: user lifecycle/authorization verification module.

Cleanup removed four now-orphaned verification helpers, not application services:

- `orders-postgres-scenarios.ts`: sole runner was deleted; no runtime caller.
- `orders-verification-preflight.ts`: only obsolete infrastructure tests remained.
- `orders-verification-safety.ts`: only obsolete infrastructure tests remained.
- `postgres-verification-migrations.ts`: only obsolete infrastructure tests remained.

The 13 migration directories, Prisma schema and generated client are unchanged.
No package command, seed, CI job or application import invokes these deleted files.
No obsolete npm verification command existed to remove. Ignored stale compiled
copies of the 15 scripts and two old test files were removed by exact file path;
a normal TypeScript build does not prune deleted source output.

## Test accounting

Previous baseline: 36 suites / 1,226 tests. Only removed-runner infrastructure
coverage was retired:

| Former suite | Removed tests | Reason |
| --- | --- | --- |
| `orders-verification-safety.test.ts` | 23 | 1 explicit target test; 9 invalid URL cases; 1 protected-name test; 5 opt-in rejection cases; 1 opt-in acceptance; 1 migration inventory/hash test; 3 deleted-runner startup checks; 2 deleted pump-runner checks |
| `postgres-verification-migrations.test.ts` | 8 | 1 accepted reviewed-history case; 7 changed-history rejection cases for removed verifier guard |

The two customer-grant tests were copied without changing their bodies to
`tests/unit/customer-order-permissions.test.ts`; their original mixed suite was
removed. The separate eight employee fixture tests remain, because that CLI and
its guards remain. Expected post-cleanup total: 35 suites / 1,195 tests, a decrease
of one suite and 31 verification-infrastructure tests. No application unit or
HTTP integration regression test was removed or weakened.

## Operational functionality (source inspection only)

- Prisma migration deployment uses the installed Prisma CLI and
  `apps/api/prisma.config.ts`; its migrations directory remains intact.
- Client generation uses the same config and schema generator, with custom output
  `apps/api/src/generated/prisma`. All 28 generated TS files remain tracked; CI
  still relies on checked-in output rather than a generation step.
- Seed configuration points to `apps/api/prisma/seed.ts`. Its imports resolve to
  dotenv, Prisma adapter/client and Node builtins; none references deleted files.
  The seed upserts roles/permissions then **replaces role-permission assignments**;
  it is not equivalent to additive provisioning and was not executed here.
- `create-admin` and six additive provisioning commands retain their CLI/helper
  pairs and package entries.
- API `dev` uses `tsx watch src/server.ts`; `build` uses TypeScript;
  `start` uses `node dist/src/server.js`; `test` uses Jest.
- Root workspace scripts, TypeScript/Jest configs and CI do not name removed
  runners. CI continues to install, lint, run database-mocked tests and build.

## Historical acceptance evidence and limitations

Task 08 completed full guarded local PostgreSQL order acceptance on 2026-11-23.
The Stage 9 defect was a raw Serializable `FOR UPDATE` failure: Prisma P2010
carried SQLSTATE 40001, while transaction retries recognized only P2034. The
bounded retry correction and all five application regression cases remain.
A separate verifier fault-injection fix targeted the actual transaction delegate.
Cash confirmation, idempotency, pump uniqueness, claim/completion, cancellation,
ownership/authorization, transaction rollback and lifecycle races passed then.
See the [unchanged historical scenario results and root cause](frontend-api-guide.md#task-08-observed-stage-9-root-cause-and-postgresql-acceptance).

Task 01's earlier migration-guard baseline (33 suites / 1,091 tests) and Task 09's
pre-removal audit (36 suites / 1,226 tests; static checks passed) were historical
snapshots, not the current inventory. Earlier detailed audit versions remain in
Git history. The developer reports deleting all five disposable acceptance
databases, leaving `m7atati` and `postgres` (excluding PostgreSQL templates). This
review did not query even database names and did not recreate or mutate targets.

No fresh PostgreSQL acceptance is claimed. This checkout no longer has automated
live PostgreSQL concurrency/rollback acceptance runners. Historical evidence and
current mocked application regressions are complementary, not substitutes.
Deployment readiness remains READY WITH CONDITIONS; primary-data compatibility,
secrets, origins/CORS, external provider configuration and operations are not
certified by these checks.

## Post-cleanup regression results

All requested checks passed (exit 0):

- Full backend Jest: **35 suites / 1,195 tests**, no failures or snapshots.
- TypeScript typecheck, including unused-local/parameter checks: passed.
- ESLint and backend build: passed.
- `git diff --check`: passed.
- Mounted HTTP inventory: **52 endpoints across 15 routers**, unchanged.

The 31-test decrease matches the infrastructure-only accounting above. The two
preserved provisioning test bodies match their originals exactly. Application
source, integration tests, schema and migrations have no diff. Repository scans
found no live imports or fenced execution commands referring to removed files.
Remaining mentions in documents are explicitly historical. Nothing was staged
or committed, and no database was contacted.

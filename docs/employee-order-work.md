# Employee Stage 4: claim and complete

Builds on Stages 1–3 without changing Manager demo orders/analytics, attendance,
CSV/PDF reports or weekly shifts. No production creation, cancellation,
reassignment, payments or actual dispensed-volume updates are introduced.

## API contracts

All routes require authenticated EMPLOYEE and send `Cache-Control: no-store`.
Reads require `orders.read`; writes require existing `orders.update` and the
existing allowed Origin plus `X-CSRF-Protection: 1` CSRF header. Fresh installs
already grant both order permissions to EMPLOYEE; no seed/provisioning is needed
for this change. Existing databases missing a grant remain denied; do not run the
general seed to adjust them.

| Request                                                            | Contract                                                                                                                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/employee/orders?status=PENDING&page=1&limit=20`          | Unchanged station-wide PENDING queue and safe projection.                                                                                                     |
| `GET /api/employee/orders/mine?status=IN_PROGRESS&page=1&limit=20` | Only caller-assigned IN_PROGRESS orders at the current active assigned station. Status defaults to IN_PROGRESS and is the only accepted status on this route. |
| `GET /api/employee/orders/123`                                     | Safe station-scoped order detail and progress events, including completed orders.                                                                             |
| `POST /api/employee/orders/123/claim`                              | Empty body or `{}`. Claim an unassigned PENDING order; sets IN_PROGRESS, caller ID and server claimedAt.                                                      |
| `POST /api/employee/orders/123/complete`                           | Empty body or `{}`. Complete caller-assigned IN_PROGRESS work; preserve original claim metadata.                                                              |

Unknown query/body fields are rejected (400), including stationId, employeeId,
assignee, status or timestamps on mutations. Detail accepts no query filters.
Numeric order IDs must be positive integers. My work uses the existing page/limit
defaults and maxima (1/20, page ≤ 1,000,000, limit ≤ 100), creation-time then ID
ascending order, and consistent filtered rows/counts in Repeatable Read.

List responses use `{ dataSource: "database", stationId, orders, pagination }`.
My work orders extend queue fields with `stationId`, nullable `assignedEmployeeId`,
nullable `claimedAt`, and `updatedAt`. Detail and mutation responses use
`{ dataSource: "database", stationId, order }`, adding `events`, ordered by
creation time then ID. Event fields are `id`, `actorUserId`, `actorType`,
`fromStatus`, `toStatus`, `createdAt`. Contact data, event notes, prices, payment
data and dispensed volumes are never selected. Same-station employees may read
safe order details/history; only the assignee may complete or see it in My work.

Missing/inactive assignments return 409. Unknown and out-of-station IDs both
return 404 `{ "message": "Order not found" }`, including retries after transfer.
Competing claimants, wrong assignees and invalid transitions return 409
`Order is no longer available or its status changed`. Authentication and
role/permission failures use 401/403.

## Atomicity and retries

Writes use Serializable transactions and the repository's bounded P2034 retry
pattern. Lock the employee row before re-reading active status, current database
station, station activity, role and orders.update grant. Transfers update this
same row; an action waiting for a committed transfer retries with the new
assignment. Conditional order updates include station, expected status and
assignee. Each successful transition inserts its EMPLOYEE/actorUserId-attributed
event in the same transaction. Event failure rolls back the order change.

A same-employee claim retry returns their IN_PROGRESS or COMPLETED order. A
completion retry returns their COMPLETED order. Neither creates another event,
changes claimedAt/updatedAt, nor moves status backward. Authorization precedes
retry resolution; historic assignment alone cannot authorize a retry. Completing
work sets only status; it does not record a payment or actual fuel delivery.

## Home page

Pending orders has Claim buttons; My work restores persisted work after reload
and has Complete buttons and independent pagination. Both reuse the existing
session client, five-second visible-page polling, focus refresh, cancellation,
stale-data indication and late-response guards. Actions disable duplicate
submissions, refresh both lists and explain 409 conflicts. Assignment changes
invalidate both sections and the last action result. Action responses are also
checked against the current session before display. Successful completion stays
visible in Last order update after it leaves My work. Attendance and shifts stay
independent of order failures.

## Migration review and later deployment

Prepared, **not applied**:
`apps/api/prisma/migrations/20261121170000_employee_order_work/migration.sql`.
It transactionally adds nullable assigned_employee_id/claimed_at to orders, a
restrict-delete User FK, and an assignee/station/status index. Existing rows keep
NULL metadata. No historical data is changed. Prisma Client is regenerated.

After reviewing all pending migrations, and only when ready to update the
explicitly selected database, these commands run from the repository root:

```powershell
# If the Stage 1 attendance migration is still pending, first review this
# read-only preflight output and resolve any duplicates manually.
psql "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/api/scripts/preflight-employee-attendance.sql

# Applies ALL pending migrations, including Stage 1 if still unapplied.
node node_modules/prisma/build/index.js migrate deploy --config apps/api/prisma.config.ts
node node_modules/prisma/build/index.js generate --config apps/api/prisma.config.ts
```

No migration/provisioning or development-database writes were run for Stage 4.

## Verification

The guarded fixture command from [Stage 3](employee-orders.md) now supplies both
orders.read and orders.update to disposable fixture employees, preserving other
grants. It remains explicit and never runs at startup.

Configure the authorized local `EMPLOYEE_ORDERS_TEST_DATABASE_URL` (database name
`m7atati_employee_orders_verify_<suffix>`, existing schema including Stage 4
already deployed), and `EMPLOYEE_ORDER_FIXTURE_PASSWORD`, then:

```powershell
$env:ALLOW_EMPLOYEE_ORDER_FIXTURES = 'yes'
npm run fixture-employee-orders --workspace @smart-fuel-station/api
node --import tsx apps/api/scripts/verify-employee-orders-postgres.ts
```

The verifier retains Stage 3 shared-employee/restart checks and creates one new
marked race order plus initial event per verification run, preserving previous
history. Two employees race through real HTTP claim requests against PostgreSQL;
assert one 200, one 409, one actor-attributed claim event, matching persisted
assignee/status/claimedAt, and untouched delivery/payment fields. Neither fixture
nor verifier applies migrations or falls back to development DATABASE_URL.

API tests cover permissions/CSRF, station/assignee isolation, strict inputs,
invalid transitions, safe history, retries, event rollback, list removal and
restoration. Web tests cover actions, double clicks, conflict refresh, work
pagination/reload and discarded action responses after transfer/logout.
Real PostgreSQL race/persistence checks remain pending without an authorized
disposable target; mocks do not prove database transaction behavior.

## Stage 4 changed files

- `apps/api/prisma/migrations/20261121170000_employee_order_work/migration.sql`
- `apps/api/scripts/employee-orders-fixture.ts`
- `apps/api/scripts/employee-orders-fixtures.ts`
- `apps/api/scripts/verify-employee-orders-postgres.ts`
- `apps/api/src/modules/orders/orders.repository.ts`
- `apps/api/src/modules/orders/orders.routes.ts`
- `apps/api/src/modules/orders/orders.service.ts`
- `apps/api/src/modules/orders/orders.validation.ts`
- `apps/api/tests/integration/employee-order-work.test.ts`
- `apps/web/src/components/employee-order-workspace.tsx`
- `apps/web/src/components/employee-orders.tsx`
- `apps/web/src/components/session-panel.tsx`
- `apps/web/tests/unit/employee-order-workspace.test.tsx`
- `apps/web/tests/unit/employee-orders-home.test.tsx`
- `docs/employee-order-work.md`
- `docs/employee-orders.md`
- `apps/api/prisma/schema.prisma`
- `apps/api/src/app.ts`
- `apps/api/src/generated/prisma/commonInputTypes.ts`
- `apps/api/src/generated/prisma/internal/class.ts`
- `apps/api/src/generated/prisma/internal/prismaNamespace.ts`
- `apps/api/src/generated/prisma/internal/prismaNamespaceBrowser.ts`
- `apps/api/src/generated/prisma/models/AttendanceRecord.ts`
- `apps/api/src/generated/prisma/models/FuelOrder.ts`
- `apps/api/src/generated/prisma/models/User.ts`

Verification completed: 781 API tests across 26 suites (Stage 3: 741), 66 web
tests across 10 suites (Stage 3: 58), API/web typechecks, API/web lint,
Prisma validation and git diff --check. PostgreSQL verification was not run:
no explicitly authorized disposable target was configured. No development
migration/provisioning, staging, commit or push was performed.

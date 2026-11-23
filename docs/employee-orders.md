# Employee Stage 3: persistent pending-order queue

This document describes the read-only pending queue. Current creation, payments,
claiming/completion and persisted Manager APIs are consolidated in the authoritative
[frontend API guide](frontend-api-guide.md). Claim/completion details also appear
in [Employee Stage 4](employee-order-work.md); historical stage exclusions below
do not mean those workflows remain unimplemented.

## Endpoint

```http
GET /api/employee/orders?status=PENDING&page=1&limit=20
```

Requires an active authenticated EMPLOYEE and existing `orders.read` permission.
No additional attendance/shift permission or check-in is required. Responses use
`Cache-Control: no-store`. Other roles are denied even with orders.read.

`status` defaults to PENDING; it is the only accepted status. `page` defaults to 1
(maximum 1,000,000); `limit` defaults to 20 (maximum 100). Unknown/repeated filters,
client stationId/employeeId overrides, unsupported statuses, and invalid pagination
return 400 `{ "message": "Invalid request" }`.

Inside a Repeatable Read transaction, the API re-reads the employee's current
active status, role, assignment, and assigned station status. It does not trust
the station in an older auth profile. Missing assignment returns 409
`An assigned station is required to view pending orders`; inactive station returns
409 `Assigned station is inactive`. Authentication failures are 401 and role or
permission denial is 403.

Rows and count use the same `stationId AND status = PENDING` predicate before
database pagination, ordered by `createdAt ASC, id ASC`. The response is:

```json
{
  "dataSource": "database",
  "stationId": 10,
  "orders": [
    {
      "id": 123,
      "status": "PENDING",
      "createdAt": "2026-11-21T08:00:00.000Z",
      "orderedVolume": "25",
      "pump": { "id": 7, "number": 1 },
      "fuelType": { "id": 1, "name": "Test fuel", "code": "TEST" }
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

Requested volume is serialized as a decimal string. Customer contact/name, notes,
prices, amounts, currency, payments, and creator identity are not selected. Empty
selections have zero totals; an out-of-range page retains the filtered total.
An order no longer PENDING disappears on the next successful read. Employees at
the same station read the same database records regardless of who created them.

## Home-page polling

Only signed-in EMPLOYEE users receive Pending orders. The Stage 1 credentialed
API client and coordinated refresh flow are reused. Load immediately when visible,
then schedule the next poll five seconds after the current request completes.
Focus or visibility restoration triggers an immediate refresh. Hidden pages do
not poll; focus/visibility/timer events cannot overlap an in-flight request.

Every refresh first checks `/api/auth/me`, to detect assignment changes without
depending on the login-time profile. Assignment changes clear old station rows
and reset pagination to page 1. The queue API independently resolves its station;
a transfer between profile and queue reads is also handled. Page changes and
logout/unmount abort requests and ignore late results even if cancellation is
ignored by the transport. A shrinking last page returns to an available page.

Initial loading, empty results, retry, and errors are distinct states. A network
or server refresh failure retains the last successful same-station result with
an explicit out-of-date warning and last-updated time. Assignment/access errors
(401/403/409) clear inaccessible rows. Attendance and weekly shifts keep their
own loading/error state and remain usable when the queue fails.

## Explicit disposable fixtures

The command never runs at startup and never falls back to the development
`DATABASE_URL`. It requires all of:

- `EMPLOYEE_ORDERS_TEST_DATABASE_URL`: an explicitly authorized local PostgreSQL
  database named `m7atati_employee_orders_verify_<suffix>`, with the existing
  application schema already deployed. Non-public schemas and remote hosts are
  rejected. The command does not create a database or run migrations.
- `ALLOW_EMPLOYEE_ORDER_FIXTURES=yes`: explicit authorization for fixture writes.
- `EMPLOYEE_ORDER_FIXTURE_PASSWORD`: a deliberately supplied password satisfying
  the existing registration password policy. The password/hash is never printed.

From the repository root, after configuring the URL/password through your normal
secret management:

```powershell
$env:ALLOW_EMPLOYEE_ORDER_FIXTURES = 'yes'
npm run fixture-employee-orders --workspace @smart-fuel-station/api
```

This creates marked fixture stations A/B and one PENDING FuelOrder plus its initial
SYSTEM OrderEvent per station. Pump ownership is verified. Required synthetic
price/amount fields exist only to satisfy the current order schema and are not
displayed as money or assigned a currency. All fixture writes share a transaction;
an advisory lock serializes concurrent runs.

The disposable fixture also supplies EMPLOYEE orders.read/orders.update links if needed
and creates `queue-a1@employee-fixture.invalid`, `queue-a2@employee-fixture.invalid`
at station A, and `queue-b1@employee-fixture.invalid` at B. Login uses the supplied
fixture password. Existing grants and accounts are preserved; a fixture employee
whose assignment/status changed causes an error instead of a silent reassignment.

Output lists station/order/employee IDs and emails, without credentials. Repeated
runs reuse marked records and the original event, never duplicate them, reset
terminal statuses, reactivate accounts, or reset passwords. For a clean rerun after
manually changing fixture state, use a fresh disposable database. No production
creation path or employee action endpoint is introduced.

## Verification

API tests use mocked Prisma to verify auth/permissions, fresh assignment checks,
station/status filtering, safe selection, ordering, empty results and totals.
Fixture tests verify guard rejection, one transaction, repeatability, matching
pumps/stations, and initial events. Web tests cover polling/visibility/focus,
non-overlap, cleanup, stale responses/data, assignment/page changes, disappearing
orders, and independent attendance/shift controls.

With the same authorized disposable URL/password and write flag, run:

```powershell
node --import tsx apps/api/scripts/verify-employee-orders-postgres.ts
```

The verifier reruns fixture creation, then starts a new listening API process for
each probe. It checks two station-A employees see the same order, station B is
isolated, and station-A data remains visible after stopping/restarting API
processes. It runs no migrations. Use initial PENDING fixture state for this check.
Stage 4 extends this verifier with a separate marked order and concurrent claim race.
Without an available authorized target, these real PostgreSQL and API restart
checks remain pending; mocked tests do not establish database persistence.

Routine checks: full API/web tests, both TypeScript checks with `--noEmit`, API/web
lint, and `git diff --check`. Stage 2's baseline is 699 API and 42 web tests.

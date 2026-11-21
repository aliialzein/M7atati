# Employee Stage 1: attendance and home-page controls

This stage adds self-service attendance only. Existing HR/Admin reads, employee
transfer restrictions, Manager lists/CSV/PDF reports, analytics, and demo orders
retain their contracts. Weekly shifts and persistent orders are later stages.

## API contracts

All routes require an active authenticated EMPLOYEE and use no-store caching,
including errors. Other roles are rejected even with the relevant grants. Existing
CSRF requirements apply to writes: an allowed browser Origin and
`X-CSRF-Protection: 1`. Invalid requests return 400 `{ message }`, authentication
401, role/permission/CSRF denial 403, ownership/not-found 404, state conflicts 409.

| Method/path                                         | Permission              | Request                          | Response                                                          |
| --------------------------------------------------- | ----------------------- | -------------------------------- | ----------------------------------------------------------------- |
| GET `/api/employee/attendance/current`              | `attendance.read`       | No parameters                    | `{ state, openRecord, assignedStation, canCheckIn, canCheckOut }` |
| POST `/api/employee/attendance/check-in`            | `attendance.self.write` | Only `{ "requestId": "<UUID>" }` | 200 `{ record }`, both for creation and replay                    |
| POST `/api/employee/attendance/:recordId/check-out` | `attendance.self.write` | Empty body or `{}`               | 200 `{ record }`, both for closure and replay                     |

`state` is `CHECKED_IN` or `CHECKED_OUT`. Station objects contain id, name, isActive;
an absent assignment is null. Record objects contain id, employeeId, stationId,
clockInAt, clockOutAt, and the recorded station object. Times are server-generated
UTC ISO timestamps. Legacy records with a null request UUID remain readable and
can be checked out by their owner. Request UUIDs are not exposed in reports.

The current endpoint finds the employee's open record across all stations. Its
capabilities account for the self-write grant; new check-in additionally needs an
active assigned station. Check-out does not require a current/active station.

Every write re-reads the active employee, role, and assignment inside a Serializable
transaction. A new check-in derives its station from that database assignment;
client employee/station/time fields and query overrides are rejected.

A request UUID identifies one employee's check-in attempt. UUIDs are normalized
to lowercase. The same employee/key returns the original record, even after it is
closed or the employee moves station. Different employees may use the same key.
A different key while attendance is open returns 409 and is **not recorded**.
It may be used for a later intentional check-in after closure.

Check-out uses the specified record ID and authenticated employee. An unknown ID
and another employee's record both return 404 `Attendance record not found`.
Inactive/historical stations and missing current assignments do not prevent
closure. A replay returns the original clock-out without closing any newer record.
A future clock-in returns a 409 requiring review rather than inventing timestamps.

Serializable failures and check-in uniqueness conflicts retry the complete
transaction, at most three attempts, re-reading assignment and request state.
Exhaustion returns 409 `Concurrent update; retry request`. Existing transfers are
also Serializable and check source-station open attendance: a race must either
check in under the committed new assignment or reject the conflicting transfer.
The real PostgreSQL verifier below tests both commit orders.

## Database preparation and review commands

The additive `20261121130000_employee_attendance` migration adds nullable UUID
`check_in_request_id`, a unique `(employee_id, check_in_request_id)` index, and a
partial unique index on `employee_id WHERE clock_out_at IS NULL`. PostgreSQL
allows multiple null request UUIDs for historical records. The partial index is
maintained in migration SQL and documented in the Prisma model.

The migration takes an attendance write lock, checks duplicates, and applies DDL
inside an explicit transaction. If duplicate open records exist it fails before
adding columns/indexes, preserving every record. It never closes, deletes, or
backfills historical attendance. A clean preflight is advisory; the locked check
inside the migration closes the race between preflight and deployment.

From the repository root in PowerShell, first set `DATABASE_URL` to the reviewed
target using your normal secret management. These are commands for explicit
review/deployment; they were **not run against the development database**:

```powershell
# Read-only preflight: any returned row requires review before deployment.
psql "$env:DATABASE_URL" -X -v ON_ERROR_STOP=1 -f apps/api/scripts/preflight-employee-attendance.sql

# Inspect pending migrations, then deploy only when the target/data are approved.
node node_modules/prisma/build/index.js migrate status --config apps/api/prisma.config.ts
node node_modules/prisma/build/index.js migrate deploy --config apps/api/prisma.config.ts

# Generate the tracked client without connecting to PostgreSQL.
node node_modules/prisma/build/index.js generate --config apps/api/prisma.config.ts

# Add only the new EMPLOYEE grant; no general seed or replacement of grants.
npm run provision-employee-attendance-permissions --workspace @smart-fuel-station/api
```

`migrate deploy` applies pending migrations; inspect status first. The targeted
provisioner requires an existing EMPLOYEE role and preserves all existing grants.
It does not grant HR's `attendance.manage` or employee shifts/order permissions.
The existing `attendance.read` employee grant is required for the home page.
Fresh-install seed definitions include self-write, but do not rerun the replacing
general seed on an established database. Deploy migration before the new API.

## Employee home page

The foundation/health entry remains available. A small account panel restores the
existing cookie session or offers login. Other roles keep the foundation entry
and account controls; only EMPLOYEE receives attendance controls. It uses the
existing configured API URL, credentialed fetch, and CSRF header. Tokens remain
HTTP-only and are never saved in JavaScript storage.

The client coordinates refreshes through a shared promise and generation counter;
each original request retries at most once after refresh. Login/refresh/logout
are never recursively refreshed. Network failures are not automatically replayed.

Attendance reloads on mount and after actions. While saving, buttons are disabled.
Before sending a write, the component stores a per-user pending attempt in
sessionStorage: either its check-in UUID or its exact check-out record ID. A lost
response retains that attempt and reconciles the current server state. The retry
button confirms the original action, even after a reload or a subsequent record;
it does not silently start a new check-in or close a newer record. A successful
acknowledgment or definitive 4xx clears the attempt; ambiguous network/5xx errors
retain it. Display timestamps use Asia/Beirut. No weekly schedule is added yet.

## Verification

Jest/Supertest tests exercise authentication, permission and CSRF enforcement,
validation, assignment policy, historical/inactive check-out, request-key replay,
uniqueness/serialization retry handling, and specified-record check-out. Web tests
cover session restoration/login, other roles, coordinated refresh, pending
controls, ambiguous failures, stable UUIDs and historical record IDs across reloads.
Mocks verify behavior but cannot prove PostgreSQL index or SSI concurrency.

The opt-in verifier requires an **existing, empty, explicitly authorized local
disposable database** named `m7atati_employee_verify_<suffix>`. It never falls back
to development DATABASE_URL or creates a database. It checks database identity and
empty public schema before executing migrations and creating its own test data.
It verifies duplicate-migration rollback, uniqueness, concurrent same/different
keys, historical retry, and both transfer/check-in commit orders. It leaves its
disposable fixtures for inspection; use a fresh empty database for another run.

After configuring the dedicated URL through your secret management:

```powershell
$env:ALLOW_EMPLOYEE_ATTENDANCE_TEST_WRITES = 'yes'
node --import tsx apps/api/scripts/verify-employee-attendance-postgres.ts
```

The URL must be in `EMPLOYEE_ATTENDANCE_TEST_DATABASE_URL`; setting the ordinary
development `DATABASE_URL` is insufficient. Without a supplied authorized target,
these real PostgreSQL checks remain **pending**. No claim of verified transaction
or migration behavior should be inferred from mocked tests.

Routine checks from the root:

```powershell
npm run test --workspace @smart-fuel-station/api -- --no-cache
npm run test --workspace @smart-fuel-station/web -- --no-cache
node node_modules/typescript/bin/tsc -p apps/api/tsconfig.json --noEmit --incremental false
node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit --incremental false
npm run lint --workspace @smart-fuel-station/api
npm run lint --workspace @smart-fuel-station/web -- --no-cache
git diff --check
```

# Station management

> Post-cleanup tooling status (2026-11-24): PostgreSQL acceptance runners have
> been intentionally removed. Their scenarios and results below are historical
> evidence, not currently executable tooling or fresh database acceptance. See
> [the current scripts inventory](api-scripts-audit.md). The developer reports
> that the five disposable acceptance databases were deleted; this review does
> not connect to PostgreSQL.

Current cross-module contracts and readiness are in the authoritative
[frontend API guide](frontend-api-guide.md). Task-specific acceptance notes below
retain their original scope. Task 08 subsequently resolved the Stage 9 HTTP 500
and passed full guarded local PostgreSQL order acceptance; earlier unresolved
failure statements are historical. Deployment remains READY WITH CONDITIONS.

Administrative routes require the existing access cookie, the explicit ADMIN role,
and the applicable permission. A non-admin is forbidden even if granted that
permission. ADMIN has no permission bypass. Unsafe requests also require an
allowed Origin and `X-CSRF-Protection: 1`, as described in `authentication.md`.
All station responses use `Cache-Control: no-store`.

| Method | Path                       | Permission        | Success                         |
| ------ | -------------------------- | ----------------- | ------------------------------- |
| POST   | `/api/stations`            | `stations.create` | 201, `{ station }`              |
| GET    | `/api/stations`            | `stations.read`   | 200, `{ stations, pagination }` |
| GET    | `/api/stations/:id`        | `stations.read`   | 200, `{ station }`              |
| PATCH  | `/api/stations/:id`        | `stations.update` | 200, `{ station }`              |
| PATCH  | `/api/stations/:id/status` | `stations.update` | 200, `{ station }`              |
| PATCH  | `/api/stations/:id/manager` | `stations.update` | 200, `{ station }`             |
| GET    | `/api/stations/picker`     | Public, no login  | 200, `{ stations }`             |
| GET    | `/api/stations/:id/pumps` | ADMIN `stations.read` or owning MANAGER `payments.manage` | 200, `{ pumps }` |

## Payloads and responses

### Station-scoped pump lookup (Task 05)

`GET /api/stations/:id/pumps` is authenticated and read-only. ADMIN requires
`stations.read`; MANAGER requires `payments.manage` and actual ownership of the
station. Other roles are forbidden, even if granted those permissions. Guests
create quotes/orders without selecting a pump; the manager selects the pump at
cash confirmation. This endpoint therefore exposes no public operational status
and grants no new permissions. GET requires no CSRF header. Responses retain
`Cache-Control: no-store`.

The path ID is a positive PostgreSQL integer up to 2147483647. There are no query
parameters or pagination; unsupported parameters return 400. Success is 200:

```json
{
  "pumps": [
    { "id": 7, "number": 1, "status": "IDLE", "available": true },
    { "id": 8, "number": 2, "status": "IDLE", "available": false },
    { "id": 9, "number": 3, "status": "OFFLINE", "available": false }
  ]
}
```

Pumps are related to this station through `Pump.stationId`, ordered by `number`
ascending then `id` ascending. An active station without pumps returns
`{ "pumps": [] }`. Only `id`, `number`, persisted `status` and computed `available`
are returned. Reservation counts, order IDs, customer, payment, employee and
station ownership fields are excluded. Pump status is an existing unrestricted
string, not an enum. Only exact `IDLE` is eligible; all other/unknown values fail
closed. There is no pump active flag, fuel mapping or reservation table.

`available` means the pump is IDLE and has **no** referencing order in PENDING or
IN_PROGRESS. Active orders themselves are reservations, enforced by
`orders_active_pump_key`; unpaid legacy PENDING orders also reserve pumps.
Payment or employee assignment does not change this predicate. Claiming moves
PENDING to IN_PROGRESS and retains the reservation; completion releases it.
AWAITING_PAYMENT, COMPLETED and CANCELLED do not reserve pumps. The supported
cancellation API accepts only unpaid, unassigned orders without pumps. Historical
terminal rows may retain pump IDs without reserving them.

Station, pump and reservation reads run in the existing Serializable transaction.
This is a snapshot: no row locks or reservations are acquired by the lookup.
Another request may reserve a pump immediately afterward. Cash confirmation
remains authoritative: user → station → order → pump locks, activity/ownership,
IDLE status and reservation checks, then payment/order/event writes protected by
the partial unique index. Employee claiming uses the already reserved pump and
does not select a new one. No frontend locking or availability guarantee is added.

Errors use the existing `{ "message": "..." }` shape: 400 for malformed input,
401 for missing/invalid/inactive authentication, 403 for role/permission failure,
404 `Station not found` for nonexistent or unmanaged stations, and 409
`Station is inactive` for an authorized inactive station. No selectable pumps are
returned for inactive stations. Unexpected failures are sanitized 500 responses;
exhausted serialization retries use the existing 409 response.

Jest covers scoping, authorization, ordering/select arguments, field exclusion,
status/reservation decisions, empty/inactive stations and read-only behavior.
The cash-confirmation suite follows availability through real application
cash/claim/complete handlers with mocked Prisma; it does not establish PostgreSQL
behavior.

Historical Task 05 scenario (runner removed):

*Historical runner commands removed: the referenced PostgreSQL tooling is no longer available.*

The removed scenario checked real station relations, ordering, lookup read preservation,
non-IDLE exclusion, cash/claim/completion, unpaid legacy reservations, terminal
history and inactive stations. It retained fixtures without creating, resetting,
dropping or migrating a database, and did not invoke Stage 9. Task 05 did not run this
scenario: no fresh target was approved, and retained Task 02/03 databases were
not repurposed. No primary database connection or migration was performed.
The pre-existing Task 02 order Stage 9 HTTP 500 remains unresolved and separate.

#### Task 05.5 observed PostgreSQL acceptance — 2026-11-23

Real acceptance passed on PostgreSQL 18.6, localhost:5432 (connected through ::1),
schema public, database `m7atati_employee_orders_verify_pumps_task05`.
Read-only maintenance-catalog inspection confirmed this exact target was absent
and template0 existed before execution of:

Historical creation used template0 for the exact disposable pump target.

No primary or retained Task 02/03 database was connected to or modified. The new
target was never reset or dropped. Connection credentials were loaded privately;
no environment file was edited. Child-process configuration supplied the exact
`ORDERS_VERIFY_CONFIRM_DATABASE`, its loopback `ORDERS_VERIFY_DATABASE_URL`, and
`ALLOW_ORDERS_VERIFY_MUTATIONS=yes` for fixtures. Migration deployment used only
the new database as its process-local DATABASE_URL.

From repository root the workflow executed:

*Historical runner commands removed: the referenced PostgreSQL tooling is no longer available.*

Before deployment: 0 applied/13 pending, no conflicts. After deployment and on
the final verifier run: all 13 applied with matching checksums, none pending,
no conflicts. Read-only final inspection confirmed zero failed migrations,
the unique `(station_id, number)` pump index, the partial active-order pump index,
zero duplicate reservations and zero active orders lacking pumps. The verifier
also checked required order constraints and validated pump foreign keys.

The initial script lacked concurrency and rollback checks. It was extended with
real API/Prisma scenarios; final observed results were:

- IDLE/unreserved available, IDLE/PENDING unavailable, IDLE/IN_PROGRESS unavailable,
  completion available again. The pump remained IDLE throughout reservation use.
- Non-IDLE excluded; response exactly matched the selected station's pumps in
  number/ID order. Unmanaged station returned 404; EMPLOYEE access returned 403;
  inactive owned station returned 409.
- Cash confirmation rejected OFFLINE and foreign-station pumps with 409 while
  preserving the waiting order and its payment/event records.
- Unpaid legacy PENDING rows reserved pumps despite lacking payment. A direct
  fixture transition to CANCELLED released the partial-index reservation. This
  demonstrates persisted terminal-state semantics, not a supported paid-order
  cancellation API.
- Actual unpaid cancellation API succeeded and left availability free. Paid
  cancellation returned 409, preserving the reservation and all checked records.
- Concurrent cash confirmations on different orders returned one 201 and one
  409; exactly one active reservation, payment and event remained. The losing
  order was unchanged. A direct duplicate assignment failed with P2002 and
  preserved that losing order. Claim/completion subsequently released the winner.
- A verifier-only hook injected PostgreSQL division by zero after order/payment
  writes but before the event. Expected P2010 / SQLSTATE 22012 produced HTTP 500;
  the transaction rolled back, the original order/payment/event snapshot matched,
  and the pump remained available. The hook was restored in finally.

No production defect was found or production code changed during Task 05.5.
One intervening run stopped during read-only preflight before fixture writes;
the old catch handler suppressed its underlying error, so its cause is unknown.
Sanitized error-type/code/SQLSTATE diagnostics were added. The subsequent complete
run exited 0 without weaker assertions, changed timeouts or data repair.
The non-fatal pg concurrent-query deprecation warning remains separate.

Safety regression tests reject earlier-task targets and missing mutation opt-in
before database imports. Reruns append uniquely named fixtures and retain earlier
rows; they do not maintain a fixed fixture count. A preflight conflict stops the
run for review and is never automatically repaired. Fixtures were retained at acceptance time; the developer later deleted the targets.
The pre-existing Task 02 Stage 9 verifier was not invoked; its HTTP 500 remains
unresolved. No schema, migration, dependency or permission-policy changes were made.
Regression passed: 4 targeted suites / 291 tests, all 35 backend suites / 1,191
tests, typecheck, ESLint, build and `git diff --check`.

### Manager ownership (Task 03)

`PATCH /api/stations/:id/manager` requires an active authenticated ADMIN and the
existing `stations.update` permission. The service rechecks the actor inside the
transaction. Existing cookie, allowed-Origin and CSRF requirements apply.

The strict body is `{ "managerId": 21 }` for assignment/reassignment or
`{ "managerId": null }` for unassignment. IDs are JSON integers from 1 through
2147483647, following the existing numeric user IDs; UUIDs, numeric strings,
missing fields, extra fields and malformed path IDs are rejected with 400.

Success is 200 `{ station }` using the existing station response below, including
the resulting nullable numeric managerId. No user credentials, role records or
permissions are exposed. Eligible users must be active MANAGERs. A station can
have zero or one owner, and a manager can own zero or one station.

Assigning the same eligible manager, or repeating an unassignment, returns the
current station without a write. Assignment to an inactive station is supported
and does not reactivate it. Neither assignment nor unassignment changes
`User.stationId`; affiliation and ownership are independent.

The endpoint replaces only this station's ownership. A manager owning another
station must first be explicitly unassigned there; no automatic transfer occurs.
Replacing a station's current owner with a different eligible, unassigned manager
revokes the former owner's access on subsequent requests. Existing in-flight
read transactions may finish using their earlier snapshot.

| Status | Error message / condition |
| --- | --- |
| 400 | `Invalid request` for malformed input |
| 401 | `Unauthenticated` |
| 403 | `Insufficient permissions`, or existing CSRF error |
| 404 | `Station not found` or `Manager not found` |
| 409 | `User must be an active MANAGER` |
| 409 | `Manager already owns another station` |
| 409 | Existing `Concurrent update; retry request` after exhausted retries |

All errors retain `{ "message": "..." }`. Rejections preserve ownership and other
relationships. Candidate-user `FOR UPDATE` precedes station `FOR UPDATE`, sharing
the user lock with role/status changes. Transactions remain Serializable with
bounded retries. A PostgreSQL unique manager index is the final duplicate-owner
boundary, and expected P2002 conflicts become HTTP 409.

#### Database deployment and acceptance

`20261123160000_unique_station_manager` adds `stations_manager_id_key` and replaces
the redundant plain manager index. It retains the nullable FK and SET NULL delete
behavior; PostgreSQL permits multiple NULL managers. A locked duplicate precheck
fails the migration transaction before any assignment changes. Nothing silently
deduplicates existing data. Primary-database compatibility remains unknown until
an explicitly approved read-only inspection is performed.
If deployment records a failed migration, review both assignments and Prisma's
migration ledger before approved recovery; no verifier automatically resolves a
failed migration, resets data or retries destructive preparation.

Before deployment, inspect duplicate non-null ownership and inactive/non-MANAGER
owners. Do not query or modify the primary database without approval. Review
conflicts explicitly; do not reset, delete or manufacture assignments to proceed.
Regenerate the client with the existing Prisma generate command; generated output
is not handwritten application source. Repository whitespace rules still apply.
The retired verifier allowlist checked the 13 migrations present at acceptance.

Historical standalone acceptance was separate from the pre-existing Stage 9
HTTP 500. It did not run Stage 9 or establish its eventual correction:

*Historical runner commands removed: the referenced PostgreSQL tooling is no longer available.*

The removed preflight reported duplicate/ineligible owners, migration history and
separate order-data conflicts using read-only queries. Historical verification
required all migrations already applied, checked unique-index/FK metadata and duplicate migration refusal
on a connection-local temporary table, and runs real assignment, lifecycle,
visibility and concurrency scenarios. It wrote marked fixtures/grants only to
the confirmed disposable database, retains them, and never creates/drops/reset
databases or changes the application database. A missing approved target means
BLOCKED PostgreSQL verification; mocked tests do not prove database integrity.

#### Task 03.5 observed PostgreSQL acceptance — 2026-11-23

Task 03 acceptance passed on PostgreSQL 18.6 at localhost:5432 (connection
reported ::1), schema public, database
`m7atati_employee_orders_verify_manager_task03`. A read-only maintenance-catalog
inspection established that this exact database did not exist. It was created
with `CREATE DATABASE "m7atati_employee_orders_verify_manager_task03" WITH TEMPLATE template0`.
No existing database was reused, reset or dropped. The primary `m7atati` database
and both retained Task 02 verification databases were not connected to or changed.

The documented `--preflight`, Prisma `migrate deploy`, then `--preflight`
sequence reported 0 applied/13 pending before deployment and 13 applied/0 pending
afterward, with matching repository checksums. `ORDERS_VERIFY_DATABASE_URL` was
derived privately from the local connection with only its database path replaced;
the exact confirmation name and `ALLOW_ORDERS_VERIFY_MUTATIONS=yes` were supplied
only to child processes. Migration deployment received the disposable URL as its
process-local `DATABASE_URL`. No environment file was edited.

The standalone `--verify` run passed these real database checks:

- Unique manager index; three simultaneous persistent NULL ownership values;
  validated manager FK retaining ON UPDATE CASCADE / ON DELETE SET NULL.
- Actual migration duplicate refusal on a connection-local shadow table, followed
  by rollback and unchanged duplicate/null fixture rows.
- Assignment, unchanged xmin on same-manager idempotency, replacement, explicit
  unassignment, duplicate/ineligible/unauthorized rejection and record/session
  preservation after rejected lifecycle writes.
- Old/new owner access across discovery, order list/detail, analytics, attendance,
  CSV/PDF exports and cash confirmation. Old owner received 404; new owner received
  200 for reads and 201 for cash confirmation.
- Inactive-station assignment without activation, independent affiliation,
  station deactivation preserving ownership, and deactivation after unassignment.
- Concurrent administrator assignments returned one 200 and one 409, leaving one
  owner. A direct duplicate Prisma update failed with P2002 and preserved the
  losing station's NULL ownership.
- Assignment versus deactivation and role exit in both controlled user-lock
  orders. Assignment-first retained an active MANAGER owner and rejected the
  lifecycle operation with 409. Lifecycle-first left no owner and rejected
  assignment with 409; the candidate was inactive or had role SECURITY respectively.

Two defects were exposed and fixed: the verifier needed `confdeltype::text`
because Prisma cannot deserialize PostgreSQL's internal char type; and the pg
adapter reports raw-lock serialization failures as P2010 with SQLSTATE 40001,
which station transactions now retry within the existing three-attempt bound.
Regression tests also ensure unrelated raw SQL errors are not retried.

After fixes, the complete verifier exited 0. Final read-only inspection reported
13 successful/0 failed migrations, 26 retained unassigned stations, zero duplicate
managers and zero ineligible owners. Failed-run fixtures were retained too.
All 33 Jest suites / 1,152 tests, typecheck, lint, build and whitespace checks
passed. A pg client concurrent-query deprecation warning remains non-fatal;
no dependency or unrelated query changes were made for it.

The existing Task 02 order Stage 9 HTTP 500 remains unresolved and was not invoked.
Task 03.5 acceptance does not establish primary-data compatibility or full Task 02
order acceptance. No commits or database cleanup were performed.

For an operator's separately approved primary compatibility inspection, the
following read-only query reports identifiers only, without names or credentials.
It was **not** run against `m7atati` during Task 03.5:

```sql
BEGIN READ ONLY;
SELECT manager_id,
       count(*) AS station_count,
       array_agg(id ORDER BY id) AS station_ids
FROM public.stations
WHERE manager_id IS NOT NULL
GROUP BY manager_id
HAVING count(*) > 1
ORDER BY manager_id;
COMMIT;
```

Zero rows establish only the absence of duplicate non-null ownership at that
snapshot. Review manager eligibility and the pending migration ledger separately
before any primary deployment; do not silently repair assignments.

### Station fields

Create requires trimmed, nonblank `name` (maximum 128 characters) and `address`
(maximum 512). These API limits bound otherwise unrestricted database text fields.
Names are not unique. Coordinates are optional, finite JSON numbers: latitude
in [-90, 90] and longitude in [-180, 180]. Supply both or omit both; both null
also means no coordinates. Numeric strings are rejected. Stored coordinates use
the existing Decimal(10,7) precision; HTTP responses expose numbers or null.

```json
{
  "name": "Central Station",
  "address": "Main Road",
  "latitude": 33.89,
  "longitude": 35.5
}
```

Example creation/detail/update/status response:

```json
{
  "station": {
    "id": 1,
    "name": "Central Station",
    "address": "Main Road",
    "latitude": 33.89,
    "longitude": 35.5,
    "isActive": true,
    "managerId": null,
    "createdAt": "2026-11-14T12:00:00.000Z"
  }
}
```

General PATCH accepts only a nonempty combination of `name`, `address`,
`latitude`, and `longitude`. It validates the resulting pair against stored
coordinates inside a retryable Serializable transaction. One coordinate may be
updated if the resulting pair remains valid. To remove coordinates, send both:

```json
{ "latitude": null, "longitude": null }
```

Existing null addresses remain null unless a valid address is supplied. Reads,
renames, coordinate updates, and status updates do not invent or require a legacy
address. Supplying a blank or null address on create/general PATCH is rejected.
Legacy invalid coordinate pairs must be repaired or cleared for general PATCH;
reads and status changes remain available.

Status PATCH accepts only `{ "isActive": false }` or `{ "isActive": true }`.
New and migrated existing stations start active. Repeating a permitted status
returns 200 with the station and performs no update. Deactivation preserves the
station ID, manager, employee accounts, and history. It does not disable users or
change existing manager authority/station scope. Reactivation is supported.
There is no DELETE route. Creation does not assign a manager. General PATCH
cannot assign/replace one. Unknown mutation fields, including `managerId`,
`deviceKeyHash`, and general-PATCH `isActive`, are rejected.

Task 02 deactivation policy: any IN_PROGRESS order, or a PENDING order with a
CONFIRMED payment whose capturedMinor is positive, blocks deactivation with 409:

```json
{ "message": "Station has active orders; complete them before deactivating the station" }
```

This uses the currently implemented payment convention; no new payment statuses,
refunds or cancellations are introduced. Unpaid AWAITING_PAYMENT and unpaid
PENDING orders, completed/cancelled history, and other stations' work do not block.
Rejected status changes preserve the station, order, payment and pump reservation.
Repeated deactivation without blocking work is a no-op. Existing inconsistent
inactive stations with blocking work still return 409 on deactivation; reactivation
remains available for recovery, preserving the previous legacy behavior.

Status changes retain their station `FOR UPDATE` lock and retryable Serializable
transaction. Order creation, cash confirmation and fulfillment take `FOR SHARE`
on that same station before validating activity and hold it through commit. The
incompatible locks and serialization retry coordinate the blocking-order predicate
with transitions; no order/pump lock is added to the status path. Cash retries that
only acknowledge an existing payment do not create new work.

`tests/integration/stations.test.ts` covers the predicate and preservation rules;
`cash-confirmation.test.ts` and `unit/order-station-concurrency.test.ts` cover the
mocked application protocol. The guarded `scripts/orders-postgres-scenarios.ts`
adds real creation/cash/paid-claim races against deactivation in both lock orders,
plus rejected-write preservation, completion and repeated-status checks. Those
scenarios require separately approved disposable PostgreSQL execution. Older
stage-only verification notes below are historical and do not establish Task 02
database acceptance.

IDs must be positive PostgreSQL integers (maximum 2147483647). Missing stations
return 404; invalid input returns 400; unauthenticated management returns 401;
role/permission/CSRF failures return 403. Exhausted serialization retries return 409. Errors retain `{ "message": "..." }` and unexpected failures are sanitized.

## Listing and public picker

```text
GET /api/stations?page=1&limit=20&search=central&isActive=false
```

Search matches name/address case-insensitively (trimmed, 1–128 characters).
`isActive` accepts exactly the strings `true` or `false`; omission includes both.
Page defaults to 1 (maximum 1,000,000), limit to 20 (maximum 100). Unknown or
repeated query parameters are rejected. List order is name ascending, then ID
ascending; collation follows PostgreSQL. List/count use the same filters and
transaction. Pagination is `{ page, limit, total, totalPages }` (zero pages for
zero results). Admin list/detail include inactive stations.

The public picker is registered before `/:id`, requires no cookie, returns only
active stations in the same deterministic order, and has no pagination/filter
contract. Its exact item fields are `id`, `name`, `address`, `latitude`, `longitude`:

```json
{
  "stations": [
    {
      "id": 1,
      "name": "Central Station",
      "address": "Main Road",
      "latitude": 33.89,
      "longitude": 35.5
    }
  ]
}
```

Legacy addresses can be null. The picker excludes status, manager, timestamps,
employee details and device keys. All station queries use explicit safe selects
and response mapping; device-key hashes are never returned by administrative APIs
either.

## Database rollout and permissions

The additive `20261114150000_add_station_status` migration adds only
`stations.is_active BOOLEAN NOT NULL DEFAULT true`; no address backfill or
historical migration changes are needed. Do not run against an unidentified or
shared database. An operator must first identify/approve the target and inspect
pending migrations: `migrate deploy` applies **all** pending migrations.

From repository root, with the intended target configuration supplied securely:

```powershell
.\node_modules\.bin\prisma.cmd migrate status --config apps/api/prisma.config.ts
.\node_modules\.bin\prisma.cmd migrate deploy --config apps/api/prisma.config.ts
.\node_modules\.bin\prisma.cmd migrate status --config apps/api/prisma.config.ts
.\node_modules\.bin\prisma.cmd generate --config apps/api/prisma.config.ts
npm.cmd run provision-station-permissions --workspace @smart-fuel-station/api
```

The provisioning CLI is explicit, transactional and idempotent. It requires an
existing ADMIN role; upserts only `stations.read`, `stations.create`, and
`stations.update`, and adds their ADMIN links. It does not create users, change
passwords, remove grants, overwrite existing permission descriptions, or grant to
other roles. Future environment seed definitions grant these only to ADMIN.
**Do not use the full seed for this rollout:** the existing seed replaces every
role-permission link. No provisioning runs at startup or merely on helper import.
The database-only CLI requires database configuration, not JWT signing keys.

### Verified local rollout — 2026-11-14

The development target was identified as `m7atati` on the existing local
PostgreSQL 18 service at localhost:5432 (the connection reported loopback).
Historical migration checksums matched repository content after CRLF/LF
normalization; historical migrations were not edited. Only the expected station
status migration was pending. It was applied with `migrate deploy`, followed by
successful `migrate status` and the targeted permission CLI. PostgreSQL confirmed
all three migrations applied, the NOT NULL/true column default, and exactly the
three station grants linked only to ADMIN. Unrelated grants, users and station
relationships were unchanged. There were zero existing development stations, so
the existing-row backfill was demonstrated in the isolated database instead.

No pre-existing isolated database was configured. Real verification used a
uniquely named disposable `m7atati_stage1_verify_*` database on the same local
cluster. The opt-in harness applied copies of the first two repository migrations
with `migrate deploy`, inserted a legacy station, then deployed the third
migration. It verified the legacy row became active, real HTTP login and station
creation/update/coordinate clearing/status/filter/picker/reactivation behavior,
and unchanged manager/employee FK relationships after deactivation. The actual
permission CLI ran twice; exactly three ADMIN-only grants resulted and unrelated
grants remained unchanged. The isolated database and temporary migration files
were removed afterward. No normal development data was reset, truncated or used
for these write tests; the full seed was not run.

To repeat this isolated verification from repository root using the existing local
development connection (requires local database-creation privileges):

*Historical runner commands removed: the referenced PostgreSQL tooling is no longer available.*

The harness refuses nonlocal targets, a source database other than `m7atati`,
non-development configuration and an unexpected repository migration set. It
creates a fresh randomly named test database, never reuses/resets the source, and
drops only that generated database. Test accounts and random signing keys exist
only in the disposable environment/process. The normal Jest command does not run
this harness.

Development HTTP smoke used the real Express app through Supertest and the real
development PostgreSQL database, with temporary signing keys confined to the
smoke process: liveness/readiness/picker returned 200, unauthenticated management
returned 401, and a mutation without CSRF proof returned 403. Picker results
matched the zero active stations; station/user/session counts did not change.
No API was listening on localhost:4000. **Normal application startup and an
authenticated development-admin smoke remain blocked:** JWT signing keys are
not configured and no active ADMIN account exists. No signing keys or users were
persisted to work around this. Database rollout is complete; normal application
runtime setup remains outstanding.

## Verification scope

Jest/Supertest station tests mock Prisma and exercise actual routing, middleware,
validation, services, repository arguments and safe response mapping. They do not
establish real PostgreSQL migration, FK, isolation, collation or rollback behavior.
The separate opt-in harness above provides the stated real PostgreSQL migration,
HTTP and FK evidence. It does not test order/deactivation concurrency.

No order behavior is implemented or verified in this stage. Inactive-station
order admission and coordination with concurrent deactivation remain work for the
future order implementation. No frontend, employee-management policy, pricing,
or analytics changes are included.

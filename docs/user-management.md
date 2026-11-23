# User and access management

Operational staff means MANAGER, EMPLOYEE, HR and SECURITY. ADMIN account
administration is conceptually separate; the existing ADMIN provisioning and
user endpoints retain their capabilities. This terminology adds no role group or
authorization grant. General PATCH supports only name, role and stationId;
email/password changes remain outside this API.

New station assignments (creation or a changed stationId) must target an active
station within the actor's existing scope. Station deactivation preserves existing
assignments. An unchanged stationId, including an explicitly repeated value, is
not a transfer; unrelated profile changes remain allowed at inactive stations.
Assigned managers cannot be deactivated or changed away from MANAGER until their
ownership is explicitly released or reassigned. These rejected operations leave
accounts, sessions and employee relationships unchanged.

Account deactivation atomically increments the private token version and revokes
refresh sessions with the status update. Reactivation leaves that version intact:
earlier access and refresh tokens remain rejected; fresh login is required.

All `/api/users` endpoints use the existing cookie authentication and permission
middleware. Mutations also require the existing allowed Origin and
`X-CSRF-Protection: 1` header. Responses use `Cache-Control: no-store`.

| Method and path               | Permission     | Success                      |
| ----------------------------- | -------------- | ---------------------------- |
| `GET /api/users`              | `users.read`   | 200, `{ users, pagination }` |
| `GET /api/users/:id`          | `users.read`   | 200, `{ user }`              |
| `POST /api/users`             | `users.create` | 201, `{ user }`              |
| `PATCH /api/users/:id`        | `users.update` | 200, `{ user }`              |
| `PATCH /api/users/:id/status` | `users.update` | 200, `{ user }`              |

Profiles contain id, name, email, role name, stationId, isActive, createdAt, and
updatedAt. Dates are ISO strings over HTTP. Passwords, password hashes, role IDs,
and session data are excluded by database selection and explicit response mapping.
Errors retain the existing `{ message }` format. Validation errors are 400,
authentication errors 401, permission/scope errors 403, hidden/missing users 404,
and duplicate email or integrity/concurrency conflicts 409. Unexpected errors
remain sanitized 500 responses.

## Employee role exits and open attendance (Task 02)

`PATCH /api/users/:id` rejects a change from EMPLOYEE to another role when any
attendance record for that employee has a null clock-out, including a historical
record at a different station. It returns 409:

```json
{ "message": "Employee has open attendance; check out before changing role" }
```

The rejection does not update the user, attendance timestamps or refresh sessions.
Name edits, an unchanged EMPLOYEE role and entering EMPLOYEE from another role do
not trigger this guard. Existing authorization, station-transfer, claimed-order
and role-assignment validation still apply first, so those conflicts can retain
their existing messages.

The predicate read and role update share the existing retryable Serializable user
transaction and target-user `FOR UPDATE` lock. Attendance check-in/out already use
retryable Serializable transactions. If overlapping check-in reads EMPLOYEE and
creates an open record while role exit reads no open record and updates the user,
the conflicting read/write dependencies cannot both commit at Serializable
isolation; the existing P2034 retry reloads the role/attendance. Checkout may cause
a conservative 409 from an older snapshot; retry after checkout is safe. Competing
role updates lock the same user row. No global lock or automatic checkout exists.

HTTP cases extend `tests/integration/users.test.ts`. Real PostgreSQL scenarios in
`scripts/verify-employee-attendance-postgres.ts` cover check-in versus MANAGER or
SECURITY role exit in both commit orders, checkout overlap with later role retry,
and competing role exits. They require an explicitly authorized, initially empty
disposable target as documented in `api-scripts-audit.md`; mocked tests do not
establish real PostgreSQL concurrency acceptance.

## Scope policy

User-management scope is specific to the requested operation:

| Actor                        | User-management scope                                                   |
| ---------------------------- | ----------------------------------------------------------------------- |
| ADMIN                        | All users and stations, subject to integrity rules                      |
| MANAGER                      | EMPLOYEE users assigned to stations managed through `Station.managerId` |
| HR                           | Create/read EMPLOYEE accounts globally; dedicated transfers only        |
| EMPLOYEE, SECURITY, CUSTOMER | No user-management scope                                                |

HR Stage 1 reuses the seeded `users.read` and `users.create` grants for GET list,
GET detail, and POST only. HR can create only EMPLOYEE accounts, with a required
active station, and reads only EMPLOYEE accounts across stations. Every list
filter is intersected with that employee-only scope for both rows and totals;
requesting another role returns an empty list. Nonemployee detail targets return 404. Both generic PATCH and status PATCH remain denied even if HR has the seeded
`users.update` permission. An HR user's own station assignment does not determine
this scope, and the shared station-scope helper is unchanged.

Existing databases with the seeded HR `users.read`/`users.create` links need no
permission changes or migration. If those links are missing, provision only the
two links using transactional permission/role-permission upserts following
`scripts/station-permissions.ts`; preserve all other grants. Do not rerun the seed
to repair grants: it replaces all role-permission assignments. No provisioning is
performed at application startup or as part of Stage 1 implementation.

Managers can create, read, rename, reassign, activate, and deactivate EMPLOYEE
accounts only inside their managed stations. Manager reads are intentionally
limited to EMPLOYEE accounts rather than exposing peers, elevated staff, or
customer records. Out-of-scope detail reads/updates return 404. Listing intersects
scope with every requested filter and returns an empty result for inaccessible
stations. Assignment to a missing or unauthorized station gives the same 400
error, avoiding a station-existence oracle.

`src/utils/accessScope.ts` centralizes reusable station predicates: ADMIN is
global, MANAGER uses `managerId`, and EMPLOYEE has only their assigned station
(or an empty scope if unassigned). Other roles have no inferred station scope.
Future resource services must combine these predicates with capability,
ownership, and role rules; the helper itself does not grant a permission.

Scope is enforced by the service and incorporated into database predicates,
including mutation target reads. Listing uses count and paginated queries with
the same combined filters, deterministic ID ordering, and no per-user queries.
The acting user is re-read inside each transaction, so concurrent account/role
changes are observed when serialization conflicts are retried.

## Listing and validation

Example:

```text
GET /api/users?page=1&limit=20&search=alice&role=EMPLOYEE&stationId=10&isActive=true
```

`page` defaults to 1 (maximum 1,000,000); `limit` defaults to 20 (maximum 100).
Search performs case-insensitive name/email matching. Role uses the six seeded
role names, stationId is a positive integer, and isActive accepts only `true`
or `false`. Unknown/repeated parameters and malformed IDs are rejected.
Pagination contains `page`, `limit`, `total`, and `totalPages`; zero results have
zero totalPages. Pagination occurs in PostgreSQL.

## Staff creation and updates

Create accepts only `name`, `email`, `password`, `role`, and optional `stationId`.
It reuses public registration's normalization and password requirements, plus
the shared bcrypt hashing service. CUSTOMER creation is rejected here; public
registration remains exclusively `/api/auth/register`. Only ADMIN can create
ADMIN, MANAGER, HR, and SECURITY accounts. Managers and HR can create only EMPLOYEE;
managers remain limited to their managed stations, while HR can select any active
station. The existing active-station picker contract is unchanged.

Station assignment policy:

| Role               | User.stationId                              |
| ------------------ | ------------------------------------------- |
| EMPLOYEE, SECURITY | Required, existing station                  |
| MANAGER            | Optional existing station, affiliation only |
| ADMIN, HR          | Must be null                                |
| CUSTOMER           | Not assignable through this module          |

A MANAGER's station affiliation never proves management. Ownership is represented
by nullable unique `Station.managerId` and the generated optional
`User.managedStation` inverse. Creating a manager does not assign ownership.
ADMIN uses `PATCH /api/stations/:id/manager` and `stations.update` to assign,
reassign or explicitly unassign it; see `station-management.md` for the contract.

An assigned manager cannot be demoted (existing 409
`Reassign managed stations before changing this role`) or deactivated (409
`Unassign managed station before deactivating this manager`). Unassignment must
be explicit; neither lifecycle operation clears ownership automatically. Manager
affiliation changes remain independent and do not move ownership. Station
deactivation preserves the owner. Manager reads and cash confirmation use current
Station.managerId rather than affiliation, so subsequent requests reflect a
committed reassignment immediately. Existing permissions are still required.

General PATCH accepts only a nonempty combination of name, role, and stationId.
Email, password, isActive, roleId, and other Prisma fields are rejected. Changes
between CUSTOMER and staff roles are unsupported. ADMIN can update a customer's
name or account status. Role transitions must supply any necessary station
assignment/null explicitly. Missing seeded roles produce 409 rather than being
created implicitly. Database uniqueness handles duplicate emails, including
concurrent creates.

## HR Stage 3: immediate employee transfers

`POST /api/users/:id/transfer` requires an ADMIN or HR actor and
`employees.transfer`. Its body is strictly `{ "stationId": 20 }`, with a required
positive integer destination; role, name, status, and other fields are rejected.
Success returns 200 `{ user }` using the existing safe profile. Missing or
non-EMPLOYEE targets return 404. Other roles are denied even if assigned the
permission. HR still cannot use generic PATCH or status PATCH.

The actor and target are re-read inside the existing Serializable transaction.
An unchanged station is an immediate no-op: no writes, session revocation,
destination validation, or operational conflict checks. This also succeeds at
an inactive station. A changed destination must exist and be active; invalid
destinations retain the existing 400 assignment error. An inactive source does
not prevent transfer out.

Before a changed assignment, source-station records for this employee are checked
in the same transaction. Null clock-out attendance or any shift with `endsAt`
strictly greater than the server's transfer-check time causes 409. A shift ending
exactly at that time does not block. No attendance or shift is closed, moved,
cancelled, or otherwise changed.

Existing ADMIN/MANAGER generic station updates use these same conflict checks
when either the original or resulting role is EMPLOYEE. This includes combined
role/station changes and demotion with station clearing, checked against the
original source. Manager target/destination boundaries remain relationship-based;
unrelated edits and unchanged affiliations retain their existing behavior.

The dedicated endpoint writes only `User.stationId` (plus Prisma's automatic
updatedAt) and revokes refresh sessions atomically. Identity, role, status,
credentials, and token version are preserved. Existing access JWTs remain valid
for active users and resolve the new station because authentication reloads the
current user on each request; previously authenticated in-flight requests are not
cancelled. Refresh sessions are not restored. Historical reads use each record's
stored station, so A's past work remains at A after transfer to B.

Serialization failures retry the whole operation, including actor, target,
destination and source-record checks, up to the existing three attempts. Failed
session revocation rolls back assignment changes. No transfer auditing or new
schema is introduced.

For an established database with ADMIN and HR roles, provision only the new grant:

```sh
npm run provision-transfer-permissions --workspace @smart-fuel-station/api
```

The command idempotently upserts only `employees.transfer` and its ADMIN/HR links,
preserving unrelated grants. It requires database configuration but no JWT keys,
does not seed data, and never runs at startup. Fresh-install seed definitions
include this permission; do not rerun the replacing seed on an existing database.
Stage 3 needs no migration. Deploy Stage 2's shift/attendance migration first if
it is still pending, and use its generated client.

The disposable PostgreSQL verifier includes rollback and controlled concurrency
checks, without changing application data in the development database:

```sh
node --import tsx apps/api/scripts/verify-stations-postgres.ts --transfers
```

## Status, sessions, and concurrency

The dedicated status endpoint accepts only `{ "isActive": false }` or true.
Deactivation preserves the user and historical relationships and revokes all
unrevoked refresh sessions in the same transaction. Role or station changes also
revoke refresh sessions. Activation never restores revoked sessions.

Previously issued access JWTs are rejected for disabled users because the
existing authentication middleware loads current account status on each
request. The existing login and refresh checks also reject disabled users.
This does not cancel requests already authenticated/in flight before the
deactivation. Current roles/permissions are loaded on every protected request.

The final active ADMIN cannot be disabled or demoted. Other inactive ADMINs do
not satisfy this guard. User-management operations and initial ADMIN bootstrap
run at Serializable isolation. Transactions retry Prisma P2034 conflicts up to
three total attempts and return a sanitized 409 if contention persists. Counts
and writes share the same transaction, protecting against concurrent attempts
to remove separate final administrators. Failed session revocation rolls back
the associated status/assignment update. Password hashing stays outside retries.

## First administrator CLI

This command is never invoked at application startup and has no public HTTP
equivalent. Set the normal API environment (DATABASE_URL, JWT secrets, etc.) and
provide these process environment variables through a protected terminal or
secret manager:

- `ADMIN_NAME`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`

Then explicitly run from the monorepo root:

```sh
npm run create-admin --workspace @smart-fuel-station/api
```

Avoid placing the password in command-line arguments, shell history, committed
files, or shared terminal output. The command loads the existing API `.env`
configuration, validates credentials with the shared schema, hashes the password,
looks up the seeded ADMIN role, and creates an active administrator with no
station assignment. It prints only success or sanitized failures, disconnects
Prisma, and exits nonzero on failure. No passwords, hashes, or tokens are printed.

Bootstrap is refused if **any** ADMIN account already exists, including inactive
ones. It also rejects email duplicates with any role. It is not an account
recovery command. Provisioning was not executed as part of implementation.

## Verification limits and future work

Jest/Supertest uses mocked Prisma and explicit test credentials, preserving
database-free CI. Tests verify the emitted filters/transaction options and model
rollback/conflict retries; they do not simulate PostgreSQL's full Serializable
implementation. The token-version policy requires the additive
`20261117090000_add_user_token_version` migration; the disposable PostgreSQL
`verify-stations-postgres.ts --users` run verifies real authentication and storage
independently of those mocks. The token-version migration was explicitly applied
to local development `m7atati` on 2026-11-17. Users/station acceptance suites were
not repeated for the subsequent pricing-only conversion change, at the user's request.

HR Stage 1 adds only employee registration and lookup. Shifts, attendance,
transfers, Security workflows, hardware integration, and frontend work remain
outside this stage. Its Jest/Supertest checks use mocked Prisma; the updated
disposable PostgreSQL acceptance helper must be run separately to verify real
storage behavior.
Future credential changes, email verification, invitations, audit trails, and
shared multi-instance rate limiting remain separate work. Preserve the existing
CSRF and authentication protections when adding those features.

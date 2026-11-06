# User and access management

All `/api/users` endpoints use the existing cookie authentication and permission
middleware. Mutations also require the existing allowed Origin and
`X-CSRF-Protection: 1` header. Responses use `Cache-Control: no-store`.

| Method and path | Permission | Success |
| --- | --- | --- |
| `GET /api/users` | `users.read` | 200, `{ users, pagination }` |
| `GET /api/users/:id` | `users.read` | 200, `{ user }` |
| `POST /api/users` | `users.create` | 201, `{ user }` |
| `PATCH /api/users/:id` | `users.update` | 200, `{ user }` |
| `PATCH /api/users/:id/status` | `users.update` | 200, `{ user }` |

Profiles contain id, name, email, role name, stationId, isActive, createdAt, and
updatedAt. Dates are ISO strings over HTTP. Passwords, password hashes, role IDs,
and session data are excluded by database selection and explicit response mapping.
Errors retain the existing `{ message }` format. Validation errors are 400,
authentication errors 401, permission/scope errors 403, hidden/missing users 404,
and duplicate email or integrity/concurrency conflicts 409. Unexpected errors
remain sanitized 500 responses.

## Scope policy

The only architecture documentation available when this phase was implemented
was `authentication.md`. It does not define HR station grants. The schema has
no HR-to-station authorization relationship. Accordingly:

| Actor | User-management scope |
| --- | --- |
| ADMIN | All users and stations, subject to integrity rules |
| MANAGER | EMPLOYEE users assigned to stations managed through `Station.managerId` |
| HR | Denied until an explicit authorized scope is modeled and approved |
| EMPLOYEE, SECURITY, CUSTOMER | No user-management scope |

HR's seeded user permissions do not override the missing resource scope. Even
an HR user's `stationId` is not interpreted as an authorization grant. Adding
HR scope later requires an explicit grant model (for example, a reviewed
HR/station assignment relation) and policies for target roles. No such relation
or workaround was introduced in this phase.

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
ADMIN, MANAGER, HR, and SECURITY accounts. Managers can create only EMPLOYEE.

Station assignment policy:

| Role | User.stationId |
| --- | --- |
| EMPLOYEE, SECURITY | Required, existing station |
| MANAGER | Optional existing station, affiliation only |
| ADMIN, HR | Must be null |
| CUSTOMER | Not assignable through this module |

A MANAGER's station affiliation never proves management; actual managed stations
are represented by `Station.managerId`/`User.managedStations`. Creating a manager
does not assign stations to that manager. A later station-management workflow
must maintain those relationships. A manager with managed stations cannot be
demoted until those relationships are reassigned; this phase does not provide
a station reassignment endpoint.

General PATCH accepts only a nonempty combination of name, role, and stationId.
Email, password, isActive, roleId, and other Prisma fields are rejected. Changes
between CUSTOMER and staff roles are unsupported. ADMIN can update a customer's
name or account status. Role transitions must supply any necessary station
assignment/null explicitly. Missing seeded roles produce 409 rather than being
created implicitly. Database uniqueness handles duplicate emails, including
concurrent creates.

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
implementation. No schema or migration changes are needed for these policies.

Before expanding access, agree on HR grants and station-management workflows.
Future credential changes, email verification, invitations, audit trails, and
shared multi-instance rate limiting remain separate work. Preserve the existing
CSRF and authentication protections when adding those features.

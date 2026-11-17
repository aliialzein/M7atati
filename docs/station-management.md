# Station management

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
| GET    | `/api/stations/picker`     | Public, no login  | 200, `{ stations }`             |

## Payloads and responses

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
New and migrated existing stations start active. Repeating the current status
returns 200 with the station and performs no update. Deactivation preserves the
station ID, manager, employee accounts, and history. It does not disable users or
change existing manager authority/station scope. Reactivation is supported.
There is no DELETE route. Creation does not assign a manager. General PATCH
cannot assign/replace one. Unknown mutation fields, including `managerId`,
`deviceKeyHash`, and general-PATCH `isActive`, are rejected.

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

```powershell
.\node_modules\.bin\tsx.cmd apps/api/scripts/verify-stations-postgres.ts
```

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

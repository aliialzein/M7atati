# Manager Stage 1: station discovery and attendance reports

> Post-cleanup tooling status (2026-11-24): PostgreSQL acceptance runners have
> been intentionally removed. Their scenarios and results below are historical
> evidence, not currently executable tooling or fresh database acceptance. See
> [the current scripts inventory](api-scripts-audit.md). The developer reports
> that the five disposable acceptance databases were deleted; this review does
> not connect to PostgreSQL.

Current cross-module contracts: [frontend API guide](frontend-api-guide.md).
Stage exclusions below describe historical scope; Manager orders and analytics
now exist with their own permissions and persisted data.

Backend only; uses the existing schema. HR/Admin `/api/attendance` and
`/api/shifts` contracts are unchanged. Managers still cannot use those global
views or read shifts. No orders, analytics, or frontend work is included.

## Authentication and station ownership

All endpoints require the existing access cookie. Unauthenticated callers get
401; other roles get 403, even with the relevant permission. Responses, including
errors, use `Cache-Control: no-store`.

`GET /api/stations/managed` requires MANAGER, with no additional permission. It
returns `{ stations: [{ id, name, isActive }] }`, sorted by name then ID, including
inactive stations. A manager with no stations gets an empty list. The public
picker and ADMIN station routes retain their previous behavior.

All attendance endpoints require MANAGER **and** `attendance.read`:

| Method | Path                                                            | Response                     |
| ------ | --------------------------------------------------------------- | ---------------------------- |
| GET    | `/api/manager/stations/:stationId/attendance`                   | `{ attendance, pagination }` |
| GET    | `/api/manager/stations/:stationId/attendance/export?format=csv` | CSV attachment               |
| GET    | `/api/manager/stations/:stationId/attendance/export?format=pdf` | PDF attachment               |

Ownership is checked using `Station.managerId = authenticated user ID`, inside
the same Repeatable Read snapshot as the attendance query. `User.stationId` is
affiliation and never establishes ownership. Unknown and unmanaged stations both
return 404 `{ "message": "Station not found" }`. Inactive owned stations remain
readable. Invalid path IDs return 400.

Attendance predicates always constrain the record's stored `stationId` before
pagination, count, or export. Employee transfers, role changes, and deactivation
do not move or hide history. No current employee assignment predicate is used.

## Filters and pagination

All three attendance endpoints accept optional `employeeId`, `from`, and `to`.
They reuse the HR attendance validators: positive 32-bit IDs, explicit-offset ISO
timestamps with seconds and at most three fractional digits, and `from < to`.
Encode `+` as `%2B` for positive offsets. Unknown/repeated parameters return 400.
`stationId` is a path parameter and cannot be overridden through the query.

The interval is half-open `[from, to)`: `clockInAt < to` and
`clockOutAt > from OR clockOutAt IS NULL`, omitting absent bounds. Overnight work
and open records are included by overlap. An open record has no inferred end.
Rows are ordered by `clockInAt ASC, id ASC`; rows and totals share predicates and
a snapshot. Dates serialize as UTC ISO strings.

The JSON list accepts `page` (default 1, maximum 1,000,000) and `limit` (default
20, maximum 100). Pagination includes page, limit, total, and totalPages. Empty
selections return no rows and zero total/totalPages. Row fields and minimal
employee/station objects match the existing HR attendance response.

## Exports

`format` is required and accepts only lowercase `csv` or `pdf`. Export rejects
`page` and `limit`, including their defaults supplied explicitly. Both formats
select all matching rows across JSON pages using the same filters and ordering.
They never export just the current page.

The limit is **5,000 attendance rows per export**, inclusive. The database fetches
at most 5,001 rows to detect overflow. More returns 422 JSON:

```json
{
  "message": "Attendance export exceeds 5000 rows; narrow the date range or employee filter"
}
```

No partial attachment is sent and nothing is silently truncated. Narrow the date
range or employee filter before retrying.

Downloads are named `station-<id>-attendance.csv` or `.pdf`. CSV uses
`text/csv; charset=utf-8`, PDF uses `application/pdf`; both have attachment
Content-Disposition and no-store caching.

CSV columns are Station, Employee, Clock-in (UTC), Clock-out (UTC). Open clock-out
cells are blank. Fields are quoted; quotes are doubled; commas/newlines survive.
Formula-like user text beginning with `=`, `+`, `-`, or `@` (including preceding
whitespace/control characters), and leading tab/CR/LF, receives an apostrophe
prefix for spreadsheet safety. Empty selections produce a header-only CSV.

PDF contains the station name, normalized date bounds, explicit UTC timezone,
employee filter, total row count, and attendance table. Table headers and report
context repeat on every page. Null clock-out is labeled `Open`. Empty selections
produce a one-page report with headers and a no-records message.

The focused server dependency is jsPDF: it generates PDFs without a browser and
includes Arabic shaping and bidirectional text support. The bundled, licensed
DejaVu Sans font provides portable embedded text; deployment must retain
`apps/api/assets/fonts` alongside the API package, including for compiled builds.
Latin accents, Greek, Cyrillic, and mixed Arabic/Latin names are verified. PDF
normalizes text to NFC and replaces control/format characters with spaces.
Characters outside this font's BMP coverage return 422 with a CSV alternative,
rather than missing glyphs. Extremely long legacy text that cannot fit on a page
also returns 422; CSV preserves the original text.

## Permission deployment (explicit, later)

From the repository root:

```sh
npm run provision-attendance-permissions --workspace @smart-fuel-station/api
```

The targeted command requires existing ADMIN, HR, and MANAGER roles. It preserves
all existing grants, idempotently retains the ADMIN/HR attendance and shift read
grants, and adds only `attendance.read` for MANAGER. It does not grant manager
shifts, create users/data, run at startup, or invoke the general seed. Fresh-install
seed definitions likewise include only the new manager attendance grant. Never
rerun the replacing general seed to deploy this stage. No schema migration is
needed for this change; existing attendance tables must already be deployed.

## Example requests

Use an authenticated manager access cookie with these requests:

```text
GET /api/stations/managed
GET /api/manager/stations/10/attendance?employeeId=3&from=2026-11-18T22:00:00Z&to=2026-11-19T22:00:00Z&page=1&limit=20
GET /api/manager/stations/10/attendance/export?format=csv&employeeId=3&from=2026-11-18T22:00:00Z&to=2026-11-19T22:00:00Z
GET /api/manager/stations/10/attendance/export?format=pdf&employeeId=3&from=2026-11-18T22:00:00Z&to=2026-11-19T22:00:00Z
```

## Verification

From the root:

```sh
npm run test --workspace @smart-fuel-station/api -- --no-cache
node node_modules/typescript/bin/tsc -p apps/api/tsconfig.json --noEmit --incremental false
npm run lint --workspace @smart-fuel-station/api
git diff --check
```

Jest/Supertest tests use mocked Prisma. Test-only PDF.js independently opens the
generated PDFs and checks selected rows, Unicode text, empty reports, and headers
on every page. PDF rendering was also visually checked with a separate renderer.

The removed disposable runner historically checked manager discovery, scoped
attendance lists and CSV/PDF ownership against a real isolated database. This
acceptance tooling is no longer available; the mocked regression tests remain.

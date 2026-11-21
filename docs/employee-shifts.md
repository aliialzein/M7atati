# Employee Stage 2: weekly shifts

`GET /api/employee/shifts?weekStart=2026-11-16&page=1&limit=20` requires the existing
access cookie, an active EMPLOYEE, and `shifts.read`. Responses/errors use
`Cache-Control: no-store`. Authentication failure is 401; other roles and missing
permissions return 403. The existing HR/Admin `/api/shifts` contract is unchanged;
giving EMPLOYEE the permission does not permit the global route.

## Request and response

`weekStart` is required: a real Gregorian calendar date in strict `YYYY-MM-DD`
format, years 0001-9999, falling on a Monday. It is interpreted in Asia/Beirut.
The backend converts that Monday's local midnight and the following Monday's
local midnight to UTC independently using `@js-temporal/polyfill` and the
runtime's IANA timezone rules. It never adds a fixed 168 hours to the first instant.
The March 23, 2026 week is 167 hours; the October 19 week is 169 hours.

`page` defaults to 1 (maximum 1,000,000); `limit` defaults to 20 (maximum 100).
These use the existing positive-integer validation. Unknown/repeated parameters,
missing/invalid dates, non-Mondays, and invalid pagination return 400
`{ "message": "Invalid request" }`. Identity/station, timezone and from/to filters
cannot be supplied by the client. Employee identity comes only from authentication.

```http
GET /api/employee/shifts?weekStart=2026-11-16&page=1&limit=20
```

The response is:

```json
{
  "weekStart": "2026-11-16",
  "timezone": "Asia/Beirut",
  "from": "2026-11-15T22:00:00.000Z",
  "to": "2026-11-22T22:00:00.000Z",
  "shifts": [],
  "pagination": { "page": 1, "limit": 20, "total": 0, "totalPages": 0 }
}
```

Shifts use the existing selection: id, employeeId, stored stationId, startsAt,
endsAt, createdAt, and minimal employee/station objects with id/name/isActive.
Times serialize in UTC. The predicate is authenticated employeeId AND
`startsAt < to AND endsAt > from`. Overnight and cross-week shifts are included,
including shifts spanning the entire week. A shift ending exactly at `from` or
starting exactly at `to` is excluded. No current station/active-station predicate
is applied: reassignment or station deactivation does not hide schedule history.

The existing repository provides `startsAt ASC, id ASC` ordering, database
pagination, and identical predicates for rows/count inside Repeatable Read.
An out-of-range page has no rows but preserves total/totalPages.

## Employee home page

Only signed-in EMPLOYEE users receive the weekly schedule, alongside Stage 1
attendance controls. The Stage 1 session and credentialed API client are reused.
The default week is computed from the current date in Asia/Beirut, independent
of the browser's timezone. Previous week, Next week, and This week controls
operate on calendar dates and reset pagination to page 1. Previous/Next page
controls expose every result page using the API's default 20-row limit.

Each shift shows its recorded station (including inactive labeling) and full
local start/end dates, times and timezone abbreviations, making overnight work
explicit. Loading, empty results, errors, and retry are handled within the schedule
component. Old requests are aborted and ignored on week/page changes, even if a
transport ignores cancellation. A schedule failure never disables check-in/out.

## Permission deployment (later, explicit)

From the repository root:

```powershell
npm run provision-employee-shift-permissions --workspace @smart-fuel-station/api
```

The targeted command requires an existing EMPLOYEE role. It reuses/upserts the
existing `shifts.read` definition and adds only its employee link, preserving
HR/Admin and all unrelated grants. No startup provisioning occurs. Fresh-install
seed definitions include the employee grant; do not rerun the replacing general
seed on an established database. No Prisma schema change or migration is required.

## Verification

API tests cover authentication, roles/permissions, identity isolation, strict
calendar validation, both DST changes, overlap boundaries/overnight work,
historical stations and reassignment, empty ranges, ordering and pagination.
Jest/Supertest uses mocked Prisma; it verifies query construction/HTTP behavior.
Web tests cover Beirut week rollover, navigation, pagination reset, stale success
and failure responses, local overnight display, errors/empty results, and working
check-in/out while schedule loading fails. The Stage 1 comparison baseline is
653 API tests and 20 web tests.

No database writes, migrations or provisioning were performed for this stage.
Manager/HR/Admin contracts, Stage 1 attendance controls, and orders are unchanged.

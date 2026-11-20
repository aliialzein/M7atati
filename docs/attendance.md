# HR Stage 2: shift and attendance reads

`GET /api/shifts` returns `{ shifts, pagination }`; `GET /api/attendance` returns
`{ attendance, pagination }`. Both require cookie authentication, an ADMIN or HR
role, and respectively `shifts.read` or `attendance.read`. An EMPLOYEE's existing
`attendance.read` grant does not authorize these global views. Responses use
`Cache-Control: no-store`. There are no write endpoints in this stage.

## Filters and responses

Both endpoints accept optional positive integer `stationId` and `employeeId`,
`from` and `to` timestamps, and the existing pagination parameters: `page` defaults
to 1 (maximum 1,000,000), `limit` defaults to 20 (maximum 100). Unknown or repeated
parameters, malformed IDs, and invalid timestamps return 400 `{ message }`.

Times must be ISO timestamps with seconds and an explicit `Z` or `+/-HH:MM`
offset. Up to three fractional second digits are supported, matching storage and
JavaScript precision. URL-encode positive offsets (including the `+`). A supplied
`from` must precede `to` after conversion to UTC; equal/reversed ranges are 400.
Either bound can be omitted. No local timezone is inferred.

```text
GET /api/shifts?stationId=10&employeeId=3&from=2026-11-19T00:00:00Z&to=2026-11-20T00:00:00Z&page=1&limit=20
```

Ranges are half-open: `[from, to)`. A shift matches when `startsAt < to` and
`endsAt > from`, omitting the predicate for an absent bound. Attendance matches
when `clockInAt < to` and (`clockOutAt > from` or clock-out is null). Overnight
records are included by overlap. Null clock-out represents an open record with
no known end; queries never manufacture a clock-out or use the current time as
one. Records ending exactly at `from` or starting exactly at `to` are excluded.

Ordering is ascending start/clock-in time, then ID. Pagination includes `page`,
`limit`, `total`, and `totalPages`; empty results have total and totalPages zero.
Rows and totals use identical predicates in a Repeatable Read transaction.

Returned records include ID, employeeId, stored stationId, their operational
times, createdAt, and minimal employee/station objects (`id`, `name`, `isActive`).
Dates serialize as UTC ISO strings. Credentials, email, permissions, and current
employee station assignment are not exposed. No current role, station assignment,
or active-status predicate is applied to historical records.

## Storage and deployment

`Shift` describes scheduled work; `AttendanceRecord` describes actual attendance.
They are independent tables with their own employee and station foreign keys.
Queries filter the record's stationId, so future reassignment does not relocate
history. Deleting referenced users/stations is restricted. Disabling either does
not hide historical records.

The additive `20261119090000_add_shifts_and_attendance` migration creates both
tables and indexes. All new timestamps use `TIMESTAMPTZ(3)`. Database CHECK
constraints require shift end strictly after start and attendance clock-out at
or after clock-in (or null). Existing tables/data are unchanged; no historical
backfill is possible or attempted. Future write workflows must validate employee
roles and assignment policy; these read APIs do not provide such workflows.

From the monorepo root, deploy using the normal configured database:

```sh
npx prisma migrate deploy --config apps/api/prisma.config.ts
npx prisma generate --config apps/api/prisma.config.ts
npm run provision-attendance-permissions --workspace @smart-fuel-station/api
```

The targeted provisioning command requires existing ADMIN and HR roles and
idempotently upserts only `shifts.read`, `attendance.read`, and their links to
those roles. Existing permissions and unrelated role grants are preserved. It
requires database configuration, not JWT signing keys. It never seeds data or
runs at application startup. Fresh-install seed definitions include shifts.read;
do not rerun the replacing permission seed on an established database.

## Verification and demo data

`apps/api/tests/fixtures/attendance.ts` contains explicit TEST/demo shifts and
independently authored attendance, including overnight and open records. Only
tests and the disposable PostgreSQL verifier import it; application startup and
permission provisioning do not. This stage provides no production attendance
source, scheduling, clock-in/out, transfers, hardware, Security, or frontend work.

Jest/Supertest tests use mocked Prisma. Run real storage and API checks with:

```sh
node --import tsx apps/api/scripts/verify-stations-postgres.ts --attendance
```

The existing runner requires local development `m7atati` configuration, creates a
uniquely named disposable database, deploys migrations only there, checks storage
constraints and real API queries, and removes that database afterward. It does
not migrate, seed, or change application data in the development database.

# Manager station analytics

`GET /api/manager/stations/:stationId/analytics` requires the existing authenticated
access cookie, MANAGER role, and **all three** permissions: `reports.read`,
`attendance.read`, and `orders.read`. Other roles are denied even with these grants.
No permissions are provisioned at startup or by this change.

Ownership uses the shared `Station.managerId = authenticated user ID` check.
`User.stationId` is affiliation and cannot authorize access. Inactive managed
stations remain readable for historical reporting. Unknown and unmanaged stations
both return 404 `{ "message": "Station not found" }`, including for ranges with
no matching records. Every response uses `Cache-Control: no-store`.

## Request

Optional `from` and `to` reuse the existing explicit-offset timestamp validator:
ISO timestamps with seconds and at most three fractional digits. Either bound can
be omitted. When both are present, `from` must precede `to` after UTC conversion.
Encode a positive offset's `+` as `%2B` in a URL. Date-only values, timestamps
without offsets, malformed/repeated bounds, invalid station IDs, equal/reversed
ranges, and unsupported parameters return 400 `{ "message": "Invalid request" }`.
Analytics accepts no pagination, employee, amount, status, or station query override.

```http
GET /api/manager/stations/10/analytics?from=2026-11-19T00:00:00Z&to=2026-11-20T00:00:00Z
```

## Response

The following example assumes station 10 is owned by the manager and contains
the existing attendance test fixtures; actual attendance counts come from the
database, not fixtures. Demo order totals for these bounds are deterministic.

```json
{
  "stationId": 10,
  "attendance": { "totalRecords": 4, "openRecords": 1, "closedRecords": 3 },
  "orders": {
    "dataSource": "demo",
    "currency": "USD",
    "totalOrders": 3,
    "countsByStatus": { "PENDING": 2, "COMPLETED": 1, "CANCELLED": 0 },
    "completedOrderedAmountMinor": 6000
  }
}
```

Both sections receive the **same date bounds** with different matching rules:

- Attendance uses interval overlap: `clockInAt < to AND (clockOutAt > from OR
clockOutAt IS NULL)`, omitting absent bounds. Overnight records and open records
  can match even if clock-in preceded `from`. No clock-out or current-time end is
  invented. Historical counts use the record's stored station, irrespective of
  the employee's current assignment, role, or active status.
- Orders use creation time: `createdAt >= from AND createdAt < to`. The endpoint
  reuses Stage 2's deterministic demo factory and complete filtered selection,
  before pagination. It does not read persistent FuelOrder data.

Attendance performs PostgreSQL `count` queries for the entire selection and its
null-clock-out subset. Closed records are total minus open. Ownership and both
counts share a Repeatable Read snapshot. It never counts just a list page or
loads attendance rows to aggregate in JavaScript.

`orders.totalOrders` and `countsByStatus` cover the full matching demo selection.
The breakdown always includes PENDING, COMPLETED, and CANCELLED, including zeros.
`completedOrderedAmountMinor` sums **ordered amount** for COMPLETED orders only,
in USD integer cents. Pending/cancelled amounts are excluded. This is not a
payment, captured amount, or revenue metric. Empty selections return zero counts
and amount while retaining the demo source/currency/status labels. Attendance and
order selections may be empty independently.

## Route consolidation and compatibility

`attendance.routes.ts` now exports three separate router instances:

| Export                    | Mount             | Authorization                                     |
| ------------------------- | ----------------- | ------------------------------------------------- |
| `attendanceRouter`        | `/api/attendance` | ADMIN/HR + attendance.read                        |
| `shiftsRouter`            | `/api/shifts`     | ADMIN/HR + shifts.read                            |
| `managerAttendanceRouter` | `/api/manager`    | MANAGER + attendance.read, plus station ownership |

The manager attendance declarations moved unchanged from the removed
`manager-attendance.routes.ts`; mount paths and middleware order are preserved.
CSV/PDF attachments, shared export filters, and the 5,000-row limit are unchanged.
Analytics and orders each use route-local authorization and mount before the
manager attendance router, preserving independent permission requirements.

## Verification

Existing attendance/shift/export tests ran after consolidation and before analytics
implementation. Analytics tests cover each missing permission, role denial,
ownership/isolation, inactive station history, transferred employees, open and
overnight attendance, date boundaries, empty selections, and agreement with both
lists across multiple pages. Jest/Supertest uses mocked Prisma: it verifies query
construction and HTTP behavior, not live PostgreSQL isolation/storage.

The Stage 2 baseline is 563 tests across 18 suites. Run the full API suite, API
TypeScript check, API lint, and `git diff --check`. Live PostgreSQL verification
requires a separately authorized disposable database; the existing verifier
creates a database and runs migrations and must not be pointed at development
data. No database writes, migrations, permission provisioning, schema changes,
real order processing, payments, or web interface changes are part of this stage.

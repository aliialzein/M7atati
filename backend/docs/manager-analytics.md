# Manager station analytics

The authoritative [frontend API guide](frontend-api-guide.md) supersedes earlier
demo analytics examples. `GET /api/manager/stations/:stationId/analytics` requires
cookie authentication, MANAGER role and all three grants: `reports.read`,
`attendance.read`, `orders.read`. Ownership is checked against Station.managerId;
affiliation is insufficient. Historical inactive owned stations remain readable.
Unknown and unmanaged stations return 404. Responses use no-store.

Optional strict query: from,to explicit-offset timestamps with at most millisecond
precision. Require from<to when both supplied. No pagination, currency, employee,
status or amount parameters. Encode a positive offset's plus as %2B.

```json
{
  "stationId": 10,
  "attendance": {"totalRecords":4,"openRecords":1,"closedRecords":3},
  "orders": {
    "dataSource":"database",
    "totalOrders":3,
    "countsByStatus":{"AWAITING_PAYMENT":1,"PENDING":1,"IN_PROGRESS":0,"COMPLETED":1,"CANCELLED":0}
  }
}
```

Values above are illustrative, not generated fixtures. Persisted order groupBy
counts use createdAt >= from / < to. Attendance counts use interval overlap:
clockInAt<to and (clockOutAt>from or null), with absent bounds omitted. Closed
records = total minus open. Historical records retain their original station.
Ownership and both aggregates share a Repeatable Read database snapshot.

Every known order status has a count, even on empty stations; legacy status
strings also appear rather than being discarded. No currency, revenue or
completedOrderedAmountMinor field is returned. Do not infer monetary totals from
these counts or sum legacy/mixed-currency amounts in the frontend.

Errors: 400 invalid strict query/ID,401 authentication,403 missing role or any
required grant,404 station scope, sanitized500; normal `{message}` envelope.
HTTP tests mock Prisma and cover aggregate/filter agreement with underlying
lists, empty states, grants, scope and history. Task03 checked scoped analytics
reads on PostgreSQL; Task07 did not run a live aggregate/isolation verification.
Task08 subsequently resolved the Stage9 order retry defect and passed full
guarded local PostgreSQL order acceptance. This does not upgrade analytics
aggregate isolation or production deployment verification beyond the evidence
above; current module readiness is tracked in the frontend guide.

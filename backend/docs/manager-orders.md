# Manager persisted orders and cash confirmation

Current integration contracts are consolidated in the authoritative
[frontend API guide](frontend-api-guide.md). Earlier demo order IDs, generated
fixtures and `dataSource: "demo"` are not served by these routes.

All routes require an active authenticated MANAGER. Listing/detail require
`orders.read`; cash confirmation requires `payments.manage`. ADMIN is not a
manager bypass. Ownership is `Station.managerId = caller.id`, independent of
affiliation. Unknown/unmanaged stations and out-of-station orders return 404.
Historical listing/detail remain available on inactive owned stations; new cash
confirmation requires an active station. Responses use no-store.

| Method | Path | Contract |
| --- | --- | --- |
| GET | `/api/manager/stations/:stationId/orders` | 200 `{dataSource:"database",stationId,orders,pagination}` |
| GET | `/api/manager/stations/:stationId/orders/:orderId` | 200 `{dataSource:"database",stationId,order}` |
| POST | `/api/manager/stations/:stationId/orders/:orderId/confirm-cash` | 201 new / 200 replay `{dataSource:"database",stationId,order,payment,replayed}` |

IDs are positive int32 database IDs, not UUIDs or synthetic station-derived IDs.
Listing accepts optional page (default1,max1000000), limit (default20,max100),
from/to explicit-offset timestamps, status, minAmountMinor/maxAmountMinor.
Unknown/repeated query parameters are rejected. Bounds require from<to; order
creation time uses [from,to) and amount bounds are inclusive nonnegative int32
strings. Ordering is createdAt descending, then ID descending. Empty lists retain
the normal pagination envelope. Detail and cash accept no query parameters.

ManagerOrder fields: id,status,createdAt,orderedVolume,pump{id,number},
fuelType{id,name,code},stationId,assignedEmployeeId,claimedAt,updatedAt,source,
currency,fulfillmentType,unitPriceMinor,orderedAmountMinor,dispensedVolume,
finalMinor,scheduledFor,expiresAt,assignee{id,name,isActive}. Selected optional
relationships/legacy values are null; decimal volumes are JSON strings.
Detail additionally returns events ordered createdAt/ID ascending, with
id,actorUserId,actorType,fromStatus,toStatus,createdAt,note. Customer contact and
quote credentials are excluded. There is no currency filter or revenue total.

Cash requires allowed Origin/CSRF and the strict body:

```json
{"amountMinor":249,"currency":"USD","pumpId":7}
```

Amount/currency must match the order exactly. A new confirmation requires an
AWAITING_PAYMENT order without prior payment/claim and an IDLE same-station pump
without PENDING/IN_PROGRESS reservations. It atomically creates CONFIRMED CASH
payment, changes the order to PENDING with pumpId, and appends one event. Exact
replay returns 200 without another write; differing confirmation is 409. Existing
successful confirmation can be acknowledged after completion/deactivation, but
authorization is rechecked. Pump lookup availability is only a snapshot.

Normal errors use `{message}`: 400 input,401 authentication,403 role/grant/CSRF,
404 scope/not found,409 conflicting state/reservation/idempotency, sanitized500.
See the guide for exact CashOrder/CashPayment projections and frontend sequences.

Jest/Supertest mocks Prisma. Task03/03.5 ownership and Task05.5 focused pump/cash/
claim/completion/concurrency/rollback PostgreSQL checks passed on disposable
targets. **Task08 resolved the Stage9 retry defect and passed full guarded local
PostgreSQL order acceptance**, including cash/claim/completion, concurrency and
real transaction rollback. Deployment/operational conditions remain in the guide.
Task07 did not run Stage9 scenarios or use any database; Jest guard-refusal tests
stop before database imports.

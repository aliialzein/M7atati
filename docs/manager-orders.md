# Manager Stage 2: demo orders

`GET /api/manager/stations/:stationId/orders` requires the existing authenticated
access cookie, MANAGER role, and `orders.read` permission. It does not require
`attendance.read`. No new permissions or permission provisioning are introduced.

The shared Stage 1 ownership lookup requires `Station.managerId` to equal the
authenticated user ID. `User.stationId` affiliation cannot establish ownership.
Inactive managed stations remain readable. Unknown and unmanaged station IDs
both return 404 `{ "message": "Station not found" }`, including when filters
would match no orders. Authentication failures return 401; role/permission denial
returns 403. Every response uses `Cache-Control: no-store`.

## Demo data

The source is explicitly labeled `"dataSource": "demo"`. The endpoint reads the
database only for authentication and station ownership. It does not read/write
FuelOrder, create orders/payments, seed at startup, or change the schema.

Eight deterministic in-memory records are materialized for **any existing managed
station ID**, so local development needs no database order fixtures. Dates are
fixed UTC instants from November 18-21, 2026; they do not move with today's date.
All records use USD integer cents and PENDING, COMPLETED, or CANCELLED statuses.

IDs are `stationId * 100 + sequence`, with sequence 1-8. Positive int32 station IDs
produce globally distinct, safe JavaScript integer demo IDs. Nonzero template
amounts add `(stationId % 100) * 100` cents, making nearby stations' amounts
different as well. These IDs and statuses are a demo contract, independent of
future persistent order semantics.

`orders.demo.ts` exports a pure factory and selector for future analytics.
The selector requires a station ID, applies every filter, and sorts the complete
selection without paginating or mutating its input. The endpoint verifies
ownership before calling it; future callers must do the same.

## Filters and response

| Parameter                          | Contract                                                                                             |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `from`, `to`                       | Optional explicit-offset ISO timestamps with seconds, at most 3 fractional digits; `from < to`       |
| `minAmountMinor`, `maxAmountMinor` | Optional inclusive nonnegative integer cents, maximum 2,147,483,647; minimum must not exceed maximum |
| `status`                           | Optional exact uppercase PENDING, COMPLETED, or CANCELLED                                            |
| `page`                             | Default 1; positive integer, maximum 1,000,000                                                       |
| `limit`                            | Default 20; positive integer, maximum 100                                                            |

Date filters use order creation time, **`createdAt >= from AND createdAt < to`**,
omitting absent bounds. Encode a positive offset's `+` as `%2B` in URLs. Station
scope and every filter apply before total/count and pagination. Ordering is
`createdAt DESC, id DESC`; tied timestamps remain stable across pages.

Unknown/repeated parameters, invalid station IDs, reversed/equal date ranges,
reversed amount ranges, negatives, fractional/scientific notation, invalid
statuses, and invalid pagination return 400 `{ "message": "Invalid request" }`.
`stationId` cannot be overridden in the query; currency is fixed and not a filter.

The response is `{ dataSource: "demo", orders, pagination }`. Each order contains
only `id`, `stationId`, `status`, `createdAt` (UTC ISO), `orderedAmountMinor`, and
`currency` (`USD`). Pagination includes `page`, `limit`, `total`, and `totalPages`.
An empty selection has zero total/totalPages. A page beyond the filtered selection
returns an empty orders array while retaining its filtered total/totalPages.

## Known matching request

If station 10 exists and is managed by the authenticated manager:

```http
GET /api/manager/stations/10/orders?from=2026-11-19T12:00:00Z&to=2026-11-20T00:00:00Z&minAmountMinor=6000&maxAmountMinor=6000&status=COMPLETED&page=1&limit=20
```

```json
{
  "dataSource": "demo",
  "orders": [
    {
      "id": 1003,
      "stationId": 10,
      "status": "COMPLETED",
      "createdAt": "2026-11-19T12:00:00.000Z",
      "orderedAmountMinor": 6000,
      "currency": "USD"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

For another managed station `S`, sequence 3 is always COMPLETED at
`2026-11-19T12:00:00.000Z`, with ID `S * 100 + 3` and amount
`5000 + (S % 100) * 100`. Use `/api/stations/managed` to discover your station IDs.

## Verification and scope

Jest/Supertest tests use mocked database reads for real route authorization and
exercise real demo selection with multiple stations, cross-manager requests,
combined filters, boundaries, empty selections, and pagination. Pure selector
tests check deterministic data, isolation from mutation, and safe IDs.

Run the full API suite (including Stage 1 exports), API TypeScript check, API lint,
and `git diff --check`. Stage 1's reported baseline is 481 API tests. There are no
new dependencies, migrations, schema changes, permission provisioning, analytics,
payment workflows, order writes, or frontend changes in this stage.

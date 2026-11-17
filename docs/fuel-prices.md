# External reference fuel prices

Prices are station-independent **Lebanon market reference prices**, not a world
average, station selling prices, crude benchmarks or order charging inputs.
No orders, scheduling, polling or frontend integration is added.

## Provider contract and actual coverage

Reviewed 2026-11-17: [retail contract](https://oilapi.net/documentation/prices-retail),
[authentication](https://oilapi.net/documentation/authentication),
[fuel codes/units](https://oilapi.net/documentation/fuels-and-units),
[Lebanon coverage](https://oilapi.net/prices/lebanon),
[plans](https://oilapi.net/documentation/plans),
[pricing](https://oilapi.net/pricing) and [terms](https://oilapi.net/terms).

The trusted request is `GET https://api.oilapi.net/v1/prices/retail?country=lb`,
with the server-side `X-API-Key` header. Latest data uses
`data.country` and `data.fuels[]` containing fuel, kind, interval, date, price,
currency, unit and optional freshness. Dates are UTC effective dates/period starts.
Lebanon documentation distinguishes government-set prices from national averages.

**Live ingestion verified on 2026-11-17.** In addition to the public fuel-code
catalog, authenticated `GET /v1/countries/lb` identifies:

| Provider product | Authoritative series name | Explicit unit | Internal fuel |
|---|---|---|---|
| `gasoline_95_20l` | Lebanon 95 octane petrol, set retail price | `20_litres` | `gasoline_95` |
| `diesel_20l` | Lebanon diesel, set retail price | `20_litres` | `diesel` |

Both are retail-family LBP series, distinct from heating diesel. The latest
retail response independently confirms `20_litres`, monthly/set, effective
2026-11-01 and freshness `on_schedule`. Mapping is explicit, based on grade names
and unit metadata, not suffix inference. Only these two 20-litre codes are mapped;
98 RON is ignored and can never satisfy the required 95 RON batch.

For these pairs, normalized `price = providerPrice / 20`, `unit=litre`, using
64-significant-digit Decimal arithmetic. Preserve `providerFuelCode`,
`providerPrice`, `providerUnit` and `conversionDivisor=20` alongside normalized
values. Native exact `gasoline_95`/`diesel` with explicit `litre` remain supported
with divisor 1. Mismatched code/unit pairs, missing required fuels and unsupported
grades fail closed. The earlier empty native-grade histories are no longer a
blocker because the confirmed 20-litre products provide those exact grades.

The free plan allows 50 calls/day, 10/minute, yesterday's UTC data and 30 days of
provider history. The local history endpoint reads retained observations, not a
provider historical download. Plan-specific missing/null values are unavailable,
never zero. The key's subscription tier is not inferred from its text. Metadata
states the known free-plan delay without claiming all keys have the same tier.

Terms permit use within one's own applications and showing results to users,
but prohibit republishing/redistributing provider data through a separate API/feed
and bulk replication. No explicit client-cache retention duration was found in the
reviewed terms. These routes are for the application's authenticated ADMIN only;
confirm intended internal historical retention/use with the provider before a
production rollout. Do not expose this as a public data redistribution service.

## Configuration and endpoints

Use Node >=22 (tested Node 25); exact price parsing requires JSON reviver source
context. Set optional `OILAPI_API_KEY` in the ignored `apps/api/.env`; the example
file contains only an empty placeholder. Do not send a key/URL/market in requests.
Missing key permits unrelated startup and stored reads; refresh returns sanitized
503. No environment values or raw upstream errors are logged or returned.

All routes use existing cookie authentication, **explicit ADMIN** and the listed
permission. Existing MANAGER pricing grants do not bypass the role requirement.
Responses use the existing JSON envelope/HTTP conventions and `Cache-Control:
no-store`. Refresh also requires an allowed `Origin` and `X-CSRF-Protection: 1`.

| Method | Path | Permission | Request/result |
|---|---|---|---|
| POST | `/api/fuel-prices/refresh` | `pricing.update` | Empty JSON `{}`; validated complete batch, inserted/skipped counts and metadata |
| GET | `/api/fuel-prices/current` | `pricing.read` | No query fields; `{prices, metadata}` |
| GET | `/api/fuel-prices/history` | `pricing.read` | Optional `fuel`, `from`, `to`, `page`, `limit`; `{prices, pagination, metadata}` |

Unknown fields are rejected. `fuel` is exactly `gasoline_95` or `diesel`.
`from`/`to` are real `YYYY-MM-DD` dates, inclusive effective-date bounds, from <= to.
Pagination defaults page 1/limit 20; maximum page 1,000,000, limit 100.

Sanitized persisted live quote from the listening development API:

```json
{
  "id": 2,
  "provider": "oilapi",
  "market": "LB",
  "fuelCode": "gasoline_95",
  "price": "132550",
  "providerFuelCode": "gasoline_95_20l",
  "providerPrice": "2651000",
  "providerUnit": "20_litres",
  "conversionDivisor": 20,
  "currency": "LBP",
  "unit": "litre",
  "effectiveAt": "2026-11-01",
  "fetchedAt": "2026-11-17T11:32:42.993Z",
  "lastSeenAt": "2026-11-17T11:32:42.993Z",
  "seriesKey": "derived:set:month:gasoline_95_20l:20_litres",
  "providerSeriesId": null,
  "kind": "set",
  "interval": "month",
  "freshness": "on_schedule",
  "ageDays": 16,
  "stale": false
}
```

Empty current/history returns HTTP 200 and `prices: []`; history total/totalPages
are zero. GET never fetches upstream. No legacy price with unknown market/unit is
presented as a current reference price.

## Storage, corrections and freshness

`FuelPrice.price` is Decimal(32,14), up to 18 integer and 14 fractional digits.
Original `providerPrice` is Decimal(30,12). Dividing by 20 can require two extra
fractional digits; widening the normalized column preserves those digits and all
pre-existing values. A database CHECK enforces supported conversion pairs and
`price * conversionDivisor = providerPrice` when provenance fields are present.
Raw JSON numeric tokens become Decimal strings without a JavaScript Number
roundtrip. Nonpositive, nonfinite, overflow and excessive-scale values are
rejected rather than rounded. JSON returns price strings. Existing FuelType IDs,
names and relationships are retained; exact missing fuel codes are inserted only
after a complete validated batch, inside the ingestion transaction.

Legacy price IDs, `priceMinor`, currency, source and fetch time stay intact with
`provenance=legacy`; new metadata is null. `priceMinor` becomes nullable only to
allow new `external_reference` rows with exact decimal amounts. No inferred cents,
units or markets, and no changes to order/payment integer semantics. Older
observations without original-unit provenance retain null provenance fields;
the new migration does not fabricate them.

Database quote identity is provider + market + exact fuel code + series key +
currency + unit + effective date + exact decimal price. The unique index enforces
idempotency under concurrent ingestion. Corrected values append observations;
existing values and IDs are retained. Identical observations update only
`lastSeenAt`/freshness, preserving the first `fetchedAt`. A re-observed previous
value may therefore become the latest correction without adding another row:
this is a distinct-value observation history, not a log of every poll.

When the provider supplies `series`, retain it as providerSeriesId and prefix its
key with `provider:`. Otherwise `derived:<kind>:<interval>` explicitly identifies
our derived series; ambiguous duplicate entries for one fuel/series/date fail.
Converted series also append the original product and unit to the key, preserving
native/20-litre series separation and their distinct correction histories.
Current selects the greatest **effective date**, then latest observed correction,
then ID, separately per provider/market/fuel/series/currency/unit. Older prices
fetched later cannot displace a newer effective period. History uses the same
stable descending ordering; subsequent ingestion can naturally change pagination.

Provider freshness is retained alongside effective/fetch timestamps and computed
ageDays. `stale` is a local display heuristic: age > 2 days for daily, 14 weekly,
75 monthly, 400 yearly; it is not a provider SLA. Unknown periods fail validation.

A persisted atomic claim enforces a **one-hour** provider/market cooldown across
API processes, including failed attempts. No automatic retries or polling.
One fetch retrieves all grades, capped at 8 seconds (including body read) and
256 KiB. Fetch and parse occur before the short ingestion transaction. A malformed
required grade rejects the whole batch. Failure changes only cooldown metadata,
never stored prices. Local/provider rate limits return 429; credentials denied,
coverage/malformed data and upstream failures 502; timeout 504; missing key 503.
Messages are fixed/sanitized. An unexpected database error uses the shared generic
500 handler.

## Deployment and verification

Applied to the explicitly authorized local PostgreSQL database `m7atati` on
2026-11-17 using `migrate deploy`:

- `20261117090000_add_user_token_version`: deactivation token invalidation; old
  unversioned tokens require fresh login.
- `20261117100000_add_reference_fuel_prices`: additive reference metadata,
  legacy-preserving nullable integer amount, quote uniqueness and cooldown.
- `20261117110000_preserve_provider_price_units`: original quote provenance,
  normalized decimal-scale widening and exact-conversion CHECK.

Before deployment, migration status showed only those three pending migrations;
the read-only schema diff contained only their expected changes. Applied historical
migration checksums matched after accounting for Windows line endings. Afterward,
migration status was up to date and the schema diff was empty. The targeted pricing
provisioner ran twice; ADMIN has both pricing grants and the complete existing set
of 60 role-permission links remained unchanged. No full seed/reset was run.

After selecting and checking the intended deployment database, use:

```powershell
node_modules/.bin/prisma.cmd migrate status --config apps/api/prisma.config.ts
node_modules/.bin/prisma.cmd migrate deploy --config apps/api/prisma.config.ts
node_modules/.bin/prisma.cmd generate --config apps/api/prisma.config.ts
npm.cmd run provision-pricing-permissions --workspace @smart-fuel-station/api
```

The targeted provisioning command reuses `pricing.read`/`pricing.update`, requires
the existing ADMIN role, and only upserts these permission definitions/ADMIN links.
It does not remove existing grants (including older MANAGER pricing grants),
create users, change credentials or run the destructive full seed. Explicit ADMIN
authorization enforces these routes independently of other grants.

The latest verification intentionally ran **unit tests only** (71 tests/7 suites),
typecheck, lint, build, Prisma validation and diff checks. Unit parsing/conversion
tests include 30-digit original prices; mocked-repository tests check metadata,
skipped duplicates and append-only correction calls. They do not establish real
PostgreSQL concurrency behavior. All integration/Supertest/disposable PostgreSQL
tests were **NOT RUN at the user's request** for this unit-normalization change.

Unit-only command (the default test command also includes integration suites):

```powershell
node_modules/.bin/jest.cmd --config apps/api/jest.config.cjs --runInBand --testMatch '**/tests/unit/**/*.test.ts' --no-cache --silent --verbose=false
```

The existing opt-in PostgreSQL harness (not run for this change) creates a disposable DB,
deploys repository migrations, tests pre-migration legacy retention and runs
targeted provisioning twice before real in-process HTTP/auth/Prisma checks:

```powershell
node_modules/.bin/tsx.cmd apps/api/scripts/verify-stations-postgres.ts --prices
node_modules/.bin/tsx.cmd apps/api/scripts/verify-stations-postgres.ts --users
node_modules/.bin/tsx.cmd apps/api/scripts/verify-stations-postgres.ts
```

Focused manual HTTP smoke testing used the listening server started with the
normal development command. Health/readiness, ADMIN login/profile, refresh,
current and filtered history all returned 200. Refresh inserted exactly two live
quotes: petrol 95 `2651000 / 20 = 132550` and diesel `2576000 / 20 = 128800`
LBP/litre. Current/history matched original values, units, effective dates and
freshness. The next refresh returned local cooldown 429 without another provider
request. Logout returned 204 and the smoke session was verified revoked.

There was initially no ADMIN. After the user configured intended credentials in
the ignored environment file, the existing bootstrap command created one ADMIN;
the existing active MANAGER was preserved. Both live quotes remain as intended
development data. No test stations or disposable databases were created. The API
was left running for local development; no commit or push was performed.

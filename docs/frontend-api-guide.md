# Frontend API integration contract

Authoritative integration reference, audited against mounted Express routes on
2026-11-23 (Task 07). Domain documents provide implementation/deployment history;
this guide supersedes their older demo/stage assumptions. Updated by Task 08
after full guarded local PostgreSQL order acceptance passed. **Overall readiness:
READY WITH CONDITIONS. The Stage 9 HTTP500 blocker is resolved; deployment
configuration, primary-data compatibility, secrets, CORS and operational readiness
are not certified by local acceptance.** See the Task 08 evidence below.

## Connection, identity and browser security

Development API origin defaults to `http://localhost:4000`; the base path is
`/api`. `PORT` can override 4000. Frontend API-origin configuration is deployment
specific; the backend does not define a frontend environment-variable name.
Backend secrets/configuration are `DATABASE_URL`, `JWT_ACCESS_SECRET`,
`JWT_REFRESH_SECRET`, `JWT_ISSUER`, `JWT_AUDIENCE`, `ALLOWED_ORIGINS`, `NODE_ENV`
and optionally `OILAPI_API_KEY` for reference-price refresh. Never send database
or provider credentials to the browser. Production origins must be explicit HTTPS
origins; same-site frontend/API deployment is the current cookie assumption.

Use `credentials: 'include'`. JWTs are HttpOnly cookies, never authentication
JSON fields: `m7atati_access` (path `/api`, 900 seconds), `m7atati_refresh`
(path `/api/auth`, 604800 seconds). Both are host-only, SameSite=Lax and Secure
in production. Every unsafe request, including guest order creation and auth
POSTs, needs an allowed `Origin` and `X-CSRF-Protection: 1`. Browsers set Origin;
non-browser callers must supply it. GET/HEAD/OPTIONS do not need CSRF proof.
JSON bodies use `Content-Type: application/json`, maximum 16 KB.

```ts
const response = await fetch(`${apiOrigin}/api/auth/login`, {
  method: 'POST', credentials: 'include',
  headers: { 'Content-Type': 'application/json', 'X-CSRF-Protection': '1' },
  body: JSON.stringify({ email, password }),
});
const payload = await response.json();
if (!response.ok) throw new Error(payload.message);
```

Registration, login, refresh and `/auth/me` all return `{ user: AuthUser }`:

```json
{"user":{"id":21,"name":"Manager","email":"manager@example.invalid","role":"MANAGER","stationId":null,"permissions":["orders.read","payments.manage"]}}
```

This grant list is illustrative. Database role grants are authoritative; keys are
deduplicated and sorted lexicographically. No grants means `[]`, including ADMIN.
ADMIN has no wildcard bypass. Roles: ADMIN, MANAGER, EMPLOYEE, HR, SECURITY,
CUSTOMER. A permission is a capability; endpoint role restrictions, ownership,
affiliation and activity checks still apply. `User.stationId` is affiliation;
`Station.managerId` is manager ownership. Neither adds permission strings.

```tsx
const showCashAction = user.permissions.includes('payments.manage');
return showCashAction ? <button onClick={confirmCash}>Confirm cash</button> : null;
```

Hiding a button is not authorization. Editing/sending permissions cannot grant
access. Authentication reloads database grants each request; JWTs carry no role
or permission snapshot. Role/affiliation edits revoke refresh sessions; existing
access tokens see current identity. Deactivation increments tokenVersion and
revokes sessions; reactivation does not restore old tokens. Logout revokes refresh
capability, not an already-issued access token. In-flight reads may use their
earlier snapshot. Restore the session with `/auth/me`, not browser-stored claims.

## Identifier, query, time and money rules

- All resource IDs in paths/queries are canonical positive decimal int32 strings
  (`1` through `2147483647`); JSON ID fields are numbers. No leading zero, sign,
  decimal or exponent path/query representation. Exceptions are quote IDs,
  order idempotency keys and attendance request IDs: UUID strings, normalized
  lowercase. Guest credentials are separate 64-character lowercase hexadecimal
  strings; never substitute an auth JWT or quote UUID.
- Paginated queries use string `page=1`, `limit=20` defaults; page max 1000000,
  limit max 100. Responses use `{page,limit,total,totalPages}`; zero matches means
  total/totalPages zero. A page beyond the end has an empty array but retains the
  filtered totals. No client-selected sort parameters exist.
- Strict query objects reject unknown/repeated parameters. **Not all endpoints
  parse queries.** Inventory `I` means ignored; `N` means none allowed (400 for
  any parameter). Body validators are strict where a body is listed. `—` means
  no defined body contract, not a promise to validate an unexpected body.
- Timestamp inputs require seconds, explicit Z or ±HH:MM, and at most three
  fractional digits. URL-encode `+` as `%2B`. Returned Date values are UTC ISO
  strings. Reference-price effective dates instead use `YYYY-MM-DD`.
- Date-time ranges require `from < to`, use `[from,to)`, and can be one-sided.
  Orders filter **creation time**. Work records filter **interval overlap**:
  start < to and end > from, with null attendance end treated as open. Reference
  price date ranges are inclusive, permit from=to, and do not use timestamps.
- Decimal database quantities serialize as decimal **strings**, not JSON numbers.
  Stored orderedVolume need not be fixed-width; quote.quantity is fixed to three
  places. Coordinates are JSON numbers/null. Counts, IDs and minor money are
  JSON integers. Nullable selected fields remain null; conditional guest-token
  fields are omitted for authenticated customers.
- Supported checkout currencies: USD (minor unit cents, 2 decimal places) and
  LBP (minor unit whole LBP, 0 places). `unitPrice`/quote `value` inputs are decimal
  strings without signs/exponents; positive and within storage limits. LITERS
  accepts at most three decimals. Quotes return integer minor values plus formatted
  decimal strings. Amount-mode rounding never charges beyond the requested budget.
  Do not compute authoritative totals with frontend floating-point arithmetic.
- Reference provider prices are decimal strings in their declared currency/unit,
  not checkout tariffs. Selling tariffs are **global**, not station-specific.
  Legacy persisted orders can have nullable currency/fulfillment fields; do not
  assume legacy money has a known currency or all legacy statuses are enumerated.

## Complete mounted endpoint inventory

52 explicit method/path pairs, excluding automatic HEAD, CORS OPTIONS, middleware,
and unmatched routes. All paths below include the actual `/api` mount.

Access abbreviations: `P` public; `A` ADMIN; `M` MANAGER; `E` EMPLOYEE;
`H` HR; `C` CUSTOMER. Staff rows require an active access-cookie account.
`G/C` means guest with **no access cookie**, or CUSTOMER with the indicated grant.
A supplied invalid/expired cookie is 401; staff cookies on customer routes are
403, never silently treated as guests. `Owned` means station.managerId equals
the manager; `assigned` means the employee's current station, which must be active
for order operations. Customer reads/cancel require own userId or guest capability.

Error shorthand `B`: malformed validated input 400, authentication 401,
role/permission/CSRF denial 403, unexpected failure sanitized 500 where applicable.
It does not mean every row can produce every status; public GETs do not require
authentication. State/resource/provider errors are listed explicitly.
Query/body/DTO names are fully defined in the following sections.

<!-- endpoints:start -->
| Method | Full mounted path | Access / scope | Query | Body | Success | Additional errors |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/health` | P | I | — | 200 `{status:"ok"}` | — |
| GET | `/api/health/ready` | P | I | — | 200 `{status:"ok",database:"connected"}` | 503 `{status:"error",database:"disconnected"}` |
| POST | `/api/auth/register` | P, creates CUSTOMER | I | Register | 201 `{user:AuthUser}` + cookies | B,409,429 |
| POST | `/api/auth/login` | P, active account | I | Login | 200 `{user:AuthUser}` + cookies | B,429 |
| POST | `/api/auth/refresh` | valid refresh cookie/session/version | I | — | 200 `{user:AuthUser}` + rotated cookies | B,429 |
| POST | `/api/auth/logout` | optional refresh cookie | I | — | 204, clears cookies | B |
| GET | `/api/auth/me` | authenticated, any role | I | — | 200 `{user:AuthUser}` | B |
| GET | `/api/users` | A/all; M/owned-station EMPLOYEEs; H/EMPLOYEEs; `users.read` | Users | — | 200 `{users:ManagedUser[],pagination}` | B |
| GET | `/api/users/:id` | same user read scope, `users.read` | I | — | 200 `{user:ManagedUser}` | B,404 |
| POST | `/api/users` | A/staff; M/owned EMPLOYEE; H/EMPLOYEE; `users.create` | I | CreateUser | 201 `{user:ManagedUser}` | B,409 |
| PATCH | `/api/users/:id` | A or M/owned EMPLOYEE; `users.update`; H denied | I | UpdateUser | 200 `{user:ManagedUser}` | B,404,409 |
| PATCH | `/api/users/:id/status` | A or M/owned EMPLOYEE; `users.update`; H denied | I | `{isActive:boolean}` | 200 `{user:ManagedUser}` | B,404,409 |
| POST | `/api/users/:id/transfer` | A or H, EMPLOYEE only; `employees.transfer` | I | `{stationId:number}` | 200 `{user:ManagedUser}` | B,404,409 |
| GET | `/api/stations/picker` | P, active stations only | I | — | 200 `{stations:PickerStation[]}` | 500 |
| GET | `/api/stations/managed` | M, no additional permission; owns station | I | — | 200 `{stations:[{id,name,isActive}]}` | B |
| GET | `/api/stations` | A, `stations.read` | Stations | — | 200 `{stations:Station[],pagination}` | B |
| POST | `/api/stations` | A, `stations.create` | I | CreateStation | 201 `{station:Station}` | B |
| GET | `/api/stations/:id` | A, `stations.read` | I | — | 200 `{station:Station}` | B,404 |
| PATCH | `/api/stations/:id` | A, `stations.update` | I | UpdateStation | 200 `{station:Station}` | B,404,409 |
| PATCH | `/api/stations/:id/status` | A, `stations.update` | I | `{isActive:boolean}` | 200 `{station:Station}` | B,404,409 |
| PATCH | `/api/stations/:id/manager` | A, `stations.update` | I | `{managerId: number or null}` | 200 `{station:Station}` | B,404,409 |
| GET | `/api/stations/:id/pumps` | A/`stations.read` or M/owned/`payments.manage` | N | — | 200 `{pumps:[{id,number,status,available}]}` | B,404,409 inactive |
| GET | `/api/fuel-types` | P, global catalog | N | — | 200 `{fuelTypes:[{id,name,code}]}` | 400,500 |
| POST | `/api/fuel-prices/refresh` | A, `pricing.update` | N | empty/`{}` | 200 `{inserted,skipped,metadata}` | B,429,502,503,504 |
| GET | `/api/fuel-prices/current` | A, `pricing.read` | N | — | 200 `{prices:ReferencePrice[],metadata}` | B |
| GET | `/api/fuel-prices/history` | A, `pricing.read` | ReferenceHistory | — | 200 `{prices:ReferencePrice[],metadata,pagination}` | B |
| POST | `/api/fuel-prices/selling` | A, `pricing.update` | I | SellingPriceInput | 201 `{price:SellingPrice}` | B,404,409 |
| GET | `/api/fuel-prices/selling` | A, `pricing.read` | SellingHistory | — | 200 `{prices:SellingPrice[],pagination}` | B |
| GET | `/api/fuel-prices/selling/current` | A, `pricing.read` | SellingCurrent | — | 200 `{price:SellingPrice}` | B,404 absent tariff |
| GET | `/api/shifts` | A/H, `shifts.read` | WorkRecords | — | 200 `{shifts:Shift[],pagination}` | B |
| GET | `/api/attendance` | A/H, `attendance.read` | WorkRecords | — | 200 `{attendance:Attendance[],pagination}` | B |
| GET | `/api/employee/shifts` | E, `shifts.read`, own historical records | EmployeeWeek | — | 200 `{weekStart,timezone,from,to,shifts:Shift[],pagination}` | B |
| GET | `/api/employee/attendance/current` | E, `attendance.read`, own records | N | — | 200 AttendanceCurrent | B |
| POST | `/api/employee/attendance/check-in` | E, `attendance.self.write` | N | `{requestId:UUID}` | 200 `{record:SelfRecord}` | B,409 |
| POST | `/api/employee/attendance/:recordId/check-out` | E, `attendance.self.write`, own record | N | empty/`{}` | 200 `{record:SelfRecord}` | B,404,409 |
| GET | `/api/employee/orders` | E, `orders.read`, assigned active station | PendingQueue | — | 200 `{dataSource:"database",stationId,orders:QueueOrder[],pagination}` | B,409 |
| GET | `/api/employee/orders/mine` | E, `orders.read`, own claims, assigned active station | MyWork | — | 200 `{dataSource:"database",stationId,orders:WorkOrder[],pagination}` | B,409 |
| GET | `/api/employee/orders/:id` | E, `orders.read`, same assigned active station | N | — | 200 `{dataSource:"database",stationId,order:EmployeeDetail}` | B,404,409 |
| POST | `/api/employee/orders/:id/claim` | E, `orders.update`, unassigned PENDING at assigned active station | N | empty/`{}` | 200 `{dataSource:"database",stationId,order:EmployeeDetail}` | B,404,409 |
| POST | `/api/employee/orders/:id/complete` | E, `orders.update`, own claim, assigned active station | N | empty/`{}` | 200 `{dataSource:"database",stationId,order:EmployeeDetail}` | B,404,409 |
| POST | `/api/orders/quotes` | G/C, C needs `orders.create`; PICKUP requires C | N | QuoteInput | 201 `{quote:Quote,guestToken?}` | B,404 fuel,409 station/tariff |
| POST | `/api/orders` | G/C, C needs `orders.create`, owns quote | N | CreateOrder | 201 new / 200 replay `{order:CreatedOrder,replayed,guestAccessToken?}` | B,404,409 |
| GET | `/api/orders/mine` | C, `orders.read`, own userId | CustomerHistory | — | 200 `{orders:CustomerOrder[],pagination}` | B |
| GET | `/api/orders/:orderId` | C/`orders.read`/own or guest order capability | N | — | 200 `{order:CustomerOrder}` | B,404 |
| GET | `/api/orders/:orderId/events` | same customer/guest scope | N | — | 200 `{orderId,status,events:CustomerEvent[]}` | B,404 |
| POST | `/api/orders/:orderId/cancel` | C/`orders.cancel`/own or guest order capability | N | empty/`{}` | 200 `{order:CustomerOrder,replayed}` | B,404,409 |
| GET | `/api/manager/stations/:stationId/orders` | M, `orders.read`, owned station | ManagerOrders | — | 200 `{dataSource:"database",stationId,orders:ManagerOrder[],pagination}` | B,404 |
| GET | `/api/manager/stations/:stationId/orders/:orderId` | M, `orders.read`, owned station/order | N | — | 200 `{dataSource:"database",stationId,order:ManagerDetail}` | B,404 |
| POST | `/api/manager/stations/:stationId/orders/:orderId/confirm-cash` | M, `payments.manage`, owned station/order | N | `{amountMinor:number,currency:USD or LBP,pumpId:number}` | 201 new / 200 replay `{dataSource:"database",stationId,order:CashOrder,payment:CashPayment,replayed}` | B,404,409 |
| GET | `/api/manager/stations/:stationId/attendance` | M, `attendance.read`, owned station | ManagerAttendance | — | 200 `{attendance:Attendance[],pagination}` | B,404 |
| GET | `/api/manager/stations/:stationId/attendance/export` | M, `attendance.read`, owned station | Export | — | 200 CSV or PDF bytes | B,404,422 |
| GET | `/api/manager/stations/:stationId/analytics` | M, all `reports.read`,`attendance.read`,`orders.read`; owned station | Analytics | — | 200 AnalyticsResult | B,404 |
<!-- endpoints:end -->

## Exact query and body definitions

Every query group below is strict; parameters are optional unless marked required.
All paginated groups include page/limit with the defaults/maxima above.

| Query group | Parameters | Fixed ordering / matching |
| --- | --- | --- |
| Users | page,limit,search (trim 1–128),role (existing role),stationId,isActive (`true`/`false`) | id asc; search name/email case-insensitive |
| Stations | page,limit,search (trim 1–128),isActive (`true`/`false`) | name asc,id asc; search name/address case-insensitive |
| ReferenceHistory | page,limit,fuel (`gasoline_95`/`diesel`),from,to (date-only) | effectiveAt desc,lastSeenAt desc,id desc; inclusive dates |
| SellingHistory | page,limit,fuelTypeId,currency (`USD`/`LBP`) | effectiveAt desc,id desc |
| SellingCurrent | required fuelTypeId,currency | latest effectiveAt <= server now, then id desc |
| WorkRecords | page,limit,stationId,employeeId,from,to (timestamps) | shift startsAt / attendance clockInAt asc,id asc; interval overlap |
| EmployeeWeek | required weekStart (`YYYY-MM-DD`, valid Monday),page,limit | Asia/Beirut calendar week; overlap; startsAt asc,id asc |
| PendingQueue | page,limit,status (only PENDING, default PENDING) | createdAt asc,id asc; assignedEmployeeId null |
| MyWork | page,limit,status (only IN_PROGRESS, default IN_PROGRESS) | createdAt asc,id asc; caller assignedEmployeeId |
| CustomerHistory | page,limit,status (known order status) | createdAt desc,id desc |
| ManagerOrders | page,limit,from,to,status,minAmountMinor,maxAmountMinor | createdAt desc,id desc; creation time; inclusive amount bounds |
| ManagerAttendance | page,limit,employeeId,from,to | clockInAt asc,id asc; interval overlap; no station override |
| Export | required format (`csv`/`pdf`),employeeId,from,to | clockInAt asc,id asc; no page/limit/station override |
| Analytics | from,to | no list pagination; attendance overlap / order creation time |

Manager amount filters are nonnegative int32 decimal strings; minimum must not
exceed maximum. No currency filter exists: manager lists can include mixed/legacy
currencies and must not be summed as one monetary unit. Public picker and managed
discovery sort name/id ascending; fuel types sort code/id ascending; pumps sort
number/id ascending. All are unpaginated.

| Body name | Exact accepted keys |
| --- | --- |
| Register | required name (trim 1–128),email (trim/lowercase, valid, max254),password (12–72 characters, max72 UTF-8 bytes; uppercase/lowercase/digit/non-alphanumeric) |
| Login | required email,password (nonempty,max72 UTF-8 bytes; existing passwords need not meet registration complexity) |
| CreateUser | Register + required role, optional stationId number/null; CUSTOMER provisioning/transitions unsupported |
| UpdateUser | nonempty subset of name,role,stationId number/null; no email/password/isActive/permissions fields |
| CreateStation | required name (trim 1–128),address (trim 1–512),optional paired latitude/longitude numbers or both null; ranges ±90/±180 |
| UpdateStation | nonempty subset name,address,latitude,longitude; merged coordinate pair must remain both present or both null; address cannot be cleared |
| SellingPriceInput | required fuelTypeId,currency,unitPrice decimal string,effectiveAt explicit-offset timestamp |
| QuoteInput | required stationId,fuelTypeId,currency,fulfillmentType (`IN_STATION`/`PICKUP`),inputMode (`AMOUNT`/`LITERS`),value decimal string |
| CreateOrder | required quoteId UUID,idempotencyKey UUID; optional guestToken (64 hex),customerName (trim1–128),customerPhone (trim1–32, allowed + digits spaces parentheses hyphen, at least one digit) |

STAFF assignment rules: EMPLOYEE/SECURITY require a station; ADMIN/HR cannot have
one; MANAGER affiliation may be null and is not ownership. New station assignments
must be active and within the actor's scope. Managers/HR create EMPLOYEE only.
Transfer requires an active destination and no open attendance, ongoing/future
source shifts or active claimed orders. Claimed orders also block relevant role,
affiliation and deactivation changes. Employee role exit requires checkout.
Assigned managers require explicit ownership unassignment before deactivation or
role exit. The final active ADMIN cannot be removed. CUSTOMER name-only edits are
supported by ADMIN; customer role/station transitions are rejected.

## Response DTO field sets

Notation: `?` below means conditionally omitted; `null` is a returned JSON value.
Collections are always arrays; there is no universal `data` envelope.

- AuthUser: id,name,email,role,stationId(number/null),permissions(string[]).
- ManagedUser: id,name,email,role,stationId,isActive,createdAt,updatedAt. No
  permissions field: this describes another managed account, not an auth session.
- PickerStation: id,name,address(string/null),latitude(number/null),longitude(number/null).
  Station adds isActive,managerId(number/null),createdAt. Legacy null addresses
  remain readable; deviceKeyHash is never exposed.
- SellingPrice: id,fuelTypeId,currency,unitPriceMinor,effectiveAt,createdAt,
  unitPrice (formatted decimal string),unit (`LITER`). No creator record.
- ReferencePrice: id,provider,market,fuelCode,price,providerFuelCode,providerPrice,
  providerUnit,conversionDivisor,currency,unit,effectiveAt,fetchedAt,lastSeenAt,
  seriesKey,providerSeriesId,kind,interval,freshness,ageDays,stale. Prices are
  decimal strings/null; effectiveAt is date-only/null; selected legacy metadata
  can be null. Current returns latest per provider/market/fuel/series/currency/unit;
  empty means `prices:[]`, not manufactured zero prices. Metadata includes
  provider=`oilapi`,market=`LB`,purpose=`external_reference`,feedDelay.
  Refresh adds fetchedAt,nextAllowedAt,quotes to metadata plus inserted/skipped.
- Shift: id,employeeId,stationId,startsAt,endsAt,createdAt,employee,station.
  Attendance: id,employeeId,stationId,clockInAt,clockOutAt(null if open),createdAt,
  employee,station. Nested employee/station: id,name,isActive. Historical records
  retain their recorded station regardless of current affiliation/activity.
- SelfRecord: id,employeeId,stationId,clockInAt,clockOutAt,station{id,name,isActive}.
  AttendanceCurrent: state (`CHECKED_IN`/`CHECKED_OUT`),openRecord(SelfRecord/null),
  assignedStation({id,name,isActive}/null),canCheckIn,canCheckOut.
- QueueOrder: id,status,createdAt,orderedVolume(decimal string),pump({id,number}/null),
  fuelType({id,name,code}). WorkOrder adds stationId,assignedEmployeeId,claimedAt,
  updatedAt. EmployeeDetail adds events[{id,actorUserId,actorType,fromStatus,toStatus,createdAt}].
- ManagerOrder: WorkOrder + source,currency,fulfillmentType,unitPriceMinor,
  orderedAmountMinor,dispensedVolume,finalMinor,scheduledFor,expiresAt,
  assignee({id,name,isActive}/null). ManagerDetail adds events with the employee
  event fields **plus note**. No customer name/phone, quote secrets or payment rows.
- Quote: id(UUID),stationId,fuelTypeId,sellingPriceId,fulfillmentType,currency,
  unitPriceMinor,unitPrice,quantity(fixed three-decimal string),totalMinor,total,
  inputMode,requestedValue,expiresAt. Guest responses additionally include
  top-level guestToken; customer responses omit it.
- CreatedOrder: id,quoteId,stationId,fuelTypeId,currency,fulfillmentType,source,
  status,pumpId,unitPriceMinor,orderedVolume,orderedAmountMinor,createdAt.
  Guest placement/replay includes guestAccessToken; customer placement omits it.
- CustomerOrder: id,status,currency,fulfillmentType,orderedAmountMinor,orderedVolume,
  createdAt,updatedAt,claimedAt,scheduledFor,station{id,name,address},
  fuelType{id,name,code},pump({id,number}/null). CustomerEvent: id,fromStatus,toStatus,createdAt.
  No staff actor IDs, notes, payments or contact details.
- CashOrder: id,stationId,status,pumpId,currency,orderedAmountMinor,assignedEmployeeId,
  claimedAt. CashPayment: id,orderId,method(`CASH`),currency,amountMinor,capturedMinor,
  status(`CONFIRMED`),confirmedById,confirmedAt. No provider secrets.
- AnalyticsResult: stationId,attendance{totalRecords,openRecords,closedRecords},
  orders{dataSource:"database",totalOrders,countsByStatus}. Known order statuses
  always have counts (including zero); stored legacy statuses are preserved too.
  **No currency, revenue, or completedOrderedAmountMinor field.**

## End-to-end examples and state transitions

### Authentication and administration

Register or login → use returned user/permissions → `/auth/me` to restore session →
`/auth/refresh` when needed → replace UI identity from its response → logout.
Serialize refresh attempts per browser session: only one concurrent consumer of
the current refresh hash succeeds. Old refresh replay is 401. Access expiry is
401, missing grants/role is 403. Auth POST limits per IP/15min: register10,login20,
refresh60; the whole customer-orders router has limit100, including reads.

ADMIN lists/creates stations, optionally edits details/status, then assigns an
active MANAGER with `{ "managerId": 21 }`. Ownership is 0/1 each way; moving a
manager requires explicit `{ "managerId": null }` on the previous station.
Same eligible assignment is a no-op. Inactive stations may receive managers but
stay inactive. Deactivation preserves ownership and rejects IN_PROGRESS or
confirmed-positive-paid PENDING work; unpaid legacy PENDING does not block this
station-status operation even though it reserves its pump.

Staff management uses `/users` and the role/assignment rules above. Fuel types
come from `/fuel-types`; ADMIN configures append-only global selling tariffs:

```http
POST /api/fuel-prices/selling
Content-Type: application/json
X-CSRF-Protection: 1

{"fuelTypeId":2,"currency":"USD","unitPrice":"1.99","effectiveAt":"2026-11-23T00:00:00Z"}
```

```json
{"price":{"id":8,"fuelTypeId":2,"currency":"USD","unitPriceMinor":199,"effectiveAt":"2026-11-23T00:00:00.000Z","createdAt":"2026-11-23T00:00:00.000Z","unitPrice":"1.99","unit":"LITER"}}
```

Fuel catalog presence does not imply an effective tariff. Reference-price refresh
is optional ADMIN provider work, not a prerequisite for checkout pricing. It has
a cross-process one-hour cooldown; provider/network errors are not price zero.

### Guest/customer quote and placement

1. GET `/stations/picker` → selected numeric stationId; GET `/fuel-types` → numeric
   fuelTypeId. There is no public pump-selection endpoint or per-station fuel list.
2. POST `/orders/quotes` with the strict input below. Guest IN_STATION is supported;
   PICKUP requires logged-in CUSTOMER. A staff cookie is rejected, not downgraded.

```json
{"stationId":10,"fuelTypeId":2,"currency":"USD","fulfillmentType":"IN_STATION","inputMode":"LITERS","value":"1.250"}
```

```json
{"quote":{"id":"11111111-1111-4111-8111-111111111111","stationId":10,"fuelTypeId":2,"sellingPriceId":8,"fulfillmentType":"IN_STATION","currency":"USD","unitPriceMinor":199,"unitPrice":"1.99","quantity":"1.250","totalMinor":249,"total":"2.49","inputMode":"LITERS","requestedValue":"1.250","expiresAt":"2026-11-23T12:10:00.000Z"},"guestToken":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
```

3. POST `/orders` with `{quoteId,idempotencyKey,guestToken}` for a guest. Generate
   the UUID idempotencyKey once per intended order and retain it for transport
   retries. CUSTOMER omits guestToken. Optional customerName/customerPhone may be
   sent here; clients never submit authoritative price, total, station or pump.

```json
{"quoteId":"11111111-1111-4111-8111-111111111111","idempotencyKey":"22222222-2222-4222-8222-222222222222","guestToken":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
```

```json
{"order":{"id":42,"quoteId":"11111111-1111-4111-8111-111111111111","stationId":10,"fuelTypeId":2,"currency":"USD","fulfillmentType":"IN_STATION","source":"GUEST","status":"AWAITING_PAYMENT","pumpId":null,"unitPriceMinor":199,"orderedVolume":"1.25","orderedAmountMinor":249,"createdAt":"2026-11-23T12:01:00.000Z"},"replayed":false,"guestAccessToken":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
```

4. Read `/orders/42` or `/orders/42/events`; a guest supplies
   `X-Order-Access-Token: <guestAccessToken>`, never guestToken. CUSTOMER uses its
   cookie with orders.read and ownership. Guest secrets are bearer credentials;
   protect them and never place them in query strings/logs. No guest history-list
   endpoint exists; CUSTOMER uses `/orders/mine`.
5. POST `/orders/42/cancel` with `{}` plus the same guest capability (or CUSTOMER
   orders.cancel). Only unpaid, unassigned, pump-free AWAITING_PAYMENT is cancellable.
   Repeating supported cancellation returns 200/replayed true. Paid/claimed/
   completed cancellation is 409; there are no refund or arbitrary status APIs.

Quote validity is ten minutes; a valid quote pins its tariff. New placement checks
station activity and expiry. Successful placement replay is allowed after expiry
or deactivation, but still checks identity and the exact normalized request.
Reusing a key for another request or consuming a quote with another key is 409.
Unpaid orders are not automatically expired just because expiresAt is old.

### Manager and employee fulfillment

Manager GET `/stations/managed` (zero/one result) → owned station orders/detail →
GET `/stations/10/pumps`. An available pump is exact IDLE with no PENDING or
IN_PROGRESS order; unknown status is unavailable. Inactive lookup returns 409.
Availability is a snapshot and never reserves anything.

POST `/manager/stations/10/orders/42/confirm-cash` with
`{"amountMinor":249,"currency":"USD","pumpId":7}`. A new success is 201 with
`replayed:false`, CashOrder status PENDING and CashPayment status CONFIRMED.
Exact retry is 200/replayed true, including after fulfillment/deactivation;
changed amount/currency/pump is a conflict. The manager must still own the station.

```json
{"dataSource":"database","stationId":10,"order":{"id":42,"stationId":10,"status":"PENDING","pumpId":7,"currency":"USD","orderedAmountMinor":249,"assignedEmployeeId":null,"claimedAt":null},"payment":{"id":9,"orderId":42,"method":"CASH","currency":"USD","amountMinor":249,"capturedMinor":249,"status":"CONFIRMED","confirmedById":21,"confirmedAt":"2026-11-23T12:02:00.000Z"},"replayed":false}
```

```text
AWAITING_PAYMENT --cash + IDLE free pump--> PENDING
PENDING --employee claim--> IN_PROGRESS --assignee complete--> COMPLETED
AWAITING_PAYMENT --authorized unpaid cancellation--> CANCELLED
```

PENDING/IN_PROGRESS reserve the pump, even if legacy payment data is missing.
Cash confirmation, claiming and completion are transactions; the unique active
pump index is the final reservation boundary. Completion does not reset an
operational pump status or calculate actual dispensed volumes/revenue.

Employee restores profile/affiliation → GET `/employee/shifts?weekStart=2026-11-23`
→ GET `/employee/attendance/current` → check in with a new UUID requestId when
canCheckIn → GET `/employee/orders` → POST `/:id/claim` → GET `/mine` → POST
`/:id/complete` → check out own attendance record. All employee order paths in
this sequence have `/api/employee/orders` prefix. No attendance prerequisite is
enforced by order claiming. Same-station employees may read safe order detail;
only the assignee completes it. Claim/complete retries acknowledge the same
employee's prior transition; competing claims/status changes return 409.
A delayed claim replay after completion returns the completed order rather than
moving it back to IN_PROGRESS.

Check-in returns 200 for creation and replay. Retry the **same** requestId to
resolve a lost response; another request while already open is 409.
Check-in replay resolves the original employee/request record even if it has
already closed or the employee's affiliation subsequently changed. Checkout is
200/idempotent and remains possible after station deactivation or affiliation
change, provided the caller remains an active EMPLOYEE and owns the record.
Weekly shifts use Monday-to-Monday **Asia/Beirut local midnights**, independently
converted to UTC for DST; they are not always 168 hours or the employee's current
station only. Read history is not hidden by inactive recorded stations.

Manager attendance/analytics/export calls use their separate grants. Inactive
owned stations retain historical manager read/export access; pump lookup, new
checkout work and employee order operations reject inactive stations.

## File exports and error handling

GET `/manager/stations/10/attendance/export?format=csv&from=2026-11-01T00:00:00Z`
returns `text/csv; charset=utf-8`, attachment
`station-10-attendance.csv`, CRLF rows and headers
`Station,Employee,Clock-in (UTC),Clock-out (UTC)`; open clock-out is an empty cell.
PDF uses `application/pdf` and `station-10-attendance.pdf`. Responses are bytes,
not JSON, and no-store. Maximum 5000 rows; larger selection returns JSON 422.
Unsupported PDF glyphs/layout limits also return 422; supported CSV can be requested
explicitly. Check response.ok/content-type before calling blob/text vs JSON.
Current CORS does not expose Content-Disposition cross-origin; do not assume
JavaScript can read every attachment header. There is no order/payment export API.

Normal errors: `{ "message": "..." }`. Invalid parsed inputs → 400 `Invalid request`;
missing/invalid auth → 401; role/permission/CSRF → 403; scoped missing resources
→ 404; business/idempotency/concurrency conflicts → 409; exports → 422; throttling
→ 429. Unexpected failures → 500 `Internal Server Error`. Reference pricing's
explicit safe provider errors retain messages with 502/503/504; readiness has the
special 503 body in inventory. Do not parse message text into an authorization
decision. Auth/order rate limit middleware emits standard rate headers; provider
cooldown 429 does not promise the same Retry-After contract.

Unknown methods/paths have no general 405 contract. Router middleware can return
401/403 before the final 404 `{message:"Route not found: ..."}`. Cache/no-store
coverage also depends on where middleware rejected the request; do not promise
it for every globally rejected request. The app does not return structured field
validation details or a universal success/data envelope.

## Audit findings and readiness matrix

Confirmed documentation mismatches (no production behavior change needed):

| Finding | Implementation evidence | Resolution |
| --- | --- | --- |
| Manager docs describe demo source, synthetic IDs, ascending selection and limited fields | `../apps/api/src/modules/orders/orders.service.ts` ordersService; `../apps/api/src/modules/orders/orders.repository.ts` managerOrdersRepository/managerOrderSelect | Replace manager-orders doc with current persisted contract; newest-first numeric database IDs |
| Analytics docs claim demo orders, currency and completedOrderedAmountMinor | `../apps/api/src/modules/analytics/analytics.service.ts` analyticsService.station; analytics.repository.ts groupBy | Replace analytics doc with exact database counts; no monetary aggregate |
| Early employee/global attendance docs describe later implemented modules as absent | employee-attendance.md opening/scope; employee-order-work.md opening; attendance.md historical scope | Add current-guide precedence notices; keep stage evidence identified as history |
| Unknown query handling is not uniform | auth.controller.ts; users.controller.ts; stations.controller.ts; orders.routes.ts; fuel-prices.routes.ts | Inventory distinguishes I/N/strict groups; focused HTTP checks preserve actual behavior |
| Inactive behavior differs by operation | stations.service.ts pumps/setStatus; accessScope.ts requireManagedStation; orders.service.ts assignedEmployee/activeStation | Preserve historical reads vs new-work conflicts; no invented uniform rule |
| Numeric IDs, decimal strings and date-only pricing differ from earlier demo assumptions | query.validation.ts; orders.pricing.ts; fuel-prices.types.ts; attendance.validation.ts | Explicit types, units, range/ordering and DTO field sets above |
| Reference pricing lacked Jest HTTP-boundary coverage despite existing provider/repository tests | `../apps/api/tests/unit/fuel-prices.repository.test.ts`; `../apps/api/tests/unit/oilapi.provider.test.ts` | Added current/history empty envelopes, explicit safe refresh503 and manager denial checks in api-contract-inventory.test.ts; no provider calls |

Source anchors for review (repository-relative paths and current line numbers):

- [Persisted manager envelope](../apps/api/src/modules/orders/orders.service.ts#L37),
  [manager fields](../apps/api/src/modules/orders/orders.repository.ts#L244),
  [newest-first sorting](../apps/api/src/modules/orders/orders.repository.ts#L283).
- [Actual analytics projection](../apps/api/src/modules/analytics/analytics.service.ts#L24).
- [Strict pump/list queries vs unparsed station detail](../apps/api/src/modules/stations/stations.controller.ts#L14),
  [auth response handlers](../apps/api/src/modules/auth/auth.controller.ts#L45).
- [Pump inactive-station conflict](../apps/api/src/modules/stations/stations.service.ts#L17),
  [historical ownership lookup without an activity predicate](../apps/api/src/utils/accessScope.ts#L7).
- [Timestamp/int32 validators](../apps/api/src/utils/query.validation.ts#L3),
  [checkout arithmetic](../apps/api/src/modules/orders/orders.pricing.ts#L9),
  [date-only reference mapper](../apps/api/src/modules/fuel-prices/fuel-prices.types.ts#L28).
- [Explicit export headers](../apps/api/src/modules/attendance/attendance.controller.ts#L24)
  and [CORS header configuration](../apps/api/src/app.ts#L33).

No breaking contract change or production fix is made in Task 07. Known integration
limits: no shift CRUD/scheduling, order scheduling input, public per-station fuel inventory, pump CRUD,
manager reassignment of claimed orders, card processing, refunds, generic status
mutation, permission administration, or public selling-price endpoint. Use quotes
for checkout totals. Do not invent client-side permissions, locks or these APIs.

All endpoint families are documented and covered by HTTP tests with mocked Prisma;
these are not database proofs. Prior retained acceptance evidence is distinguished
below. No live database or fixture-writing acceptance was used for Task 07.
Existing Jest safety tests spawn verifier CLIs only with deliberately invalid or
missing targets and confirm refusal before database imports; no Stage 9 scenarios run.

| Backend module | Explicit endpoints | Authorization coverage | Contract docs | Automated coverage | PostgreSQL evidence | Frontend readiness | Known blockers / conditions |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Health | 2 | public | this guide | health HTTP | readiness stub in Jest | READY WITH CONDITIONS | readiness only proves SELECT 1, not business migrations/data |
| Authentication | 5 | cookie/version/current grants | this guide + authentication.md | auth/token/lifecycle | existing historical rollout; Task06 mapper mocked HTTP | READY WITH CONDITIONS | deploy secrets/origins and role grants; same-site cookies |
| Users | 6 | ADMIN/MANAGER/HR scope | this guide + user-management.md | users HTTP | prior attendance/lifecycle; Task08 transfer/status/role vs claim races passed | READY WITH CONDITIONS | account configuration, historical data and active-work guards |
| Stations / ownership / pumps | 9 | public picker, ADMIN grants, owning manager | this guide + station-management.md | stations/pumps/cash HTTP | Task03/03.5 ownership and Task05.5 pump acceptance passed | READY WITH CONDITIONS | deploy current schema/grants; pump availability is a snapshot |
| Fuel types | 1 | public catalog | this guide + fuel-prices.md | fuel-type + identifier-flow HTTP | no new constraint; DB not needed for mapper tests | READY | catalog presence does not imply tariff/inventory |
| Reference / selling pricing | 6 | ADMIN-only + pricing grants | this guide + fuel-prices.md | provider/repository unit; reference/selling HTTP | historical reference precision; Task08 selling/quote/checkout acceptance passed | READY WITH CONDITIONS | provider configuration/quota; deployed selling tariff setup |
| Shifts / attendance / exports | 8 | ADMIN/HR, self EMPLOYEE, owned MANAGER | this guide + domain docs | read/write/report/weekly HTTP | prior attendance role races passed; Task03 scope acceptance | READY WITH CONDITIONS | read-only scheduling API; export row/font limits |
| Employee orders | 5 | active assigned station, own completion | this guide + employee-order-work.md | queue/work/cash HTTP | Task08 full flow, claims/completion/rollback/eligibility races passed | READY | local integration verified; requires current active affiliation and grants |
| Guest/customer orders | 6 | current customer or guest capability | this guide | creation/tracking/cancellation HTTP | Task08 full quote/create/tracking/cancel/idempotency/authorization acceptance passed | READY | guest capability handling and documented cancellation limits still apply |
| Manager orders / cash | 3 | current ownership + orders.read/payments.manage | this guide + manager-orders.md | orders/cash/ownership HTTP | Task03 ownership; Task08 full flow, concurrent confirmation and rollback passed | READY | availability snapshot and current ownership/grants still apply |
| Manager analytics | 1 | ownership + all three grants | this guide + manager-analytics.md | analytics HTTP | Task03 scoped reads passed; aggregate contract mocked | READY WITH CONDITIONS | counts only; no revenue/currency totals |
| Entire backend | 52 | enforced server-side | this guide authoritative | route inventory + domain tests | full guarded local order acceptance passed in Task08; other evidence as above | READY WITH CONDITIONS | production configuration, primary compatibility, deployment/CORS/secrets and operations remain unverified |

The route-inventory test compares this table with actual mounted Express routers,
including loop-generated routes and mounts, so additions/removals require a guide
update. It supplements, rather than duplicates, existing field/auth/state tests.

## Task 07 verification snapshot

All checks passed on 2026-11-23: final contract suite 12 checks (one complete
mounted-inventory comparison and eleven HTTP checks), broader targeted run
11 suites / 630 tests, and final full run 36 suites / 1,221 tests (zero failures
or skips). The broader targeted run preceded four added reference-price checks;
the final contract and full runs include those additions. Typecheck, ESLint,
backend build and whitespace checks passed. An initial inventory-helper failure
used deprecated app.router; it was corrected to this repository's Express 4
app._router. No application defect or production-code change resulted.

Full Jest evidence: OS temporary directory `m7atati-task07-full.json`. No database
connection, migration, reset, fixture writes or live-provider calls were used.
These results establish application contracts with mocked persistence, not full
PostgreSQL order acceptance. Stage9 was still a blocker at Task07; the Task08
acceptance below supersedes that historical limitation.

## Task 08: observed Stage 9 root cause and PostgreSQL acceptance

On 2026-11-23, the approved fresh database
`m7atati_employee_orders_verify_stage9_task08` was confirmed absent and created
from template0 on local PostgreSQL 18.6, localhost:5432 (connection ::1), public
schema. All 13 reviewed migrations applied, checksum/history/constraint checks
passed, and the final read-only inspection found 13 successful/0 failed
migrations, zero duplicate active pump reservations, zero active orders missing
pumps and zero duplicate confirmed cash payments. Primary and earlier retained
verification databases were not connected to, migrated or modified. No .env file
was edited. All Task08 fixtures, including failed-run fixtures, remain retained.

### Reproduction and correction

Two simultaneous identical cash confirmations reproduced responses [500,201]
instead of [200,201]. Exact captured request:
`POST /api/manager/stations/3/orders/4/confirm-cash`, HTTP500 body
`{"message":"Internal Server Error"}`. The first reproduction used station1/order1;
the second added lock-level evidence on station3/order4. Fixture IDs are local
evidence, not API constants or permission tokens.

Trace: manager route → authenticate/current grants → payments.manage →
ordersController.confirmCash → cashOrdersService.confirm →
cashOrdersRepository.transaction → employeeOrdersRepository.writeTransaction →
cashOrdersRepository.lockOrder → raw SELECT orders FOR UPDATE.

PostgreSQL rejected the stale Serializable lock snapshot with SQLSTATE 40001.
The pg adapter wrapped it as PrismaClientKnownRequestError P2010,
driver kind TransactionWriteConflict. The transaction wrapper retried P2034 only,
so the otherwise expected serialization retry became an unhandled HTTP500.
This is a production transaction-error classification defect, affecting real
concurrent cash confirmation retries, not only verifier fixtures.

The minimal fix retries P2010 **only** when the direct or adapter-nested SQLSTATE
is 40001, using the existing maximum three transaction attempts. A new transaction
rechecks current identity, ownership and the committed payment, returning the
existing exact confirmation with HTTP 200/replayed true. The winner commits 201.
No unrelated SQLSTATE, cash rule, reservation/index, permission or HTTP contract
was broadened. Exhaustion remains 409. Regression tests reproduced the 500 before
the fix and pass afterward; division-by-zero 22012 and permission-denied 42501 raw
errors remain unretried 500 responses.

After that fix, a separate verifier defect surfaced: the event-FK rollback test
patched the root Prisma delegate rather than the interactive transaction's
delegate. Its intended failure never executed and cash correctly returned201.
Fault injection now wraps the actual transaction delegate, asserts it executed,
and restores the hook in finally. Real event-FK failures yielded P2003/23503 for
cash, cancellation and completion, with409 and unchanged order/payment/event
snapshots. Assertions were preserved and strengthened, not relaxed.

The pg concurrent-query deprecation warning is non-fatal under the inspected
runtime flags. It remained present during the successful complete run; the
observed HTTP500 was40001 retry classification, not the warning itself. No pg
dependency or unrelated query scheduling change was made.

### Complete guarded run results

Every following scenario actually executed successfully after both corrections:

| Scenario label | Observed result |
| --- | --- |
| additive Customer orders.cancel provisioning and idempotency | PASS |
| selling prices, quotes, precision and creation idempotency | PASS |
| cash activation, fulfillment, history, authorization and replay | PASS; duplicate cash [201,200], one payment and four lifecycle events after completion |
| database CHECK constraints reject invalid prices, quote identity and null active pumps | PASS |
| guest tracking, unpaid cancellation and isolation | PASS |
| real concurrent pump reservations and database unique enforcement | PASS |
| real cancellation/payment races in both lock orders | PASS |
| actual event FK failures roll back payment, reservation and cancellation | PASS; cash/cancel/complete each P2003/23503 and preserved snapshots |
| Task 02 station deactivation versus creation, cash and paid claims in both lock orders | PASS |
| competing claims, unique events, duplicate actions, eligibility conflicts, completion and cross-station isolation | PASS (appended consistency runner) |
| real event insertion failures roll back both claim and completion | PASS (appended runner) |
| transfer, deactivation and role change versus claim, in both lock orders | PASS (appended runner) |
| station deactivation versus claim in both lock orders, completion release, reactivation and repeated status row no-ops | PASS (appended runner) |
| final preflight and all Stage 2–8 PostgreSQL verification phases | PASS, exit0; zero integrity conflicts |

Commands from repository root, with the private confirmed disposable URL supplied
only through child-process environment, exact ORDERS_VERIFY_CONFIRM_DATABASE and
ALLOW_ORDERS_VERIFY_MUTATIONS=yes for migration/verification:

```powershell
node --import tsx apps/api/scripts/verify-orders-postgres.ts --preflight
node --import tsx apps/api/scripts/verify-orders-postgres.ts --migrate
node --import tsx apps/api/scripts/verify-orders-postgres.ts --verify
```

Creation used `CREATE DATABASE "m7atati_employee_orders_verify_stage9_task08" WITH TEMPLATE template0`
after maintenance-catalog absence/template checks. No reset, db push, deletion,
automatic fixture repair or migration resolution occurred. The guard's --verify
also runs the existing employee-order consistency verifier on this same target.
The global readiness conditions above remain: local acceptance is not production
deployment, secret provisioning, CORS validation, external-provider availability
or primary-data compatibility certification.

Final regression: three targeted suites / 201 tests passed; all 36 backend suites /
1,226 tests passed, zero failures/skips. Typecheck, ESLint, build and whitespace
checks passed. Five added regression cases cover both adapter serialization-error
shapes, exhausted retries with record preservation, and unrelated SQLSTATEs that
must not retry. Before the production fix, the serialization cases failed with
HTTP500 as expected (three failing checks), while the two unrelated-error checks
already passed.

Sanitized local evidence in the OS temporary directory:
`m7atati-task08-reproduction.log` (500/201 and lock/SQLSTATE evidence),
`m7atati-task08-postgres-after-fix.log` (original phase passes; root-delegate
fault-injection defect exposed), `m7atati-task08-postgres-harness-fix.log` (complete
guarded acceptance exit0), and `m7atati-task08-full.json` (final Jest results).
No tokens, cookies, passwords or connection strings are logged by these verifier
diagnostics. Nothing was staged or committed.

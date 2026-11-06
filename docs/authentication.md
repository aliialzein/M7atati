# Authentication and authorization

The API uses HTTP-only JWT cookies. No tokens are returned in JSON or stored in
localStorage. Existing liveness (`GET /api/health`) and readiness
(`GET /api/health/ready`) remain public.

## Configuration

Configure `apps/api/.env`, or supply these variables through the deployment's
secret manager:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Existing PostgreSQL connection URL |
| `JWT_ACCESS_SECRET` | 32 random bytes encoded as exactly 64 hexadecimal characters |
| `JWT_REFRESH_SECRET` | A different independently generated 32-byte hexadecimal secret |
| `JWT_ISSUER` | Defaults to `m7atati-api` |
| `JWT_AUDIENCE` | Defaults to `m7atati-web` |
| `ALLOWED_ORIGINS` | Comma-separated exact origins; required in production, HTTPS only |
| `NODE_ENV` | `development`, `test`, or `production` |
| `PORT` | Defaults to `4000` |

Generate **each** secret independently with:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Never commit the resulting secrets. The validator rejects missing, short,
obviously repetitive, or equal keys; configuration validation cannot establish
how randomly a supplied key was generated. Production secrets have no fallback.
Changing a secret invalidates JWTs signed with its previous value.

Development origins default to `http://localhost:3000,http://localhost:4000`,
matching the current frontend/API configuration. Include every trusted browser
origin, including the API origin if it serves a browser client itself. Origins
must contain no credentials, paths, or trailing slash. There is no wildcard.

## HTTP contract

All responses from `/api/auth` use `Cache-Control: no-store`.

| Endpoint | Request | Success |
| --- | --- | --- |
| `POST /api/auth/register` | JSON `name`, `email`, `password` | 201, `{ "user": ... }` and both cookies |
| `POST /api/auth/login` | JSON `email`, `password` | 200, `{ "user": ... }` and both cookies |
| `POST /api/auth/refresh` | Refresh cookie | 200, `{ "user": ... }` and rotated cookies |
| `POST /api/auth/logout` | Refresh cookie if present | 204, both cookies cleared |
| `GET /api/auth/me` | Access cookie | 200, `{ "user": ... }` |

The safe user object contains `id`, `name`, `email`, `role` (role name), and
`stationId`. JSON responses never contain passwords, hashes, or JWTs.

Email is trimmed and lowercased on registration and login. Future staff
provisioning must use the same normalization. Public registration accepts only
the three documented fields and always connects the seeded CUSTOMER role;
role/station fields are rejected. Passwords require at least 12 characters,
uppercase and lowercase letters, a digit, and a non-alphanumeric character.
They may contain at most 72 UTF-8 bytes because bcrypt truncates beyond that
boundary. Passwords are hashed with bcrypt cost 12. Login validates the input
size without imposing a new password policy on existing staff credentials.
Unknown users take a dummy bcrypt verification path. Unknown, incorrect, and
disabled-account login attempts all receive `401 { "message": "Invalid credentials" }`.

Other errors use `{ "message": "..." }`: invalid input 400, unauthenticated 401,
insufficient permission or invalid CSRF proof 403, duplicate email 409, rate
limit 429, and sanitized unexpected errors 500. Duplicate checks rely on the
database unique constraint, including concurrent registrations. User creation
and the initial session insert share a Prisma transaction.

## Browser integration and CSRF

Current deployment assumes frontend and API are **same-site**, including local
development on different localhost ports. Both cookies are host-only,
`HttpOnly`, `SameSite=Lax`, and `Secure` in production. The access cookie
`m7atati_access` has path `/api` and lifetime 15 minutes. The refresh cookie
`m7atati_refresh` has path `/api/auth` and lifetime seven days, covering refresh
and logout. Logout clears cookies using matching paths and security options.

Every state-changing request under `/api`, including public registration/login
and logout, must send an exact allowed `Origin` plus
`X-CSRF-Protection: 1`. Requests missing either are rejected. This custom-header
defense relies on browsers preventing forms from supplying the header and
enforcing CORS preflight for cross-origin JavaScript. The server also validates
Origin independently of CORS. SameSite is additional protection. Non-browser
clients must explicitly supply these headers as well. Safe GET/HEAD/OPTIONS
requests are exempt and must never perform business state changes.

The client must opt into cookies, for example:

```ts
await fetch(`${apiUrl}/api/auth/login`, {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json', 'X-CSRF-Protection': '1' },
  body: JSON.stringify({ email, password }),
});
```

Browsers set Origin automatically. Do not reflect arbitrary origins into
`ALLOWED_ORIGINS`. CORS permits credentials only for configured origins.
A future cross-site deployment needs a deliberate cookie and CSRF review;
changing SameSite alone is insufficient. XSS in a trusted origin can still
perform authenticated actions, so maintain frontend XSS defenses.

This approach follows OWASP's
[custom-header and origin-validation guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).

## Tokens and session lifecycle

JWTs use HS256 with separate decoded 32-byte keys. Verification restricts the
algorithm and checks signature, issuer, audience, expiration, issued-at age,
subject format, and token type. Subjects are decimal strings representing
positive PostgreSQL integer user IDs. Refresh tokens also contain a UUID session
ID in `jti` and a fresh random UUID nonce. No roles or personal details are in
JWT claims. Nonces prevent identical tokens within a single issuance second.

Only SHA-256 refresh-token hashes are persisted. Refresh checks the signed
token, session owner, hash, revocation, expiry, and current active user. An
atomic `updateMany` compares the current hash, user, active status, expiry, and
revocation before replacing the hash and recording `lastUsedAt`. Only one
concurrent consumer can succeed. The replacement token renews the session's
seven-day lifetime. A consumed token cannot create a session or rotate again.
The client should serialize refresh attempts; a concurrent loser receives 401
and no replacement cookies, so it cannot erase the winner's new cookies.

No schema changes are needed. Old hashes are not retained, so the system rejects
reuse but does not classify it as theft or revoke an entire session family on
reuse. Expired/revoked row cleanup and absolute session lifetime policies can be
added later without being required for correctness here.

Logout verifies a refresh token when present and revokes its identifiable
session, including when that token was consumed by a prior rotation. Invalid,
expired, missing, and already-revoked cookies are safe to clear repeatedly.
Database revocation failures return 500 while still clearing browser cookies.
Logout does **not** revoke an already-issued access JWT: it can remain valid for
up to 15 minutes. Authentication still rejects disabled/deleted users immediately
because each protected request loads the current database user and role.

## Authorization and future services

Use `authenticate` before `authorize('orders.create')`. Authentication reads the
access cookie, verifies it, loads the current user/role/permission relationships,
and attaches typed `req.auth`. Authorization uses those database permissions;
ADMIN has no blanket bypass and depends on the seeded assignments. Missing
authentication is 401; lacking permission is 403. Middleware never refreshes JWTs.

Permissions grant a capability, not access to every record. Future services must
also scope database queries to `req.auth.user.id` for customer ownership and
check authorized station membership/management for staff. `stationId` is useful
context, not a substitute for checking current station authorization. Never
trust a customer-supplied owner or station identifier. Walk-in orders can retain
`userId = null`; no order or station behavior is implemented in this phase.

## Operational limitations and verification

Registration, login, and refresh are limited independently to 10, 20, and 60
requests per IP per 15 minutes. The in-memory stores reset on restart, do not
coordinate between instances, and can group users behind shared NAT. Before
scaling, use a shared rate-limit store and review account-level abuse controls.
Express proxy trust remains disabled; configure only known proxies when a
deployment requires it, otherwise forwarded IP headers permit bypasses. With
trust disabled behind a proxy, clients may share the proxy's rate limit.

Jest/Supertest tests mock database operations and use explicit test-only keys.
The concurrent refresh test synchronizes reads and models an atomic conditional
update; it does not replace a PostgreSQL concurrency/load test. Routine CI
requires no database. Account provisioning, password recovery, email
verification, MFA, order ownership, and station modules remain outside this phase.

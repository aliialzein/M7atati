# SmartStation / Ma7atati

SmartStation is a React interface for the Ma7atati Express API and PostgreSQL database.

- [frontend/](frontend/) contains the Vite application and the browser API client.
- [Frontend architecture](frontend/README.md) maps the routes, feature components, and shared code.
- [backend/](backend/) contains the API workspace, Prisma schema, migrations, and API tests.
- [Backend API contract](backend/docs/frontend-api-guide.md) documents the HTTP endpoints and authorization rules.

## Run locally

Use Node.js 24 or later and PostgreSQL. Create a development database first, then configure `backend/apps/api/.env` using the supplied example. Set `DATABASE_URL`, generate separate JWT secrets with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`, and allow your exact frontend origin in `ALLOWED_ORIGINS`.

```sh
npm ci --prefix backend
npm ci --prefix frontend
npm --prefix backend run db:migrate
npm --prefix backend run db:seed
npm run dev
```

The seed sets up the default roles and permission assignments. Run it for a new development database. To create the initial administrator, set `ADMIN_NAME`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` in the terminal environment and run `npm --prefix backend run create-admin`. Remove the password from the environment afterward.

The web dashboard has two roles. The General CEO uses the backend administrator account to view every branch and its orders and analytics. A Station Manager sees the station assigned to the account. Customer and employee order operations remain available through the Ma7atati API.

Open [SmartStation](http://127.0.0.1:5173). The Vite proxy forwards `/api` to `http://127.0.0.1:4000`. Run `npm run dev:frontend` and `npm run dev:backend` in separate terminals if needed.

## Set up a station

1. Sign in as an administrator, create a station, create a manager and employee, then assign the manager on the station page.
2. For a local development database, run `npm --prefix backend run provision-local-catalog -- 1` with the new station ID to provision gasoline, diesel, and pumps 1 and 2. Existing pump state is preserved.
3. Publish an effective selling tariff under **Fuel prices**. Customer and guest clients place orders through the API. The station manager confirms cash and assigns an available pump. Employee clients claim and complete orders through the API.
4. Managers can view and export attendance and check branch analytics. The CEO can open orders and analytics for any branch from the dashboard.

The optional reference pricing provider uses a server-side `OILAPI_API_KEY`. Checkout uses the selling tariffs stored in PostgreSQL.

## Build and deployment

```sh
npm run build
npm test
```

Serve `frontend/dist` with SPA fallback and forward `/api` to the backend. Start the compiled API with `npm --prefix backend start`. Keep the frontend and API same-site and use HTTPS in production. Set the permitted frontend origins explicitly and keep the PostgreSQL and JWT credentials on the API host.

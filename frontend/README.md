# SmartStation frontend

The React application uses Vite, React Router, and the Ma7atati HTTP API. See the [project README](../README.md) for PostgreSQL setup and commands to run both applications.

## Source layout

| Directory         | Responsibility                                                      |
| ----------------- | ------------------------------------------------------------------- |
| `src/app/`        | Route registration and role-aware navigation                        |
| `src/pages/`      | One React component per route, grouped by domain                    |
| `src/features/`   | Forms, account/session state, and components shared within a domain |
| `src/api/`        | HTTP client, cookie-session refresh, and request hooks              |
| `src/components/` | Dashboard shell and reusable UI primitives                          |
| `src/styles/`     | Shared layout, tokens, and responsive styles                        |
| `src/lib/`        | Formatting and file-download helpers                                |
| `tests/`          | Session refresh and dashboard-role regression tests                 |

Auth styles are colocated with the shared auth form. Dashboard pages share form, table, card, and layout styles. For a new screen, place its page component under its domain in `src/pages/`, register the route in `src/app/App.jsx`, and define its navigation and access rules in `src/app/access.js`. The backend enforces authorization for every protected API call.

## Routes

| Route                                | Page                                                |
| ------------------------------------ | --------------------------------------------------- |
| `/`                                  | CEO and station manager sign in                     |
| `/home`, `/profile`                  | Role-specific dashboard and account details         |
| `/orders`, `/orders/:id`             | Branch order list and order detail                  |
| `/attendance`, `/shifts`, `/reports` | Attendance, CEO shift records, and branch analytics |
| `/people`, `/stations`, `/fuel`      | Staff, stations, and fuel tariffs                   |

## Frontend checks

The General CEO maps to the backend `ADMIN` role and can choose any branch. The Station Manager maps to `MANAGER` and is always scoped to the station returned by `/api/stations/managed`. The backend checks station ownership and permissions on every protected request.

```sh
npm ci
npm test
npm run build
```

Local requests go through Vite's `/api` proxy to the Express server. Git-tracked environment examples contain configuration names and safe defaults. Set private credentials on the backend.

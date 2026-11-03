# Smart Fuel Stations Monitoring & Management System

This repository contains the initial frontend and backend foundation for the Smart
Fuel Stations Monitoring & Management System. Business features are intentionally
out of scope at this stage.

## Stack

- Node.js + Express + TypeScript for the API foundation
- Next.js + React + TypeScript for the web foundation
- npm workspaces for monorepo management
- A minimal shared package

## Getting started

```bash
npm install
Copy-Item apps\api\.env.example apps\api\.env
Copy-Item apps\web\.env.example apps\web\.env.local
npm run dev
```

`npm run dev` starts the API and web app in parallel. The API listens on port 4000
by default; the web app is available at http://localhost:3000. The web app checks
`GET /api/health` using `NEXT_PUBLIC_API_URL`.

## Checks

```bash
npm run lint
npm run build
npm run test
npm run format:check
```

Backend integration tests use Jest and Supertest. Frontend unit tests use Jest,
jsdom, and React Testing Library. Selenium E2E tests are kept in `apps/web/e2e`.

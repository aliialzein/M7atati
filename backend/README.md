# Ma7atati API

The API runs on Express, TypeScript, Prisma, and PostgreSQL. The React application is in the sibling `frontend/` directory.

From this directory, use `npm ci`, then configure `apps/api/.env` from the example. Use `npm run db:migrate` and `npm run db:seed` to initialize a fresh development database. Start the API with `npm run dev` or build it and run `npm start`.

- [Full-stack setup](../README.md)
- [HTTP contracts, roles, and permissions](docs/frontend-api-guide.md)
- [Backend script inventory](docs/api-scripts-audit.md)

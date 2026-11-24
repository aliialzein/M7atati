
import dotenv from "dotenv";
import { defineConfig, env } from "prisma/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const configDir = dirname(fileURLToPath(import.meta.url));

dotenv.config({
  path: resolve(configDir, ".env"),
});


export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
  path: "prisma/migrations",
  seed: "tsx apps/api/prisma/seed.ts",
},
  datasource: {
    url: env("DATABASE_URL"),
  },
});

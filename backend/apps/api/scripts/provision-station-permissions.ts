import { HttpError } from '../src/types/http-error.js';
import dotenv from 'dotenv';
import { resolve } from 'node:path';

async function main(): Promise<void> {
  let disconnect: (() => Promise<void>) | undefined;
  try {
    // This database-only command does not require authentication signing keys.
    dotenv.config({
      path: [resolve('apps/api/.env'), resolve('.env')],
      quiet: true,
    });
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('Database configuration missing');
    const { PrismaPg } = await import('@prisma/adapter-pg');
    const { PrismaClient } = await import('../src/generated/prisma/client.js');
    const prisma = new PrismaClient({
      adapter: new PrismaPg({
        connectionString,
        connectionTimeoutMillis: 5000,
        query_timeout: 5000,
      }),
      log: [],
    });
    disconnect = () => prisma.$disconnect();
    const { provisionStationPermissions } =
      await import('./station-permissions.js');
    await provisionStationPermissions(prisma);
    console.info('Station permissions provisioned for ADMIN');
  } catch (error) {
    console.error(
      error instanceof HttpError
        ? error.message
        : 'Station permission provisioning failed; check configuration and database availability',
    );
    process.exitCode = 1;
  } finally {
    try {
      await disconnect?.();
    } catch {
      console.error(
        'Failed to disconnect after station permission provisioning',
      );
      process.exitCode = 1;
    }
  }
}
void main();

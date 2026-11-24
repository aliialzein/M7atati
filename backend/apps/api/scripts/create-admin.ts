import { ZodError } from 'zod';

import { HttpError } from '../src/types/http-error.js';

async function main(): Promise<void> {
  let disconnect: (() => Promise<void>) | undefined;
  try {
    // Config loads the workspace .env. Failures stay inside this sanitized handler.
    const { prisma } = await import('../src/database/prisma.js');
    disconnect = () => prisma.$disconnect();
    const { provisionInitialAdmin } = await import('./admin-provisioning.js');
    const credentials = {
      name: process.env.ADMIN_NAME,
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
    };
    delete process.env.ADMIN_PASSWORD;
    await provisionInitialAdmin(credentials);
    console.info('Initial administrator created successfully');
  } catch (error) {
    console.error(
      error instanceof ZodError
        ? 'Invalid administrator credentials'
        : error instanceof HttpError
          ? error.message
          : 'Administrator provisioning failed; check configuration and database availability',
    );
    process.exitCode = 1;
  } finally {
    try {
      await disconnect?.();
    } catch {
      console.error('Failed to disconnect after administrator provisioning');
      process.exitCode = 1;
    }
  }
}

void main();

import type { Server } from 'node:http';

import { logger } from './utils/logger.js';

let server: Server | undefined;
let prisma: (typeof import('./database/prisma.js'))['prisma'] | undefined;
let shuttingDown = false;

async function shutdown(exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exitCode = exitCode;
  const timeout = setTimeout(() => {
    logger.error('Graceful shutdown timed out');
    process.exit(1);
  }, 10000);
  timeout.unref();

  try {
    const httpServer = server;
    if (httpServer?.listening) {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  } catch {
    logger.error('Failed to close the HTTP server');
    process.exitCode = 1;
  }
  try {
    await prisma?.$disconnect();
  } catch {
    logger.error('Failed to disconnect from the database');
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
  }
}

async function start(): Promise<void> {
  let stage = 'environment validation';
  try {
    // Catch configuration failures without printing sensitive driver errors.
    const { env } = await import('./config/env.js');
    stage = 'database initialization';
    ({ prisma } = await import('./database/prisma.js'));
    await prisma.$connect();
    await prisma.$queryRaw`SELECT 1`;
    logger.info('Database connection initialized');
    stage = 'HTTP server initialization';
    const { app } = await import('./app.js');
    const httpServer = app.listen(env.port);
    server = httpServer;
    await new Promise<void>((resolve, reject) => {
      httpServer.once('listening', resolve);
      httpServer.once('error', reject);
    });
    logger.info(`API is running on http://localhost:${env.port}`);
    process.on('SIGINT', () => {
      void shutdown();
    });
    process.on('SIGTERM', () => {
      void shutdown();
    });
  } catch {
    logger.error(`API startup failed during ${stage}`);
    await shutdown(1);
  }
}

void start();

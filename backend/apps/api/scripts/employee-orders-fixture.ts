import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import {
  createEmployeeOrderFixtures,
  employeeOrdersTestUrl,
} from './employee-orders-fixtures.js';

async function main() {
  const target = employeeOrdersTestUrl();
  if (process.argv.includes('--probe')) {
    // Each probe is a new API process with a real listening HTTP server. It does
    // no fixture writes, allowing restart/persistence checks in a separate runner.
    process.env.DATABASE_URL = target;
    process.env.NODE_ENV = 'test';
    process.env.JWT_ACCESS_SECRET = randomBytes(32).toString('hex');
    process.env.JWT_REFRESH_SECRET = randomBytes(32).toString('hex');
    const id = Number(
      process.argv
        .find((value) => value.startsWith('--employee='))
        ?.split('=')[1],
    );
    assert(Number.isSafeInteger(id) && id > 0);
    const { app } = await import('../src/app.js');
    const { logger } = await import('../src/utils/logger.js');
    logger.silent = true;
    const { env } = await import('../src/config/env.js');
    const { prisma } = await import('../src/database/prisma.js');
    const { tokenService } =
      await import('../src/modules/auth/token.service.js');
    const { ACCESS_COOKIE } = await import('../src/modules/auth/auth.types.js');
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
      const address = server.address();
      assert(address && typeof address !== 'string');
      if (process.argv.includes('--race')) {
        const order = Number(
          process.argv
            .find((value) => value.startsWith('--order='))
            ?.split('=')[1],
        );
        const second = Number(
          process.argv
            .find((value) => value.startsWith('--second='))
            ?.split('=')[1],
        );
        assert(
          Number.isSafeInteger(order) &&
            order > 0 &&
            Number.isSafeInteger(second) &&
            second > 0 &&
            second !== id,
        );
        const claim = async (employee: number) => {
          const response = await fetch(
            `http://127.0.0.1:${address.port}/api/employee/orders/${order}/claim`,
            {
              method: 'POST',
              headers: {
                Cookie: `${ACCESS_COOKIE}=${tokenService.issue(employee).accessToken}`,
                'X-CSRF-Protection': '1',
                Origin: env.allowedOrigins[0],
              },
            },
          );
          return { employee, status: response.status };
        };
        process.stdout.write(
          JSON.stringify(await Promise.all([claim(id), claim(second)])),
        );
        return;
      }
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/employee/orders`,
        {
          headers: {
            Cookie: `${ACCESS_COOKIE}=${tokenService.issue(id).accessToken}`,
          },
        },
      );
      assert.equal(response.status, 200);
      process.stdout.write(JSON.stringify(await response.json()));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await prisma.$disconnect();
    }
    return;
  }
  const { registerSchema } =
    await import('../src/modules/auth/auth.validation.js');
  const password = registerSchema.shape.password.parse(
    process.env.EMPLOYEE_ORDER_FIXTURE_PASSWORD,
  );
  const { passwordService } =
    await import('../src/modules/auth/password.service.js');
  const passwordHash = await passwordService.hash(password);
  const database = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: target,
      connectionTimeoutMillis: 5000,
      query_timeout: 10000,
    }),
    log: [],
  });
  try {
    const identity = await database.$queryRaw<
      { name: string }[]
    >`SELECT current_database() AS name`;
    assert.equal(
      identity[0].name,
      decodeURIComponent(new URL(target).pathname.slice(1)),
    );
    console.info(
      JSON.stringify(
        await createEmployeeOrderFixtures(database, passwordHash),
        null,
        2,
      ),
    );
  } finally {
    await database.$disconnect();
  }
}
main().catch(() => {
  console.error(
    'Disposable queue fixture/probe failed or is not configured; development DATABASE_URL is never used',
  );
  process.exitCode = 1;
});

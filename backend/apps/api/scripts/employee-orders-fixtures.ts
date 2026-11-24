import assert from 'node:assert/strict';
import type { PrismaClient } from '../src/generated/prisma/client.js';

export function employeeOrdersTestUrl(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const target = environment.EMPLOYEE_ORDERS_TEST_DATABASE_URL;
  assert(
    target,
    'Set EMPLOYEE_ORDERS_TEST_DATABASE_URL explicitly; there is no development fallback',
  );
  assert.equal(
    environment.ALLOW_EMPLOYEE_ORDER_FIXTURES,
    'yes',
    'Explicit disposable fixture authorization required',
  );
  const url = new URL(target);
  assert(['postgres:', 'postgresql:'].includes(url.protocol));
  assert(
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
    'Local disposable database required',
  );
  assert(
    /^m7atati_employee_orders_verify_[a-z0-9_]+$/.test(
      decodeURIComponent(url.pathname.slice(1)),
    ),
    'Disposable database name required',
  );
  assert(
    !url.searchParams.has('schema') ||
      url.searchParams.get('schema') === 'public',
  );
  return target;
}

// Explicit fixture use only. Callers must validate the disposable target first.
export async function createEmployeeOrderFixtures(
  database: PrismaClient,
  passwordHash: string,
) {
  return database.$transaction(
    async (tx) => {
      // Serialize repeated/concurrent runs of this fixture without schema changes.
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(73190211)`;
      const role = await tx.role.upsert({
        where: { name: 'EMPLOYEE' },
        update: {},
        create: { name: 'EMPLOYEE' },
      });
      for (const key of ['orders.read', 'orders.update']) {
        const permission = await tx.permission.upsert({
          where: { key },
          update: {},
          create: {
            key,
            description:
              key === 'orders.read' ? 'View orders' : 'Update orders',
          },
        });
        await tx.rolePermission.upsert({
          where: {
            roleId_permissionId: {
              roleId: role.id,
              permissionId: permission.id,
            },
          },
          update: {},
          create: { roleId: role.id, permissionId: permission.id },
        });
      }
      const fuel = await tx.fuelType.upsert({
        where: { code: 'EMPLOYEE_QUEUE_TEST' },
        update: {},
        create: {
          code: 'EMPLOYEE_QUEUE_TEST',
          name: 'Disposable queue test fuel',
        },
      });
      const result = [];
      for (const label of ['A', 'B']) {
        const name = `Employee queue fixture ${label}`;
        const address = 'EMPLOYEE_QUEUE_FIXTURE_V1';
        const stations = await tx.station.findMany({
          where: { name, address },
        });
        assert(
          stations.length <= 1,
          'Duplicate fixture stations require review',
        );
        const station =
          stations[0] ?? (await tx.station.create({ data: { name, address } }));
        assert(
          station.isActive,
          'Fixture station is inactive; use a fresh disposable database',
        );
        const pump = await tx.pump.upsert({
          where: { stationId_number: { stationId: station.id, number: 1 } },
          update: {},
          create: { stationId: station.id, number: 1, status: 'IDLE' },
        });
        assert.equal(pump.stationId, station.id);
        const source = `EMPLOYEE_QUEUE_FIXTURE_V1_${label}`;
        const orders = await tx.fuelOrder.findMany({
          where: { stationId: station.id, source },
        });
        assert(orders.length <= 1, 'Duplicate fixture orders require review');
        let order = orders[0];
        if (!order) {
          order = await tx.fuelOrder.create({
            data: {
              stationId: station.id,
              pumpId: pump.id,
              fuelTypeId: fuel.id,
              source,
              status: 'PENDING',
              unitPriceMinor: 100,
              orderedAmountMinor: 2500,
              orderedVolume: '25.000',
            },
          });
          await tx.orderEvent.create({
            data: {
              orderId: order.id,
              actorType: 'SYSTEM',
              fromStatus: null,
              toStatus: 'PENDING',
              note: 'Explicit disposable queue fixture',
            },
          });
        }
        assert.equal(
          order.pumpId,
          pump.id,
          'Fixture pump was changed; use a fresh disposable database',
        );
        assert.equal(
          await tx.orderEvent.count({
            where: { orderId: order.id, fromStatus: null, toStatus: 'PENDING' },
          }),
          1,
          'Fixture initial event requires review',
        );
        const employees = [];
        for (const suffix of label === 'A' ? ['1', '2'] : ['1']) {
          const email = `queue-${label.toLowerCase()}${suffix}@employee-fixture.invalid`;
          const person = await tx.user.upsert({
            where: { email },
            update: {},
            create: {
              email,
              name: `Queue employee ${label}${suffix}`,
              passwordHash,
              roleId: role.id,
              stationId: station.id,
            },
          });
          assert(
            person.isActive &&
              person.roleId === role.id &&
              person.stationId === station.id,
            'Fixture employee assignment/status changed; use a fresh disposable database',
          );
          employees.push({ id: person.id, email });
        }
        result.push({
          stationId: station.id,
          orderId: order.id,
          status: order.status,
          employees,
        });
      }
      return result;
    },
    { timeout: 10000 },
  );
}

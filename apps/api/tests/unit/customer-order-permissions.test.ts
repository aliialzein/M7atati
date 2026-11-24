import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { provisionCustomerOrderCancellation } from '../../scripts/customer-order-permissions.js';

it('provisions only Customer orders.cancel, preserving unrelated grants and replaying safely', async () => {
  const grants = new Set(['7:80']);
  const tx = {
    role: { findUnique: jest.fn(async () => ({ id: 2 })) },
    permission: { upsert: jest.fn(async () => ({ id: 10 })) },
    rolePermission: {
      upsert: jest.fn(
        async ({
          create,
        }: {
          create: { roleId: number; permissionId: number };
        }) => {
          grants.add(`${create.roleId}:${create.permissionId}`);
        },
      ),
    },
  };
  const database = {
    $transaction: async (work: (client: typeof tx) => Promise<void>) =>
      work(tx),
  };
  await provisionCustomerOrderCancellation(database as unknown as PrismaClient);
  await provisionCustomerOrderCancellation(database as unknown as PrismaClient);
  expect([...grants].sort()).toEqual(['2:10', '7:80']);
  expect(tx.role.findUnique).toHaveBeenCalledWith({
    where: { name: 'CUSTOMER' },
    select: { id: true },
  });
  expect(tx.permission.upsert).toHaveBeenCalledWith(
    expect.objectContaining({ where: { key: 'orders.cancel' }, update: {} }),
  );
});
it('does not create roles or grant permissions if the Customer role is absent', async () => {
  const upsert = jest.fn();
  const tx = { role: { findUnique: async () => null }, permission: { upsert } };
  const database = {
    $transaction: async (work: (client: typeof tx) => Promise<void>) =>
      work(tx),
  };
  await expect(
    provisionCustomerOrderCancellation(database as unknown as PrismaClient),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect(upsert).not.toHaveBeenCalled();
});

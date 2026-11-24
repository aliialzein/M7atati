import type { PrismaClient } from '../src/generated/prisma/client.js';
import { HttpError } from '../src/types/http-error.js';

// Add this one capability, preserving every existing role and permission link.
// Callers select the database explicitly; this helper does not validate targets.
export async function provisionCustomerOrderCancellation(
  database: PrismaClient,
) {
  await database.$transaction(async (tx) => {
    const role = await tx.role.findUnique({
      where: { name: 'CUSTOMER' },
      select: { id: true },
    });
    if (!role) throw new HttpError('CUSTOMER role is not configured', 409);
    const permission = await tx.permission.upsert({
      where: { key: 'orders.cancel' },
      update: {},
      create: { key: 'orders.cancel', description: 'Cancel orders' },
      select: { id: true },
    });
    await tx.rolePermission.upsert({
      where: {
        roleId_permissionId: { roleId: role.id, permissionId: permission.id },
      },
      update: {},
      create: { roleId: role.id, permissionId: permission.id },
    });
  });
}

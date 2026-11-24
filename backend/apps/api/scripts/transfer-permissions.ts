import type { PrismaClient } from '../src/generated/prisma/client.js';
import { HttpError } from '../src/types/http-error.js';

// Explicit provisioning only; never replace or remove existing grants.
export async function provisionTransferPermissions(database: PrismaClient) {
  await database.$transaction(async (tx) => {
    const roles = [];
    for (const name of ['ADMIN', 'HR']) {
      const role = await tx.role.findUnique({
        where: { name },
        select: { id: true },
      });
      if (!role)
        throw new HttpError(`Seeded ${name} role is not configured`, 409);
      roles.push(role);
    }
    const permission = await tx.permission.upsert({
      where: { key: 'employees.transfer' },
      update: {},
      create: {
        key: 'employees.transfer',
        description: 'Transfer employees between stations',
      },
      select: { id: true },
    });
    for (const role of roles)
      await tx.rolePermission.upsert({
        where: {
          roleId_permissionId: { roleId: role.id, permissionId: permission.id },
        },
        update: {},
        create: { roleId: role.id, permissionId: permission.id },
      });
  });
}

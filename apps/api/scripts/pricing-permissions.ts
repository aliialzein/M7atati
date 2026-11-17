import type { PrismaClient } from '../src/generated/prisma/client.js';
import { HttpError } from '../src/types/http-error.js';

export const pricingPermissionDefinitions = [
  { key: 'pricing.read', description: 'View reference fuel prices' },
  { key: 'pricing.update', description: 'Refresh reference fuel prices' },
];

// Explicit CLI use only. No seed, deletion, user writes, or unrelated grants.
export async function provisionPricingPermissions(database: PrismaClient) {
  await database.$transaction(async (tx) => {
    const admin = await tx.role.findUnique({
      where: { name: 'ADMIN' },
      select: { id: true },
    });
    if (!admin) throw new HttpError('Seeded ADMIN role is not configured', 409);
    for (const definition of pricingPermissionDefinitions) {
      const permission = await tx.permission.upsert({
        where: { key: definition.key },
        update: {},
        create: definition,
        select: { id: true },
      });
      await tx.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: admin.id,
            permissionId: permission.id,
          },
        },
        update: {},
        create: { roleId: admin.id, permissionId: permission.id },
      });
    }
  });
}

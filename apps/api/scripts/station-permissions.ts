import type { PrismaClient } from '../src/generated/prisma/client.js';
import { HttpError } from '../src/types/http-error.js';

export const stationPermissionDefinitions = [
  { key: 'stations.read', description: 'View stations' },
  { key: 'stations.create', description: 'Create stations' },
  { key: 'stations.update', description: 'Update station details and status' },
];

// Explicit CLI use only. No seed, deletion, user writes, or unrelated grants.
export async function provisionStationPermissions(database: PrismaClient) {
  await database.$transaction(async (tx) => {
    const admin = await tx.role.findUnique({
      where: { name: 'ADMIN' },
      select: { id: true },
    });
    if (!admin) throw new HttpError('Seeded ADMIN role is not configured', 409);
    for (const definition of stationPermissionDefinitions) {
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

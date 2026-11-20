import type { PrismaClient } from '../src/generated/prisma/client.js';
import { HttpError } from '../src/types/http-error.js';

export const attendancePermissionDefinitions = [
  { key: 'attendance.read', description: 'View attendance records' },
  { key: 'shifts.read', description: 'View scheduled shifts' },
];

// Explicit provisioning only. Preserve every unrelated permission and grant.
export async function provisionAttendancePermissions(database: PrismaClient) {
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
    for (const definition of attendancePermissionDefinitions) {
      const permission = await tx.permission.upsert({
        where: { key: definition.key },
        update: {},
        create: definition,
        select: { id: true },
      });
      for (const role of roles)
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
  });
}

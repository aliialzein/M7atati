import type { PrismaClient } from '../src/generated/prisma/client.js';
import { HttpError } from '../src/types/http-error.js';

// Explicit deployment only; no import/startup side effects or replaced grants.
export async function provisionEmployeeAttendancePermissions(
  database: PrismaClient,
) {
  await database.$transaction(async (tx) => {
    const role = await tx.role.findUnique({
      where: { name: 'EMPLOYEE' },
      select: { id: true },
    });
    if (!role)
      throw new HttpError('Seeded EMPLOYEE role is not configured', 409);
    const permission = await tx.permission.upsert({
      where: { key: 'attendance.self.write' },
      update: {},
      create: {
        key: 'attendance.self.write',
        description: 'Check in and out of own attendance',
      },
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

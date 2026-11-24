import type { PrismaClient } from '../src/generated/prisma/client.js';
import { HttpError } from '../src/types/http-error.js';

// Add only the EMPLOYEE link; never replace HR/Admin or unrelated grants.
export async function provisionEmployeeShiftPermissions(
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
      where: { key: 'shifts.read' },
      update: {},
      create: { key: 'shifts.read', description: 'View scheduled shifts' },
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

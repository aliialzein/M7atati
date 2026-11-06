
import dotenv from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = dirname(fileURLToPath(import.meta.url));

dotenv.config({
  path: resolve(currentDir, '../.env'),
});

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not configured.');
}

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

const roleDefinitions = [
  { name: 'ADMIN', description: 'System administrator' },
  { name: 'MANAGER', description: 'Station manager' },
  { name: 'EMPLOYEE', description: 'Station employee' },
  { name: 'HR', description: 'Human resources staff' },
  { name: 'SECURITY', description: 'Station security staff' },
  { name: 'CUSTOMER', description: 'Website customer' },
];

const permissionDefinitions = [
  { key: 'users.read', description: 'View users' },
  { key: 'users.create', description: 'Create users' },
  { key: 'users.update', description: 'Update users' },

  { key: 'devices.read', description: 'View registered devices' },
  { key: 'devices.manage', description: 'Manage registered devices' },

  { key: 'attendance.read', description: 'View attendance records' },
  { key: 'attendance.manage', description: 'Manage attendance records' },

  { key: 'orders.read', description: 'View orders' },
  { key: 'orders.create', description: 'Create orders' },
  { key: 'orders.update', description: 'Update orders' },
  { key: 'orders.cancel', description: 'Cancel orders' },

  { key: 'pricing.read', description: 'View fuel prices' },
  { key: 'pricing.update', description: 'Update fuel prices' },

  { key: 'payments.read', description: 'View payments' },
  { key: 'payments.manage', description: 'Manage payments' },

  { key: 'inventory.read', description: 'View fuel inventory' },
  { key: 'inventory.update', description: 'Update fuel inventory' },

  { key: 'safety.read', description: 'View safety alerts' },
  { key: 'safety.manage', description: 'Manage safety alerts' },

  { key: 'traffic.read', description: 'View traffic analytics' },

  { key: 'reports.read', description: 'View system reports' },
];

const rolePermissions: Record<string, string[]> = {
  ADMIN: permissionDefinitions.map(({ key }) => key),

  MANAGER: [
    'users.read',
    'users.create',
    'users.update',
    'devices.read',
    'devices.manage',
    'orders.read',
    'orders.create',
    'orders.update',
    'orders.cancel',
    'pricing.read',
    'pricing.update',
    'payments.read',
    'payments.manage',
    'inventory.read',
    'inventory.update',
    'safety.read',
    'safety.manage',
    'traffic.read',
    'reports.read',
  ],

  EMPLOYEE: [
    'attendance.read',
    'orders.read',
    'orders.create',
    'orders.update',
    'pricing.read',
    'inventory.read',
  ],

  HR: [
    'users.read',
    'users.create',
    'users.update',
    'attendance.read',
    'attendance.manage',
  ],

  SECURITY: [
    'devices.read',
    'safety.read',
    'safety.manage',
    'traffic.read',
  ],

  CUSTOMER: [
    'orders.read',
    'orders.create',
  ],
};

async function main() {
  const roleIds = new Map<string, number>();
  const permissionIds = new Map<string, number>();

  // Create or update roles.
  for (const role of roleDefinitions) {
    const record = await prisma.role.upsert({
      where: { name: role.name },
      update: { description: role.description },
      create: role,
    });

    roleIds.set(record.name, record.id);
  }

  // Create or update permissions.
  for (const permission of permissionDefinitions) {
    const record = await prisma.permission.upsert({
      where: { key: permission.key },
      update: { description: permission.description },
      create: permission,
    });

    permissionIds.set(record.key, record.id);
  }

  // Build the role-permission relationships.
  const assignments = Object.entries(rolePermissions).flatMap(
    ([roleName, permissionKeys]) => {
      const roleId = roleIds.get(roleName);

      if (!roleId) {
        throw new Error(`Role not found: ${roleName}`);
      }

      return permissionKeys.map((permissionKey) => {
        const permissionId = permissionIds.get(permissionKey);

        if (!permissionId) {
          throw new Error(`Permission not found: ${permissionKey}`);
        }

        return { roleId, permissionId };
      });
    },
  );

  // Replace existing assignments with the seed's definitions.
  await prisma.$transaction(async (tx) => {
    await tx.rolePermission.deleteMany();

    await tx.rolePermission.createMany({
      data: assignments,
    });
  });

  console.log('Roles seeded:', roleDefinitions.length);
  console.log('Permissions seeded:', permissionDefinitions.length);
  console.log('Role-permission assignments:', assignments.length);
}

main()
  .catch((error: unknown) => {
    console.error('Database seeding failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

import { prisma } from '../../src/database/prisma.js';
import { provisionAttendancePermissions } from '../../scripts/attendance-permissions.js';

jest.mock('../../src/database/prisma.js', () => ({
  prisma: {
    $transaction: jest.fn(),
    role: { findUnique: jest.fn() },
    permission: { upsert: jest.fn() },
    rolePermission: { upsert: jest.fn() },
  },
}));
const db = prisma as unknown as {
  $transaction: jest.Mock;
  role: { findUnique: jest.Mock };
  permission: { upsert: jest.Mock };
  rolePermission: { upsert: jest.Mock };
};
beforeEach(() => {
  jest.resetAllMocks();
  db.$transaction.mockImplementation(
    async (work: (tx: typeof db) => Promise<void>) => work(db),
  );
  db.role.findUnique.mockImplementation(
    async ({ where }: { where: { name: string } }) => ({
      id: where.name === 'ADMIN' ? 7 : 8,
    }),
  );
});
it('does not provision on import', () => {
  expect(db.$transaction).not.toHaveBeenCalled();
});
it('idempotently reuses attendance.read and adds only HR/ADMIN read grants', async () => {
  const permissions = new Map([
    ['users.read', 1],
    ['attendance.read', 2],
  ]);
  const links = new Set(['2:1', '3:2']); // Unrelated manager and EMPLOYEE grants.
  db.permission.upsert.mockImplementation(
    async ({ where, update }: { where: { key: string }; update: object }) => {
      expect(update).toEqual({});
      if (!permissions.has(where.key))
        permissions.set(where.key, permissions.size + 1);
      return { id: permissions.get(where.key) };
    },
  );
  db.rolePermission.upsert.mockImplementation(
    async ({
      create,
      update,
    }: {
      create: { roleId: number; permissionId: number };
      update: object;
    }) => {
      expect(update).toEqual({});
      links.add(`${create.roleId}:${create.permissionId}`);
    },
  );
  await provisionAttendancePermissions(prisma);
  await provisionAttendancePermissions(prisma);
  expect([...permissions.keys()]).toEqual([
    'users.read',
    'attendance.read',
    'shifts.read',
  ]);
  expect([...links]).toEqual(['2:1', '3:2', '7:2', '8:2', '7:3', '8:3']);
});
it.each(['ADMIN', 'HR'])(
  'requires configured %s before any permission writes',
  async (missingRole) => {
    db.role.findUnique.mockImplementation(
      async ({ where }: { where: { name: string } }) =>
        where.name === missingRole ? null : { id: 7 },
    );
    await expect(provisionAttendancePermissions(prisma)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(db.permission.upsert).not.toHaveBeenCalled();
    expect(db.rolePermission.upsert).not.toHaveBeenCalled();
  },
);

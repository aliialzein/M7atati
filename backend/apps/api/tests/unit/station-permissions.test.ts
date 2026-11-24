import { prisma } from '../../src/database/prisma.js';
import { provisionStationPermissions } from '../../scripts/station-permissions.js';

jest.mock('../../src/database/prisma.js', () => ({
  prisma: {
    $transaction: jest.fn(),
    role: { findUnique: jest.fn() },
    permission: { upsert: jest.fn() },
    rolePermission: { upsert: jest.fn() },
  },
}));
type Database = {
  $transaction: jest.Mock;
  role: { findUnique: jest.Mock };
  permission: { upsert: jest.Mock };
  rolePermission: { upsert: jest.Mock };
};
const db = prisma as unknown as Database;
beforeEach(() => {
  jest.resetAllMocks();
  db.$transaction.mockImplementation(
    async (work: (tx: Database) => Promise<void>) => work(db),
  );
  db.role.findUnique.mockResolvedValue({ id: 7 });
});
it('does not provision on import', () => {
  expect(db.$transaction).not.toHaveBeenCalled();
});
it('idempotently adds only station permissions and ADMIN links, preserving unrelated grants', async () => {
  const permissions = new Map<string, number>([['users.read', 1]]);
  const links = new Set(['2:1']);
  db.permission.upsert.mockImplementation(
    async ({
      where,
      create,
      update,
    }: {
      where: { key: string };
      create: { key: string };
      update: object;
    }) => {
      expect(Object.keys(update)).toHaveLength(0);
      expect(create.key).toBe(where.key);
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
      expect(create.roleId).toBe(7);
      expect(Object.keys(update)).toHaveLength(0);
      links.add(`${create.roleId}:${create.permissionId}`);
    },
  );
  await provisionStationPermissions(prisma);
  await provisionStationPermissions(prisma);
  expect([...permissions.keys()]).toEqual([
    'users.read',
    'stations.read',
    'stations.create',
    'stations.update',
  ]);
  expect([...links]).toEqual(['2:1', '7:2', '7:3', '7:4']);
  expect(db.role.findUnique).toHaveBeenCalledWith({
    where: { name: 'ADMIN' },
    select: { id: true },
  });
});
it('requires an existing ADMIN role and writes nothing when it is absent', async () => {
  db.role.findUnique.mockResolvedValue(null);
  await expect(provisionStationPermissions(prisma)).rejects.toMatchObject({
    statusCode: 409,
  });
  expect(db.permission.upsert).not.toHaveBeenCalled();
  expect(db.rolePermission.upsert).not.toHaveBeenCalled();
});

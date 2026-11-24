import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { provisionEmployeeShiftPermissions } from '../../scripts/employee-shift-permissions.js';

const db = {
  $transaction: jest.fn(),
  role: { findUnique: jest.fn() },
  permission: { upsert: jest.fn() },
  rolePermission: { upsert: jest.fn() },
};
beforeEach(() => {
  jest.resetAllMocks();
  db.$transaction.mockImplementation((work: (tx: typeof db) => Promise<void>) =>
    work(db),
  );
});
it('does not provision on import', () => {
  expect(db.$transaction).not.toHaveBeenCalled();
});
it('reuses shifts.read and adds only the employee link, preserving HR/Admin and unrelated grants', async () => {
  const links = new Set(['1:7', '2:7', '3:4']);
  db.role.findUnique.mockResolvedValue({ id: 5 });
  db.permission.upsert.mockResolvedValue({ id: 7 });
  db.rolePermission.upsert.mockImplementation(({ create, update }) => {
    expect(update).toEqual({});
    links.add(`${create.roleId}:${create.permissionId}`);
  });
  await provisionEmployeeShiftPermissions(db as unknown as PrismaClient);
  await provisionEmployeeShiftPermissions(db as unknown as PrismaClient);
  expect([...links]).toEqual(['1:7', '2:7', '3:4', '5:7']);
  expect(db.role.findUnique).toHaveBeenCalledWith({
    where: { name: 'EMPLOYEE' },
    select: { id: true },
  });
  expect(db.permission.upsert).toHaveBeenCalledWith(
    expect.objectContaining({ where: { key: 'shifts.read' }, update: {} }),
  );
});
it('requires a configured EMPLOYEE role before any permission writes', async () => {
  db.role.findUnique.mockResolvedValue(null);
  await expect(
    provisionEmployeeShiftPermissions(db as unknown as PrismaClient),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect(db.permission.upsert).not.toHaveBeenCalled();
  expect(db.rolePermission.upsert).not.toHaveBeenCalled();
});

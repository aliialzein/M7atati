import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { provisionEmployeeAttendancePermissions } from '../../scripts/employee-attendance-permissions.js';

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
it('has no provisioning side effects on import', () => {
  expect(db.$transaction).not.toHaveBeenCalled();
});
it('idempotently adds only EMPLOYEE self-write and preserves unrelated grants', async () => {
  const links = new Set(['1:2', '3:7']);
  db.role.findUnique.mockResolvedValue({ id: 5 });
  db.permission.upsert.mockResolvedValue({ id: 9 });
  db.rolePermission.upsert.mockImplementation(({ create, update }) => {
    expect(update).toEqual({});
    links.add(`${create.roleId}:${create.permissionId}`);
  });
  for (let i = 0; i < 2; i++)
    await provisionEmployeeAttendancePermissions(db as unknown as PrismaClient);
  expect([...links]).toEqual(['1:2', '3:7', '5:9']);
  expect(db.role.findUnique).toHaveBeenCalledWith({
    where: { name: 'EMPLOYEE' },
    select: { id: true },
  });
  expect(db.permission.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { key: 'attendance.self.write' },
      update: {},
    }),
  );
});
it('requires the existing EMPLOYEE role before any writes', async () => {
  db.role.findUnique.mockResolvedValue(null);
  await expect(
    provisionEmployeeAttendancePermissions(db as unknown as PrismaClient),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect(db.permission.upsert).not.toHaveBeenCalled();
  expect(db.rolePermission.upsert).not.toHaveBeenCalled();
});

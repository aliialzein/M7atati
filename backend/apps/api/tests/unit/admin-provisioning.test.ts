import { provisionInitialAdmin } from '../../scripts/admin-provisioning.js';
import { prisma } from '../../src/database/prisma.js';
import { passwordService } from '../../src/modules/auth/password.service.js';

jest.mock('../../src/database/prisma.js', () => ({
  prisma: {
    user: { count: jest.fn(), create: jest.fn() },
    role: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  },
}));

type MockDatabase = {
  user: { count: jest.Mock; create: jest.Mock };
  role: { findUnique: jest.Mock };
  $transaction: jest.Mock;
};
const db = prisma as unknown as MockDatabase;
const credentials = {
  name: ' First Admin ',
  email: ' ADMIN@Example.com ',
  password: 'Strong-password!123',
};

beforeEach(() => {
  jest.resetAllMocks();
  jest
    .spyOn(passwordService, 'hash')
    .mockResolvedValue('private-password-hash');
  db.$transaction.mockImplementation(
    (work: (tx: MockDatabase) => Promise<unknown>) => work(db),
  );
  db.user.count.mockResolvedValue(0);
  db.role.findUnique.mockResolvedValue({ id: 1 });
  db.user.create.mockResolvedValue({
    id: 1,
    name: 'First Admin',
    email: 'admin@example.com',
    role: { name: 'ADMIN' },
    stationId: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    passwordHash: 'private-password-hash',
  });
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('initial administrator provisioning', () => {
  it('has no database side effect merely from importing the helper', () => {
    expect(db.user.create).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('validates, normalizes, hashes, and connects only the seeded ADMIN role', async () => {
    const result = await provisionInitialAdmin(credentials);
    expect(result).toMatchObject({
      role: 'ADMIN',
      stationId: null,
      isActive: true,
    });
    expect(result).not.toHaveProperty('passwordHash');
    expect(passwordService.hash).toHaveBeenCalledWith(credentials.password);
    expect(db.role.findUnique).toHaveBeenCalledWith({
      where: { name: 'ADMIN' },
      select: { id: true },
    });
    expect(db.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          name: 'First Admin',
          email: 'admin@example.com',
          passwordHash: 'private-password-hash',
          roleId: 1,
          stationId: null,
        },
      }),
    );
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
  });

  it.each([
    {},
    { ...credentials, password: 'weak' },
    { ...credentials, email: 'invalid' },
    { ...credentials, role: 'ADMIN' },
    { ...credentials, password: 'Aa1!' + 'é'.repeat(35) },
  ])(
    'rejects missing/invalid credentials without writing: %j',
    async (input) => {
      await expect(provisionInitialAdmin(input)).rejects.toThrow();
      expect(passwordService.hash).not.toHaveBeenCalled();
      expect(db.$transaction).not.toHaveBeenCalled();
    },
  );

  it('refuses bootstrap once any ADMIN exists, including an inactive ADMIN', async () => {
    db.user.count.mockResolvedValue(1);
    await expect(provisionInitialAdmin(credentials)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(db.user.count).toHaveBeenCalledWith({
      where: { role: { name: 'ADMIN' } },
    });
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it('requires the seeded role and never creates or reseeds it', async () => {
    db.role.findUnique.mockResolvedValue(null);
    await expect(provisionInitialAdmin(credentials)).rejects.toThrow(
      'Seeded ADMIN role is not configured',
    );
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it('returns a sanitized conflict for a duplicate existing email', async () => {
    db.user.create.mockRejectedValue({ code: 'P2002', meta: 'private data' });
    await expect(provisionInitialAdmin(credentials)).rejects.toMatchObject({
      statusCode: 409,
      message: 'Email already registered',
    });
  });

  it('retries a concurrent bootstrap conflict and rechecks ADMIN existence', async () => {
    db.$transaction.mockRejectedValueOnce({ code: 'P2034' });
    db.user.count.mockResolvedValue(1);
    await expect(provisionInitialAdmin(credentials)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(db.user.create).not.toHaveBeenCalled();
  });
});

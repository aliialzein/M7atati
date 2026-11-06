import type { Prisma } from '../../generated/prisma/client.js';

import { prisma } from '../../database/prisma.js';
import { HttpError } from '../../types/http-error.js';
import type { ListUsersInput } from './users.validation.js';

const userSelect = {
  id: true,
  name: true,
  email: true,
  stationId: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  role: { select: { name: true } },
} satisfies Prisma.UserSelect;

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

export const usersRepository = {
  async transaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await prisma.$transaction(work, {
          isolationLevel: 'Serializable',
        });
      } catch (error) {
        if (hasCode(error, 'P2034')) {
          if (attempt < 2) continue;
          throw new HttpError('Concurrent update; retry request', 409);
        }
        if (hasCode(error, 'P2002'))
          throw new HttpError('Email already registered', 409);
        if (hasCode(error, 'P2003') || hasCode(error, 'P2025')) {
          throw new HttpError('Related record changed; retry request', 409);
        }
        throw error;
      }
    }
  },
  async list(
    where: Prisma.UserWhereInput,
    input: ListUsersInput,
    tx: Prisma.TransactionClient,
  ) {
    const [users, total] = await Promise.all([
      tx.user.findMany({
        where,
        select: userSelect,
        skip: (input.page - 1) * input.limit,
        take: input.limit,
        orderBy: { id: 'asc' },
      }),
      tx.user.count({ where }),
    ]);
    return { users, total };
  },
  findUser(
    id: number,
    scope: Prisma.UserWhereInput,
    tx: Prisma.TransactionClient,
  ) {
    return tx.user.findFirst({
      where: { AND: [scope, { id }] },
      select: userSelect,
    });
  },
  findStation(where: Prisma.StationWhereInput, tx: Prisma.TransactionClient) {
    return tx.station.findFirst({ where, select: { id: true } });
  },
  findRole(name: string, tx: Prisma.TransactionClient) {
    return tx.role.findUnique({ where: { name }, select: { id: true } });
  },
  countActiveAdmins(tx: Prisma.TransactionClient) {
    return tx.user.count({
      where: { isActive: true, role: { name: 'ADMIN' } },
    });
  },
  countAdmins(tx: Prisma.TransactionClient) {
    return tx.user.count({ where: { role: { name: 'ADMIN' } } });
  },
  countManagedStations(userId: number, tx: Prisma.TransactionClient) {
    return tx.station.count({ where: { managerId: userId } });
  },
  create(
    input: {
      name: string;
      email: string;
      passwordHash: string;
      roleId: number;
      stationId: number | null;
    },
    tx: Prisma.TransactionClient,
  ) {
    return tx.user.create({ data: input, select: userSelect });
  },
  update(
    id: number,
    data: {
      name?: string;
      roleId?: number;
      stationId?: number | null;
      isActive?: boolean;
    },
    tx: Prisma.TransactionClient,
  ) {
    return tx.user.update({ where: { id }, data, select: userSelect });
  },
  revokeSessions(userId: number, tx: Prisma.TransactionClient) {
    return tx.refreshSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  },
};

import type { Prisma } from '../../generated/prisma/client.js';

import { prisma } from '../../database/prisma.js';
import { HttpError } from '../../types/http-error.js';
import type { AuthUser, TokenPair } from './auth.types.js';

const userSelect = {
  id: true,
  name: true,
  email: true,
  passwordHash: true,
  isActive: true,
  stationId: true,
  role: {
    select: {
      name: true,
      permissions: {
        select: { permission: { select: { key: true } } },
      },
    },
  },
} satisfies Prisma.UserSelect;

function sessionData(userId: number, tokens: TokenPair) {
  return {
    id: tokens.sessionId,
    userId,
    tokenHash: tokens.tokenHash,
    expiresAt: tokens.expiresAt,
  };
}

export const authRepository = {
  findUserByEmail(email: string) {
    return prisma.user.findUnique({ where: { email }, select: userSelect });
  },
  findUserById(id: number) {
    return prisma.user.findUnique({ where: { id }, select: userSelect });
  },
  async createCustomer(
    input: { name: string; email: string; passwordHash: string },
    issueTokens: (userId: number) => TokenPair,
  ): Promise<{ user: AuthUser; tokens: TokenPair }> {
    try {
      return await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { ...input, role: { connect: { name: 'CUSTOMER' } } },
          select: userSelect,
        });
        const tokens = issueTokens(user.id);
        await tx.refreshSession.create({ data: sessionData(user.id, tokens) });
        return { user, tokens };
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2002'
      ) {
        throw new HttpError('Email already registered', 409);
      }
      throw error;
    }
  },
  createSession(userId: number, tokens: TokenPair) {
    return prisma.refreshSession.create({ data: sessionData(userId, tokens) });
  },
  findSession(id: string) {
    return prisma.refreshSession.findUnique({
      where: { id },
      include: { user: { select: userSelect } },
    });
  },
  async rotateSession(
    userId: number,
    oldHash: string,
    tokens: TokenPair,
  ): Promise<boolean> {
    const now = new Date();
    // Compare-and-swap: only one request holding the current hash can consume it.
    const result = await prisma.refreshSession.updateMany({
      where: {
        id: tokens.sessionId,
        userId,
        tokenHash: oldHash,
        revokedAt: null,
        expiresAt: { gt: now },
        user: { isActive: true },
      },
      data: {
        tokenHash: tokens.tokenHash,
        expiresAt: tokens.expiresAt,
        lastUsedAt: now,
      },
    });
    return result.count === 1;
  },
  revokeSession(id: string, userId: number) {
    return prisma.refreshSession.updateMany({
      where: { id, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  },
};

import { createHash, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { HttpError } from '../../types/http-error.js';
import type { TokenPair } from './auth.types.js';

export const ACCESS_TOKEN_SECONDS = 15 * 60;
export const REFRESH_TOKEN_SECONDS = 7 * 24 * 60 * 60;

const claims = z.object({
  sub: z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform(Number)
    .refine((id) => Number.isSafeInteger(id) && id <= 2147483647),
  type: z.enum(['access', 'refresh']),
  exp: z.number().int(),
  iat: z.number().int(),
  jti: z.string().uuid().optional(),
  nonce: z.string().uuid().optional(),
});

function verify(token: string | undefined, type: 'access' | 'refresh') {
  try {
    if (!token || token.length > 4096) throw new Error();
    const decoded = jwt.verify(
      token,
      Buffer.from(
        type === 'access' ? env.accessTokenSecret : env.refreshTokenSecret,
        'hex',
      ),
      {
        algorithms: ['HS256'],
        issuer: env.tokenIssuer,
        audience: env.tokenAudience,
        maxAge:
          type === 'access' ? ACCESS_TOKEN_SECONDS : REFRESH_TOKEN_SECONDS,
      },
    );
    const parsed = claims.parse(decoded);
    if (parsed.type !== type) throw new Error();
    if (type === 'refresh' && (!parsed.jti || !parsed.nonce)) throw new Error();
    return parsed;
  } catch {
    throw new HttpError('Unauthenticated', 401);
  }
}

export const tokenService = {
  hash: (token: string): string =>
    createHash('sha256').update(token).digest('hex'),
  issue(userId: number, sessionId: string = randomUUID()): TokenPair {
    const options = {
      algorithm: 'HS256' as const,
      issuer: env.tokenIssuer,
      audience: env.tokenAudience,
      subject: String(userId),
    };
    const accessToken = jwt.sign(
      { type: 'access' },
      Buffer.from(env.accessTokenSecret, 'hex'),
      {
        ...options,
        expiresIn: ACCESS_TOKEN_SECONDS,
      },
    );
    const refreshToken = jwt.sign(
      { type: 'refresh', nonce: randomUUID() },
      Buffer.from(env.refreshTokenSecret, 'hex'),
      {
        ...options,
        jwtid: sessionId,
        expiresIn: REFRESH_TOKEN_SECONDS,
      },
    );
    return {
      accessToken,
      refreshToken,
      sessionId,
      tokenHash: tokenService.hash(refreshToken),
      expiresAt: new Date(
        (jwt.decode(refreshToken) as jwt.JwtPayload).exp! * 1000,
      ),
    };
  },
  verifyAccess(token: string | undefined): number {
    return verify(token, 'access').sub;
  },
  verifyRefresh(token: string | undefined): {
    userId: number;
    sessionId: string;
  } {
    const parsed = verify(token, 'refresh');
    return { userId: parsed.sub, sessionId: parsed.jti! };
  },
};

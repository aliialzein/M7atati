import { randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';

import { env } from '../../src/config/env.js';
import {
  tokenService,
  ACCESS_TOKEN_SECONDS,
  REFRESH_TOKEN_SECONDS,
} from '../../src/modules/auth/token.service.js';

function signed(
  payload: object,
  options: jwt.SignOptions = {},
  secret = env.accessTokenSecret,
) {
  return jwt.sign(payload, Buffer.from(secret, 'hex'), {
    algorithm: 'HS256',
    issuer: env.tokenIssuer,
    audience: env.tokenAudience,
    subject: '1',
    expiresIn: ACCESS_TOKEN_SECONDS,
    ...options,
  });
}

describe('JWT creation and verification', () => {
  it('issues minimal claims with separate lifetimes and secrets', () => {
    const tokens = tokenService.issue(1);
    expect(tokenService.verifyAccess(tokens.accessToken)).toBe(1);
    expect(tokenService.verifyRefresh(tokens.refreshToken)).toEqual({
      userId: 1,
      sessionId: tokens.sessionId,
    });
    const access = jwt.decode(tokens.accessToken) as jwt.JwtPayload;
    const refresh = jwt.decode(tokens.refreshToken) as jwt.JwtPayload;
    expect(access.exp! - access.iat!).toBe(ACCESS_TOKEN_SECONDS);
    expect(refresh.exp! - refresh.iat!).toBe(REFRESH_TOKEN_SECONDS);
    expect(Object.keys(access).sort()).toEqual([
      'aud',
      'exp',
      'iat',
      'iss',
      'sub',
      'type',
    ]);
    expect(tokens.expiresAt.getTime()).toBe(refresh.exp! * 1000);
    expect(() => tokenService.verifyAccess(tokens.refreshToken)).toThrow(
      'Unauthenticated',
    );
  });

  it.each([
    ['expired', () => signed({ type: 'access' }, { expiresIn: -1 })],
    [
      'invalid signature',
      () => signed({ type: 'access' }, {}, randomBytes(32).toString('hex')),
    ],
    [
      'wrong type with a valid access signature',
      () => signed({ type: 'refresh' }),
    ],
    ['wrong issuer', () => signed({ type: 'access' }, { issuer: 'attacker' })],
    [
      'wrong audience',
      () => signed({ type: 'access' }, { audience: 'attacker' }),
    ],
    [
      'wrong algorithm',
      () => signed({ type: 'access' }, { algorithm: 'HS384' }),
    ],
    [
      'missing expiration',
      () =>
        jwt.sign(
          { type: 'access' },
          Buffer.from(env.accessTokenSecret, 'hex'),
          {
            subject: '1',
            issuer: env.tokenIssuer,
            audience: env.tokenAudience,
          },
        ),
    ],
    ['malformed user id', () => signed({ type: 'access' }, { subject: '1e3' })],
    [
      'out of range user id',
      () => signed({ type: 'access' }, { subject: '2147483648' }),
    ],
    ['malformed token', () => 'not-a-jwt'],
  ])('rejects %s', (_label, makeToken) => {
    expect(() => tokenService.verifyAccess(makeToken())).toThrow(
      'Unauthenticated',
    );
  });

  it('rejects a wrong refresh type even with the refresh secret', () => {
    const token = signed(
      { type: 'access', nonce: randomUUID() },
      { jwtid: randomUUID() },
      env.refreshTokenSecret,
    );
    expect(() => tokenService.verifyRefresh(token)).toThrow('Unauthenticated');
  });

  it('rejects refresh claims without a session id or rotation nonce', () => {
    for (const payload of [
      { type: 'refresh' },
      { type: 'refresh', nonce: randomUUID() },
    ]) {
      const token = signed(payload, {}, env.refreshTokenSecret);
      expect(() => tokenService.verifyRefresh(token)).toThrow(
        'Unauthenticated',
      );
    }
  });

  it('makes rotated refresh tokens unique even within the same second', () => {
    const sessionId = randomUUID();
    const first = tokenService.issue(1, sessionId);
    const second = tokenService.issue(1, sessionId);
    expect(first.refreshToken).not.toBe(second.refreshToken);
    expect(first.tokenHash).not.toBe(second.tokenHash);
  });
});

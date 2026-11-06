import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import type { Response } from 'supertest';
import bcrypt from 'bcryptjs';

import { app } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { prisma } from '../../src/database/prisma.js';
import { authenticate } from '../../src/middleware/authenticate.js';
import { authorize } from '../../src/middleware/authorize.js';
import { csrfProtection } from '../../src/middleware/csrf.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { authRateLimiter } from '../../src/modules/auth/auth.routes.js';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
} from '../../src/modules/auth/auth.types.js';
import type { AuthUser, TokenPair } from '../../src/modules/auth/auth.types.js';
import { tokenService } from '../../src/modules/auth/token.service.js';

jest.mock('../../src/database/prisma.js', () => ({
  prisma: {
    user: { findUnique: jest.fn(), create: jest.fn() },
    refreshSession: {
      create: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));

type MockDatabase = {
  user: { findUnique: jest.Mock; create: jest.Mock };
  refreshSession: {
    create: jest.Mock;
    findUnique: jest.Mock;
    updateMany: jest.Mock;
  };
  $transaction: jest.Mock;
};
const db = prisma as unknown as MockDatabase;
type StoredSession = {
  id: string;
  userId: number;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
};
const sessions = new Map<string, StoredSession>();
let currentUser: AuthUser | null;
let passwordHash: string;
const password = 'Strong-password!123';
const origin = 'http://localhost:3000';

function fixture(): AuthUser {
  return {
    id: 1,
    name: 'Customer',
    email: 'customer@example.com',
    passwordHash,
    isActive: true,
    stationId: null,
    role: {
      name: 'CUSTOMER',
      permissions: [{ permission: { key: 'orders.create' } }],
    },
  };
}

function persist(tokens = tokenService.issue(1)): TokenPair {
  sessions.set(tokens.sessionId, {
    id: tokens.sessionId,
    userId: 1,
    tokenHash: tokens.tokenHash,
    expiresAt: tokens.expiresAt,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: new Date(),
  });
  return tokens;
}

function post(path: string) {
  return request(app)
    .post(`/api/auth/${path}`)
    .set('Origin', origin)
    .set('X-CSRF-Protection', '1');
}

function setCookies(response: Response): string[] {
  return response.headers['set-cookie'] as unknown as string[];
}

function cookie(response: Response, name: string): string {
  return setCookies(response)
    .find((value) => value.startsWith(`${name}=`))!
    .split(';')[0];
}

function refresh(tokens: TokenPair) {
  return post('refresh').set(
    'Cookie',
    `${REFRESH_COOKIE}=${tokens.refreshToken}`,
  );
}

beforeAll(async () => {
  passwordHash = await bcrypt.hash(password, 4);
});
beforeEach(() => {
  jest.clearAllMocks();
  currentUser = fixture();
  sessions.clear();
  db.user.findUnique.mockImplementation(() => Promise.resolve(currentUser));
  db.user.create.mockImplementation(
    ({
      data,
    }: {
      data: { name: string; email: string; passwordHash: string };
    }) =>
      Promise.resolve({
        ...fixture(),
        name: data.name,
        email: data.email,
        passwordHash: data.passwordHash,
      }),
  );
  db.$transaction.mockImplementation(
    (work: (tx: MockDatabase) => Promise<unknown>) => work(db),
  );
  db.refreshSession.create.mockImplementation(
    ({
      data,
    }: {
      data: Pick<StoredSession, 'id' | 'userId' | 'tokenHash' | 'expiresAt'>;
    }) => {
      const session: StoredSession = {
        ...data,
        revokedAt: null,
        lastUsedAt: null,
        createdAt: new Date(),
      };
      sessions.set(data.id, session);
      return Promise.resolve(session);
    },
  );
  db.refreshSession.findUnique.mockImplementation(
    ({ where }: { where: { id: string } }) => {
      const session = sessions.get(where.id);
      return Promise.resolve(
        session ? { ...session, user: currentUser } : null,
      );
    },
  );
  db.refreshSession.updateMany.mockImplementation(
    ({
      where,
      data,
    }: {
      where: {
        id: string;
        userId: number;
        tokenHash?: string;
        expiresAt?: { gt: Date };
        user?: { isActive: boolean };
      };
      data: Partial<StoredSession>;
    }) => {
      const session = sessions.get(where.id);
      if (
        !session ||
        session.userId !== where.userId ||
        session.revokedAt ||
        (where.tokenHash !== undefined &&
          where.tokenHash !== session.tokenHash) ||
        (where.expiresAt && session.expiresAt <= where.expiresAt.gt) ||
        (where.user && !currentUser?.isActive)
      )
        return Promise.resolve({ count: 0 });
      Object.assign(session, data);
      return Promise.resolve({ count: 1 });
    },
  );
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('registration', () => {
  it('creates CUSTOMER and its initial hashed refresh session atomically', async () => {
    const response = await post('register').send({
      name: ' Customer ',
      email: ' CUSTOMER@Example.com ',
      password,
    });
    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      user: {
        id: 1,
        name: 'Customer',
        email: 'customer@example.com',
        role: 'CUSTOMER',
        stationId: null,
      },
    });
    expect(db.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          name: 'Customer',
          email: 'customer@example.com',
          passwordHash: expect.any(String),
          role: { connect: { name: 'CUSTOMER' } },
        },
      }),
    );
    const storedHash = db.user.create.mock.calls[0][0].data
      .passwordHash as string;
    expect(storedHash).not.toBe(password);
    expect(await bcrypt.compare(password, storedHash)).toBe(true);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    const raw = cookie(response, REFRESH_COOKIE).split('=')[1];
    expect([...sessions.values()][0].tokenHash).toBe(tokenService.hash(raw));
    expect([...sessions.values()][0].tokenHash).not.toBe(raw);
    expect(response.text).not.toMatch(
      /password|tokenHash|accessToken|refreshToken/,
    );
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it.each([
    { name: '', email: 'invalid', password: 'short' },
    {
      name: 'Name',
      email: 'name@example.com',
      password: 'longbutweakpassword',
    },
    {
      name: 'Name',
      email: 'name@example.com',
      password: 'Aa1!' + 'é'.repeat(35),
    },
    { name: 'Name', email: 'name@example.com', password, role: 'ADMIN' },
    { name: 'Name', email: 'name@example.com', password, stationId: 1 },
  ])('rejects invalid input or privilege fields: %j', async (body) => {
    const response = await post('register').send(body);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ message: 'Invalid request' });
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it('returns 409 for a database-enforced duplicate email', async () => {
    db.user.create.mockRejectedValueOnce({
      code: 'P2002',
      meta: 'private database detail',
    });
    const response = await post('register').send({
      name: 'Name',
      email: 'customer@example.com',
      password,
    });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ message: 'Email already registered' });
    expect(db.refreshSession.create).not.toHaveBeenCalled();
  });
});

describe('login and cookie configuration', () => {
  it('authenticates staff and normalizes email without public provisioning', async () => {
    currentUser!.role.name = 'MANAGER';
    currentUser!.stationId = 4;
    const response = await post('login').send({
      email: ' CUSTOMER@EXAMPLE.COM ',
      password,
    });
    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({ role: 'MANAGER', stationId: 4 });
    expect(db.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'customer@example.com' } }),
    );
    expect(db.refreshSession.create).toHaveBeenCalledTimes(1);
    expect(db.user.create).not.toHaveBeenCalled();
    expect(setCookies(response)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /m7atati_access=.*Max-Age=900; Path=\/api;.*HttpOnly; SameSite=Lax/,
        ),
        expect.stringMatching(
          /m7atati_refresh=.*Max-Age=604800; Path=\/api\/auth;.*HttpOnly; SameSite=Lax/,
        ),
      ]),
    );
  });

  it.each(['wrong password', 'unknown user', 'disabled user'])(
    'uses generic errors for %s',
    async (scenario) => {
      if (scenario === 'unknown user') currentUser = null;
      if (scenario === 'disabled user') currentUser!.isActive = false;
      const response = await post('login').send({
        email: 'customer@example.com',
        password: scenario === 'wrong password' ? 'Wrong!12345678' : password,
      });
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ message: 'Invalid credentials' });
      expect(db.refreshSession.create).not.toHaveBeenCalled();
    },
  );

  it('marks both cookies Secure in production', async () => {
    jest.replaceProperty(env, 'nodeEnv', 'production');
    const response = await post('login').send({
      email: 'customer@example.com',
      password,
    });
    expect(response.status).toBe(200);
    expect(
      setCookies(response).every((value) => value.includes('; Secure;')),
    ).toBe(true);
  });
});

describe('refresh sessions', () => {
  it('rotates the token in the same session, rejects reuse, and accepts the replacement', async () => {
    const tokens = persist();
    const first = await refresh(tokens);
    expect(first.status).toBe(200);
    const nextToken = cookie(first, REFRESH_COOKIE).split('=')[1];
    expect(nextToken).not.toBe(tokens.refreshToken);
    expect(sessions.size).toBe(1);
    expect(sessions.get(tokens.sessionId)?.tokenHash).toBe(
      tokenService.hash(nextToken),
    );
    expect(sessions.get(tokens.sessionId)?.lastUsedAt).toBeInstanceOf(Date);
    expect((await refresh(tokens)).status).toBe(401);
    expect(
      (await post('refresh').set('Cookie', `${REFRESH_COOKIE}=${nextToken}`))
        .status,
    ).toBe(200);
  });

  it.each([
    'revoked',
    'expired session',
    'wrong owner',
    'disabled',
    'missing session',
    'hash mismatch',
  ])('rejects %s', async (scenario) => {
    const tokens = persist();
    const session = sessions.get(tokens.sessionId)!;
    if (scenario === 'revoked') session.revokedAt = new Date();
    if (scenario === 'expired session') session.expiresAt = new Date(0);
    if (scenario === 'wrong owner') session.userId = 2;
    if (scenario === 'disabled') currentUser!.isActive = false;
    if (scenario === 'missing session') sessions.clear();
    if (scenario === 'hash mismatch') session.tokenHash = 'old-hash';
    expect((await refresh(tokens)).status).toBe(401);
    expect(db.refreshSession.updateMany).not.toHaveBeenCalled();
  });

  it('rejects an expired JWT before querying a session', async () => {
    const tokens = persist();
    jest.useFakeTimers({
      now: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000),
      doNotFake: ['nextTick', 'setImmediate'],
    });
    try {
      expect((await refresh(tokens)).status).toBe(401);
      expect(db.refreshSession.findUnique).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('allows exactly one of two concurrent consumers through the atomic hash comparison', async () => {
    const tokens = persist();
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    db.refreshSession.findUnique.mockImplementation(async () => {
      const snapshot = {
        ...sessions.get(tokens.sessionId)!,
        user: currentUser,
      };
      if (++reads === 2) release();
      await bothRead;
      return snapshot;
    });
    const results = await Promise.all([refresh(tokens), refresh(tokens)]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 401]);
    expect(db.refreshSession.updateMany).toHaveBeenCalledTimes(2);
    expect(db.refreshSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tokenHash: tokens.tokenHash,
          revokedAt: null,
          userId: 1,
          expiresAt: { gt: expect.any(Date) },
          user: { isActive: true },
        }),
      }),
    );
    expect(sessions.size).toBe(1);
  });
});

describe('logout', () => {
  it('clears cookies but reports failure if database revocation fails', async () => {
    const tokens = persist();
    db.refreshSession.updateMany.mockRejectedValueOnce(
      new Error('private database error'),
    );
    const response = await post('logout').set(
      'Cookie',
      `${REFRESH_COOKIE}=${tokens.refreshToken}`,
    );
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ message: 'Internal Server Error' });
    expect(setCookies(response)).toHaveLength(2);
  });

  it('revokes, clears cookies with matching paths, and is repeatable', async () => {
    const tokens = persist();
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await post('logout').set(
        'Cookie',
        `${REFRESH_COOKIE}=${tokens.refreshToken}`,
      );
      expect(response.status).toBe(204);
      expect(setCookies(response)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /m7atati_access=; Path=\/api; Expires=Thu, 01 Jan 1970.*HttpOnly; SameSite=Lax/,
          ),
          expect.stringMatching(
            /m7atati_refresh=; Path=\/api\/auth; Expires=Thu, 01 Jan 1970.*HttpOnly; SameSite=Lax/,
          ),
        ]),
      );
    }
    expect(sessions.get(tokens.sessionId)?.revokedAt).toBeInstanceOf(Date);
    expect((await refresh(tokens)).status).toBe(401);
    // Access JWT revocation is deliberately not claimed by logout.
    expect(
      (
        await request(app)
          .get('/api/auth/me')
          .set('Cookie', `${ACCESS_COOKIE}=${tokens.accessToken}`)
      ).status,
    ).toBe(200);
  });

  it.each([undefined, 'malformed'])(
    'clears cookies without a valid refresh token: %s',
    async (token) => {
      const pending = post('logout');
      if (token) pending.set('Cookie', `${REFRESH_COOKIE}=${token}`);
      const response = await pending;
      expect(response.status).toBe(204);
      expect(setCookies(response)).toHaveLength(2);
    },
  );
});

describe('authentication and permission middleware', () => {
  function protectedApp(permission = 'orders.create') {
    const testApp = express();
    testApp.use(
      cookieParser(),
      csrfProtection,
      authenticate,
      authorize(permission),
    );
    testApp.post('/orders', (req, res) => res.json({ user: req.auth!.user }));
    testApp.use(errorHandler);
    return testApp;
  }

  it('rejects a state-changing request with a valid cookie but no CSRF proof', async () => {
    const response = await request(protectedApp())
      .post('/orders')
      .set('Origin', origin)
      .set('Cookie', `${ACCESS_COOKIE}=${tokenService.issue(1).accessToken}`);
    expect(response.status).toBe(403);
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it.each([undefined, 'malformed'])(
    'rejects a missing or malformed access cookie: %s',
    async (token) => {
      const pending = request(app).get('/api/auth/me');
      if (token) pending.set('Cookie', `${ACCESS_COOKIE}=${token}`);
      expect((await pending).status).toBe(401);
      expect(db.user.findUnique).not.toHaveBeenCalled();
    },
  );

  it('returns only the safe current profile', async () => {
    const response = await request(app)
      .get('/api/auth/me')
      .set('Cookie', `${ACCESS_COOKIE}=${tokenService.issue(1).accessToken}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      user: {
        id: 1,
        name: 'Customer',
        email: 'customer@example.com',
        role: 'CUSTOMER',
        stationId: null,
      },
    });
  });

  it.each(['disabled', 'deleted'])(
    'rejects a %s user despite a valid JWT',
    async (scenario) => {
      if (scenario === 'disabled') currentUser!.isActive = false;
      else currentUser = null;
      expect(
        (
          await request(app)
            .get('/api/auth/me')
            .set(
              'Cookie',
              `${ACCESS_COOKIE}=${tokenService.issue(1).accessToken}`,
            )
        ).status,
      ).toBe(401);
    },
  );

  it('uses current database permissions to permit requests', async () => {
    const response = await request(protectedApp())
      .post('/orders')
      .set('Origin', origin)
      .set('X-CSRF-Protection', '1')
      .set('Cookie', `${ACCESS_COOKIE}=${tokenService.issue(1).accessToken}`);
    expect(response.status).toBe(200);
  });

  it('denies missing permissions, including ADMIN without seeded assignments', async () => {
    currentUser!.role = { name: 'ADMIN', permissions: [] };
    const response = await request(protectedApp())
      .post('/orders')
      .set('Origin', origin)
      .set('X-CSRF-Protection', '1')
      .set('Cookie', `${ACCESS_COOKIE}=${tokenService.issue(1).accessToken}`);
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ message: 'Insufficient permissions' });
  });
});

describe('CSRF, CORS, rate limiting, and safe errors', () => {
  it.each([
    { origin: undefined, header: undefined },
    { origin, header: undefined },
    { origin: 'http://attacker.example', header: '1' },
    { origin: 'null', header: '1' },
    { origin: undefined, header: '1' },
  ])('rejects unsafe requests with %j', async (headers) => {
    const pending = request(app).post('/api/auth/logout');
    if (headers.origin) pending.set('Origin', headers.origin);
    if (headers.header) pending.set('X-CSRF-Protection', headers.header);
    expect((await pending).status).toBe(403);
  });

  it('accepts credentialed preflight only for configured origins', async () => {
    const response = await request(app)
      .options('/api/auth/login')
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-csrf-protection');
    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(origin);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    const untrusted = await request(app)
      .get('/api/health')
      .set('Origin', 'http://attacker.example');
    expect(untrusted.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('returns consistent 429 responses after the IP limit', async () => {
    const limited = express();
    limited.post('/', authRateLimiter(2), (_req, res) => res.sendStatus(204));
    limited.use(errorHandler);
    expect((await request(limited).post('/')).status).toBe(204);
    expect((await request(limited).post('/')).status).toBe(204);
    const response = await request(limited).post('/');
    expect(response.status).toBe(429);
    expect(response.body).toEqual({ message: 'Rate limit exceeded' });
    expect(response.headers['retry-after']).toBeDefined();
  });

  it('returns 400 for malformed JSON and 500 without database details', async () => {
    const malformed = await post('login')
      .set('Content-Type', 'application/json')
      .send('{');
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ message: 'Invalid request' });
    db.user.findUnique.mockRejectedValueOnce(
      new Error('secret postgresql://private'),
    );
    const response = await post('login').send({
      email: 'customer@example.com',
      password,
    });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ message: 'Internal Server Error' });
  });
});

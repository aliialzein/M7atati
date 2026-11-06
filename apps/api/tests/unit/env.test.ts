const original = { ...process.env };

afterEach(() => {
  process.env = { ...original };
  jest.resetModules();
});

async function loadEnv() {
  jest.resetModules();
  return import('../../src/config/env.js');
}

describe('authentication environment validation', () => {
  it('loads explicit test configuration', async () => {
    const { env } = await loadEnv();
    expect(env.allowedOrigins).toContain('http://localhost:3000');
    expect(env.accessTokenSecret).not.toBe(env.refreshTokenSecret);
  });

  it.each([
    ['JWT_ACCESS_SECRET', ''],
    ['JWT_ACCESS_SECRET', 'short'],
    ['JWT_REFRESH_SECRET', 'a'.repeat(64)],
    ['JWT_REFRESH_SECRET', original.JWT_ACCESS_SECRET!],
    ['ALLOWED_ORIGINS', '*'],
    ['ALLOWED_ORIGINS', 'https://example.com/path'],
    ['ALLOWED_ORIGINS', 'https://user:password@example.com'],
  ])('rejects invalid %s configuration', async (key, value) => {
    process.env[key] = value;
    await expect(loadEnv()).rejects.toThrow();
  });

  it('requires explicit HTTPS origins in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.ALLOWED_ORIGINS = '';
    await expect(loadEnv()).rejects.toThrow('ALLOWED_ORIGINS');
    process.env.ALLOWED_ORIGINS = 'http://example.com';
    await expect(loadEnv()).rejects.toThrow('ALLOWED_ORIGINS');
    process.env.ALLOWED_ORIGINS = 'https://example.com';
    await expect(loadEnv()).resolves.toBeDefined();
  });
});

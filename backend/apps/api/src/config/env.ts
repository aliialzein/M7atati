import dotenv from 'dotenv';
import { resolve } from 'node:path';

dotenv.config({ path: [resolve('apps/api/.env'), resolve('.env')] });

const port = Number(process.env.PORT ?? 4000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

const databaseUrl = process.env.DATABASE_URL ?? '';
try {
  const url = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) {
    throw new Error();
  }
} catch {
  throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL');
}

const nodeEnv = process.env.NODE_ENV ?? 'development';
if (!['development', 'test', 'production'].includes(nodeEnv)) {
  throw new Error('NODE_ENV must be development, test, or production');
}

function secret(name: string): string {
  const value = process.env[name] ?? '';
  if (
    !/^[a-fA-F0-9]{64}$/.test(value) ||
    new Set(value.toLowerCase()).size < 8
  ) {
    throw new Error(
      `${name} must contain 32 random bytes encoded as 64 hexadecimal characters`,
    );
  }
  return value.toLowerCase();
}

const accessTokenSecret = secret('JWT_ACCESS_SECRET');
const refreshTokenSecret = secret('JWT_REFRESH_SECRET');
if (accessTokenSecret === refreshTokenSecret) {
  throw new Error('Access and refresh token secrets must be different');
}

const allowedOrigins = (
  process.env.ALLOWED_ORIGINS ??
  (nodeEnv === 'production'
    ? ''
    : 'http://localhost:3000,http://localhost:4000')
)
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
if (
  !allowedOrigins.length ||
  allowedOrigins.some((origin) => {
    try {
      const url = new URL(origin);
      return (
        url.origin !== origin ||
        !['http:', 'https:'].includes(url.protocol) ||
        (nodeEnv === 'production' && url.protocol !== 'https:')
      );
    } catch {
      return true;
    }
  })
) {
  throw new Error(
    'ALLOWED_ORIGINS must list explicit origins (HTTPS in production)',
  );
}

export const env = {
  port,
  databaseUrl,
  nodeEnv,
  accessTokenSecret,
  refreshTokenSecret,
  tokenIssuer: process.env.JWT_ISSUER?.trim() || 'm7atati-api',
  tokenAudience: process.env.JWT_AUDIENCE?.trim() || 'm7atati-web',
  allowedOrigins,
};

import type { CookieOptions, Request, Response } from 'express';

import { env } from '../../config/env.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authService } from './auth.service.js';
import type { AuthResult } from './auth.types.js';
import { ACCESS_COOKIE, REFRESH_COOKIE } from './auth.types.js';
import { loginSchema, registerSchema } from './auth.validation.js';
import {
  ACCESS_TOKEN_SECONDS,
  REFRESH_TOKEN_SECONDS,
} from './token.service.js';

function readCookie(req: Request, name: string): string | undefined {
  const value: unknown = req.cookies?.[name];
  return typeof value === 'string' ? value : undefined;
}

function cookieOptions(path: string): CookieOptions {
  return {
    path,
    httpOnly: true,
    secure: env.nodeEnv === 'production',
    sameSite: 'lax',
  };
}

function sendSession(res: Response, result: AuthResult, status = 200): void {
  res.cookie(ACCESS_COOKIE, result.tokens.accessToken, {
    ...cookieOptions('/api'),
    maxAge: ACCESS_TOKEN_SECONDS * 1000,
  });
  res.cookie(REFRESH_COOKIE, result.tokens.refreshToken, {
    ...cookieOptions('/api/auth'),
    maxAge: REFRESH_TOKEN_SECONDS * 1000,
  });
  res.status(status).json({ user: result.user });
}

export const authController = {
  register: asyncHandler(async (req, res) => {
    sendSession(
      res,
      await authService.register(registerSchema.parse(req.body)),
      201,
    );
  }),
  login: asyncHandler(async (req, res) => {
    sendSession(res, await authService.login(loginSchema.parse(req.body)));
  }),
  refresh: asyncHandler(async (req, res) => {
    sendSession(
      res,
      await authService.refresh(readCookie(req, REFRESH_COOKIE)),
    );
  }),
  logout: asyncHandler(async (req, res) => {
    try {
      await authService.logout(readCookie(req, REFRESH_COOKIE));
    } finally {
      res.clearCookie(ACCESS_COOKIE, cookieOptions('/api'));
      res.clearCookie(REFRESH_COOKIE, cookieOptions('/api/auth'));
    }
    res.status(204).end();
  }),
  me: asyncHandler(async (req, res) => {
    res.json({ user: req.auth!.user });
  }),
};

import type { RequestHandler } from 'express';

import { env } from '../config/env.js';
import { HttpError } from '../types/http-error.js';

export const csrfProtection: RequestHandler = (req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (
    req.get('X-CSRF-Protection') !== '1' ||
    !env.allowedOrigins.includes(req.get('Origin') ?? '')
  ) {
    return next(
      new HttpError('Invalid request origin or CSRF protection header', 403),
    );
  }
  next();
};

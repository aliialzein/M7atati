import type { RequestHandler } from 'express';

import { HttpError } from '../types/http-error.js';

export function authorize(permission: string): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) return next(new HttpError('Unauthenticated', 401));
    if (!req.auth.permissions.includes(permission)) {
      return next(new HttpError('Insufficient permissions', 403));
    }
    next();
  };
}

import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';

import { authenticate } from '../../middleware/authenticate.js';
import { HttpError } from '../../types/http-error.js';
import { authController } from './auth.controller.js';

export function authRateLimiter(limit: number) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) =>
      next(new HttpError('Rate limit exceeded', 429)),
  });
}

export const authRouter = Router();
authRouter.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
authRouter.post('/register', authRateLimiter(10), authController.register);
authRouter.post('/login', authRateLimiter(20), authController.login);
authRouter.post('/refresh', authRateLimiter(60), authController.refresh);
authRouter.post('/logout', authController.logout);
authRouter.get('/me', authenticate, authController.me);

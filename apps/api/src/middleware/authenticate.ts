import { authService } from '../modules/auth/auth.service.js';
import { ACCESS_COOKIE } from '../modules/auth/auth.types.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const authenticate = asyncHandler(async (req, _res, next) => {
  const token: unknown = req.cookies?.[ACCESS_COOKIE];
  req.auth = await authService.authenticate(
    typeof token === 'string' ? token : undefined,
  );
  next();
});

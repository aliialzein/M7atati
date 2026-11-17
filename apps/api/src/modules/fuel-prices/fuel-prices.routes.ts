import { Router, type ErrorRequestHandler } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { HttpError } from '../../types/http-error.js';
import { fuelPricesController } from './fuel-prices.controller.js';

export const fuelPricesRouter = Router();
fuelPricesRouter.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
fuelPricesRouter.use(authenticate);
fuelPricesRouter.use((req, _res, next) => {
  if (req.auth!.user.role !== 'ADMIN')
    return next(new HttpError('Insufficient permissions', 403));
  next();
});
fuelPricesRouter.post(
  '/refresh',
  authorize('pricing.update'),
  fuelPricesController.refresh,
);
fuelPricesRouter.get(
  '/current',
  authorize('pricing.read'),
  fuelPricesController.current,
);
fuelPricesRouter.get(
  '/history',
  authorize('pricing.read'),
  fuelPricesController.history,
);
// Only explicitly constructed HttpErrors have safe public messages. Unexpected DB/runtime
// errors continue through the shared handler; upstream bodies are never wrapped in HttpError.
const pricingErrors: ErrorRequestHandler = (error, _req, res, next) => {
  if (
    error instanceof HttpError &&
    error.statusCode >= 500 &&
    !res.headersSent
  ) {
    res.status(error.statusCode).json({ message: error.message });
    return;
  }
  next(error);
};
fuelPricesRouter.use(pricingErrors);

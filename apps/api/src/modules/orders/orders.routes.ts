import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { HttpError } from '../../types/http-error.js';
import { ordersController } from './orders.controller.js';

export const managerOrdersRouter = Router();
// Route-local middleware keeps orders.read independent of attendance.read.
managerOrdersRouter.get(
  '/stations/:stationId/orders',
  (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  },
  authenticate,
  (req, _res, next) => {
    if (req.auth!.user.role !== 'MANAGER')
      return next(new HttpError('Insufficient permissions', 403));
    next();
  },
  authorize('orders.read'),
  ordersController.list,
);

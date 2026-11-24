import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { analyticsController } from '../modules/analytics/analytics.controller.js';
import { ordersController } from '../modules/orders/orders.controller.js';
import { HttpError } from '../types/http-error.js';

export const adminBranchReadsRouter = Router();

adminBranchReadsRouter.use(
  (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  },
  authenticate,
  (req, _res, next) => {
    if (req.auth!.user.role !== 'ADMIN')
      return next(new HttpError('Insufficient permissions', 403));
    next();
  },
  authorize('stations.read'),
);

adminBranchReadsRouter.get(
  '/stations/:stationId/orders',
  authorize('orders.read'),
  ordersController.list,
);
adminBranchReadsRouter.get(
  '/stations/:stationId/orders/:orderId',
  authorize('orders.read'),
  ordersController.detail,
);
adminBranchReadsRouter.get(
  '/stations/:stationId/analytics',
  authorize('reports.read'),
  authorize('attendance.read'),
  authorize('orders.read'),
  analyticsController.station,
);

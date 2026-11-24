import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { HttpError } from '../../types/http-error.js';
import { analyticsController } from './analytics.controller.js';

export const managerAnalyticsRouter = Router();
managerAnalyticsRouter.get(
  '/stations/:stationId/analytics',
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
  authorize('reports.read'),
  authorize('attendance.read'),
  authorize('orders.read'),
  analyticsController.station,
);

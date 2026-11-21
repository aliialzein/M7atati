import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { positiveInteger } from '../../utils/query.validation.js';
import { HttpError } from '../../types/http-error.js';
import { ordersController } from './orders.controller.js';
import { employeeOrdersService } from './orders.service.js';
import {
  employeeOrdersSchema,
  employeeWorkSchema,
  emptyOrderInput,
} from './orders.validation.js';

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

export const employeeOrdersRouter = Router();
employeeOrdersRouter.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
employeeOrdersRouter.use(authenticate);
employeeOrdersRouter.use((req, _res, next) => {
  if (req.auth!.user.role !== 'EMPLOYEE')
    return next(new HttpError('Insufficient permissions', 403));
  next();
});
employeeOrdersRouter.get(
  '/mine',
  authorize('orders.read'),
  asyncHandler(async (req, res) => {
    res.json(
      await employeeOrdersService.mine(
        req.auth!.user,
        employeeWorkSchema.parse(req.query),
      ),
    );
  }),
);
employeeOrdersRouter.get(
  '/:id',
  authorize('orders.read'),
  asyncHandler(async (req, res) => {
    emptyOrderInput.parse(req.query);
    res.json(
      await employeeOrdersService.detail(
        req.auth!.user,
        positiveInteger.parse(req.params.id),
      ),
    );
  }),
);
for (const action of ['claim', 'complete'] as const) {
  employeeOrdersRouter.post(
    `/:id/${action}`,
    authorize('orders.update'),
    asyncHandler(async (req, res) => {
      emptyOrderInput.parse(req.query);
      emptyOrderInput.parse(req.body ?? {});
      res.json(
        await employeeOrdersService.transition(
          req.auth!.user,
          positiveInteger.parse(req.params.id),
          action,
        ),
      );
    }),
  );
}
employeeOrdersRouter.get(
  '/',
  authorize('orders.read'),
  asyncHandler(async (req, res) => {
    res.json(
      await employeeOrdersService.list(
        req.auth!.user,
        employeeOrdersSchema.parse(req.query),
      ),
    );
  }),
);

import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { positiveInteger } from '../../utils/query.validation.js';
import { HttpError } from '../../types/http-error.js';
import { ordersController } from './orders.controller.js';
import {
  employeeOrdersService,
  orderCreationService,
  orderTrackingService,
  orderCancellationService,
} from './orders.service.js';
import { ACCESS_COOKIE } from '../auth/auth.types.js';

import {
  quoteInputSchema,
  createOrderSchema,
  employeeOrdersSchema,
  employeeWorkSchema,
  emptyOrderInput,
  customerOrderHistorySchema,
} from './orders.validation.js';

export const customerOrdersRouter = Router();
customerOrdersRouter.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
customerOrdersRouter.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 100,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) =>
      next(new HttpError('Too many order requests; retry later', 429)),
  }),
);
customerOrdersRouter.use((req, res, next) => {
  // A malformed/expired supplied cookie is never downgraded to guest access.
  if (req.cookies?.[ACCESS_COOKIE] !== undefined)
    return authenticate(req, res, next);
  next();
});
customerOrdersRouter.post(
  '/quotes',
  asyncHandler(async (req, res) => {
    emptyOrderInput.parse(req.query);
    res
      .status(201)
      .json(
        await orderCreationService.quote(
          req.auth,
          quoteInputSchema.parse(req.body),
        ),
      );
  }),
);
customerOrdersRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    emptyOrderInput.parse(req.query);
    const result = await orderCreationService.create(
      req.auth,
      createOrderSchema.parse(req.body),
    );
    res.status(result.replayed ? 200 : 201).json(result);
  }),
);

// Register the literal path before the parameter route.
customerOrdersRouter.post(
  '/:orderId/cancel',
  asyncHandler(async (req, res) => {
    emptyOrderInput.parse(req.query);
    emptyOrderInput.parse(req.body ?? {});
    res.json(
      await orderCancellationService.cancel(
        req.auth,
        positiveInteger.parse(req.params.orderId),
        req.headers['x-order-access-token'],
      ),
    );
  }),
);

customerOrdersRouter.get(
  '/mine',
  asyncHandler(async (req, res) => {
    res.json(
      await orderTrackingService.mine(
        req.auth,
        customerOrderHistorySchema.parse(req.query),
      ),
    );
  }),
);
for (const [path, history] of [
  ['/:orderId/events', true],
  ['/:orderId', false],
] as const) {
  customerOrdersRouter.get(
    path,
    asyncHandler(async (req, res) => {
      emptyOrderInput.parse(req.query);
      res.json(
        await orderTrackingService.read(
          req.auth,
          positiveInteger.parse(req.params.orderId),
          req.headers['x-order-access-token'],
          history,
        ),
      );
    }),
  );
}

export const managerOrdersRouter = Router();
// Route-local middleware keeps orders.read independent of attendance.read.
for (const [path, handler] of [
  ['/stations/:stationId/orders', ordersController.list],
  ['/stations/:stationId/orders/:orderId', ordersController.detail],
] as const) {
  managerOrdersRouter.get(
    path,
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
    handler,
  );
}

managerOrdersRouter.post(
  '/stations/:stationId/orders/:orderId/confirm-cash',
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
  authorize('payments.manage'),
  ordersController.confirmCash,
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

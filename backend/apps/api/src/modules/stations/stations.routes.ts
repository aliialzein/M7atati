import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { HttpError } from '../../types/http-error.js';
import { stationsController } from './stations.controller.js';

export const stationsRouter = Router();
stationsRouter.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
stationsRouter.get('/picker', stationsController.picker);
stationsRouter.use(authenticate);
stationsRouter.get(
  '/:id/pumps',
  (req, res, next) => {
    const role = req.auth!.user.role;
    if (role === 'ADMIN') return authorize('stations.read')(req, res, next);
    if (role === 'MANAGER') return authorize('payments.manage')(req, res, next);
    return next(new HttpError('Insufficient permissions', 403));
  },
  stationsController.pumps,
);
stationsRouter.get('/managed', (req, res, next) => {
  if (req.auth!.user.role !== 'MANAGER')
    return next(new HttpError('Insufficient permissions', 403));
  return stationsController.managed(req, res, next);
});
stationsRouter.use((req, _res, next) => {
  if (req.auth!.user.role !== 'ADMIN')
    return next(new HttpError('Insufficient permissions', 403));
  next();
});
stationsRouter.post(
  '/',
  authorize('stations.create'),
  stationsController.create,
);
stationsRouter.get('/', authorize('stations.read'), stationsController.list);
stationsRouter.get('/:id', authorize('stations.read'), stationsController.get);
stationsRouter.patch(
  '/:id',
  authorize('stations.update'),
  stationsController.update,
);
stationsRouter.patch(
  '/:id/status',
  authorize('stations.update'),
  stationsController.status,
);
stationsRouter.patch(
  '/:id/manager',
  authorize('stations.update'),
  stationsController.manager,
);

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

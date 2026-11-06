import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { usersController } from './users.controller.js';

export const usersRouter = Router();
usersRouter.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
usersRouter.use(authenticate);
usersRouter.get('/', authorize('users.read'), usersController.list);
usersRouter.get('/:id', authorize('users.read'), usersController.get);
usersRouter.post('/', authorize('users.create'), usersController.create);
usersRouter.patch('/:id', authorize('users.update'), usersController.update);
usersRouter.patch(
  '/:id/status',
  authorize('users.update'),
  usersController.status,
);

import { Router } from 'express';
import { fuelTypesController } from './fuel-types.controller.js';

// Global public catalog, matching station picker access for guest order forms.
export const fuelTypesRouter = Router();
fuelTypesRouter.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
fuelTypesRouter.get('/', fuelTypesController.list);

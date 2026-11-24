import { asyncHandler } from '../../utils/asyncHandler.js';
import { fuelPricesService } from './fuel-prices.service.js';
import { emptySchema, historySchema } from './fuel-prices.validation.js';

export const fuelPricesController = {
  refresh: asyncHandler(async (req, res) => {
    emptySchema.parse(req.query);
    emptySchema.parse(req.body ?? {});
    res.json(await fuelPricesService.refresh());
  }),
  current: asyncHandler(async (req, res) => {
    emptySchema.parse(req.query);
    res.json(await fuelPricesService.current());
  }),
  history: asyncHandler(async (req, res) =>
    res.json(await fuelPricesService.history(historySchema.parse(req.query))),
  ),
};

import { asyncHandler } from '../../utils/asyncHandler.js';
import { stationIdSchema } from '../stations/stations.validation.js';
import { ordersService } from './orders.service.js';
import { listOrdersSchema } from './orders.validation.js';

export const ordersController = {
  list: asyncHandler(async (req, res) => {
    res.json(
      await ordersService.list(
        req.auth!.user,
        stationIdSchema.parse(req.params.stationId),
        listOrdersSchema.parse(req.query),
      ),
    );
  }),
};

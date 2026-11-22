import { asyncHandler } from '../../utils/asyncHandler.js';
import { stationIdSchema } from '../stations/stations.validation.js';
import { ordersService, cashOrdersService } from './orders.service.js';
import {
  listOrdersSchema,
  emptyOrderInput,
  cashConfirmationSchema,
} from './orders.validation.js';
import { positiveInteger } from '../../utils/query.validation.js';

export const ordersController = {
  confirmCash: asyncHandler(async (req, res) => {
    emptyOrderInput.parse(req.query);
    const result = await cashOrdersService.confirm(
      req.auth!.user,
      stationIdSchema.parse(req.params.stationId),
      positiveInteger.parse(req.params.orderId),
      cashConfirmationSchema.parse(req.body),
    );
    res.status(result.replayed ? 200 : 201).json(result);
  }),
  detail: asyncHandler(async (req, res) => {
    emptyOrderInput.parse(req.query);
    res.json(
      await ordersService.detail(
        req.auth!.user,
        stationIdSchema.parse(req.params.stationId),
        positiveInteger.parse(req.params.orderId),
      ),
    );
  }),
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

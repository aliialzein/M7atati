import { asyncHandler } from '../../utils/asyncHandler.js';
import { stationIdSchema } from '../stations/stations.validation.js';
import { analyticsService } from './analytics.service.js';
import { stationAnalyticsSchema } from './analytics.validation.js';

export const analyticsController = {
  station: asyncHandler(async (req, res) => {
    res.json(
      await analyticsService.station(
        req.auth!.user,
        stationIdSchema.parse(req.params.stationId),
        stationAnalyticsSchema.parse(req.query),
      ),
    );
  }),
};

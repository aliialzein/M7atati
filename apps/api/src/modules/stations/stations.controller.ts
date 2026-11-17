import { asyncHandler } from '../../utils/asyncHandler.js';
import { stationsService } from './stations.service.js';
import {
  createStationSchema,
  listStationsSchema,
  stationIdSchema,
  stationStatusSchema,
  updateStationSchema,
} from './stations.validation.js';

export const stationsController = {
  picker: asyncHandler(async (_req, res) => {
    res.json(await stationsService.picker());
  }),
  list: asyncHandler(async (req, res) => {
    res.json(await stationsService.list(listStationsSchema.parse(req.query)));
  }),
  get: asyncHandler(async (req, res) => {
    res.json({
      station: await stationsService.get(stationIdSchema.parse(req.params.id)),
    });
  }),
  create: asyncHandler(async (req, res) => {
    res.status(201).json({
      station: await stationsService.create(
        createStationSchema.parse(req.body),
      ),
    });
  }),
  update: asyncHandler(async (req, res) => {
    res.json({
      station: await stationsService.update(
        stationIdSchema.parse(req.params.id),
        updateStationSchema.parse(req.body),
      ),
    });
  }),
  status: asyncHandler(async (req, res) => {
    const { isActive } = stationStatusSchema.parse(req.body);
    res.json({
      station: await stationsService.setStatus(
        stationIdSchema.parse(req.params.id),
        isActive,
      ),
    });
  }),
};

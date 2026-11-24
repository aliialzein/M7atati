import { z } from 'zod';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { fuelTypesRepository } from './fuel-types.repository.js';

const lookupQuery = z.object({}).strict();

export const fuelTypesController = {
  list: asyncHandler(async (req, res) => {
    lookupQuery.parse(req.query);
    const rows = await fuelTypesRepository.list();
    res.json({
      fuelTypes: rows.map(({ id, name, code }) => ({ id, name, code })),
    });
  }),
};

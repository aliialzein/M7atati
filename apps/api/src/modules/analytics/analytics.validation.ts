import { z } from 'zod';
import { timestamp } from '../../utils/query.validation.js';

export const stationAnalyticsSchema = z
  .object({
    from: timestamp.optional(),
    to: timestamp.optional(),
  })
  .strict()
  .refine((value) => !value.from || !value.to || value.from < value.to);

export type StationAnalyticsInput = z.infer<typeof stationAnalyticsSchema>;

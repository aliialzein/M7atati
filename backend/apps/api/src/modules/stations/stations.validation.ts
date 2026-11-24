import { z } from 'zod';

const positiveInteger = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .refine((value) => Number.isSafeInteger(value) && value <= 2147483647);
export const stationIdSchema = positiveInteger;
export const stationPumpsQuerySchema = z.object({}).strict();
const name = z.string().trim().min(1).max(128);
const address = z.string().trim().min(1).max(512);
const latitude = z.number().finite().min(-90).max(90).nullable();
const longitude = z.number().finite().min(-180).max(180).nullable();

// Also parses the merged stored/requested coordinates before an update is written.
export const coordinatesSchema = z
  .object({ latitude, longitude })
  .refine((value) => (value.latitude === null) === (value.longitude === null));
export const createStationSchema = z
  .object({
    name,
    address,
    latitude: latitude.optional(),
    longitude: longitude.optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.latitude === undefined) === (value.longitude === undefined) &&
      (value.latitude === null) === (value.longitude === null),
  );
export const updateStationSchema = z
  .object({
    name: name.optional(),
    address: address.optional(),
    latitude: latitude.optional(),
    longitude: longitude.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
export const stationStatusSchema = z.object({ isActive: z.boolean() }).strict();
export const stationManagerSchema = z
  .object({ managerId: z.number().int().positive().max(2147483647).nullable() })
  .strict();
export const listStationsSchema = z
  .object({
    page: positiveInteger.refine((value) => value <= 1000000).default('1'),
    limit: positiveInteger.refine((value) => value <= 100).default('20'),
    search: z.string().trim().min(1).max(128).optional(),
    isActive: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
  })
  .strict();

export type CreateStationInput = z.infer<typeof createStationSchema>;
export type UpdateStationInput = z.infer<typeof updateStationSchema>;
export type ListStationsInput = z.infer<typeof listStationsSchema>;

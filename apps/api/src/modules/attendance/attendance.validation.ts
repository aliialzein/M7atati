import { z } from 'zod';

const positiveInteger = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .refine((value) => Number.isSafeInteger(value) && value <= 2147483647);

// PostgreSQL and JS Date use millisecond precision here. Require an explicit
// timezone; never interpret a station's local wall-clock time on the server.
const timestamp = z
  .string()
  .datetime({ offset: true })
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/)
  .refine((value) => Number.isFinite(Date.parse(value)))
  .transform((value) => new Date(value));

export const listWorkRecordsSchema = z
  .object({
    page: positiveInteger.refine((value) => value <= 1000000).default('1'),
    limit: positiveInteger.refine((value) => value <= 100).default('20'),
    stationId: positiveInteger.optional(),
    employeeId: positiveInteger.optional(),
    from: timestamp.optional(),
    to: timestamp.optional(),
  })
  .strict()
  .refine((value) => !value.from || !value.to || value.from < value.to);

export type ListWorkRecordsInput = z.infer<typeof listWorkRecordsSchema>;

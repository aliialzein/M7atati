import { z } from 'zod';

export const positiveInteger = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .refine((value) => Number.isSafeInteger(value) && value <= 2147483647);

// Require an explicit offset and at most millisecond precision, matching storage
// and JS Date. Never infer the server's local timezone.
export const timestamp = z
  .string()
  .datetime({ offset: true })
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/)
  .refine((value) => Number.isFinite(Date.parse(value)))
  .transform((value) => new Date(value));

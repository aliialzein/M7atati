import { z } from 'zod';

export const fuelCodeSchema = z.enum(['gasoline_95', 'diesel']);
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    );
  });
const integer = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number);
export const historySchema = z
  .object({
    fuel: fuelCodeSchema.optional(),
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    page: integer.refine((n) => n <= 1000000).default('1'),
    limit: integer.refine((n) => n <= 100).default('20'),
  })
  .strict()
  .refine((q) => !q.from || !q.to || q.from <= q.to);
export const emptySchema = z.object({}).strict();
export type HistoryInput = z.infer<typeof historySchema>;

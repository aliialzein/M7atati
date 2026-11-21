import { z } from 'zod';
import { positiveInteger, timestamp } from '../../utils/query.validation.js';
import { demoOrderStatuses } from './orders.types.js';

const amountMinor = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .transform(Number)
  .refine((value) => Number.isSafeInteger(value) && value <= 2147483647);

export const listOrdersSchema = z
  .object({
    from: timestamp.optional(),
    to: timestamp.optional(),
    minAmountMinor: amountMinor.optional(),
    maxAmountMinor: amountMinor.optional(),
    status: z.enum(demoOrderStatuses).optional(),
    page: positiveInteger.refine((value) => value <= 1000000).default('1'),
    limit: positiveInteger.refine((value) => value <= 100).default('20'),
  })
  .strict()
  .refine((value) => !value.from || !value.to || value.from < value.to)
  .refine(
    (value) =>
      value.minAmountMinor === undefined ||
      value.maxAmountMinor === undefined ||
      value.minAmountMinor <= value.maxAmountMinor,
  );

export type ListOrdersInput = z.infer<typeof listOrdersSchema>;

export const employeeOrdersSchema = z
  .object({
    status: z.literal('PENDING').default('PENDING'),
    page: positiveInteger.refine((value) => value <= 1000000).default('1'),
    limit: positiveInteger.refine((value) => value <= 100).default('20'),
  })
  .strict();
export type EmployeeOrdersInput = z.infer<typeof employeeOrdersSchema>;

export const employeeWorkSchema = employeeOrdersSchema.extend({
  status: z.literal('IN_PROGRESS').default('IN_PROGRESS'),
});
export type EmployeeWorkInput = z.infer<typeof employeeWorkSchema>;
export const emptyOrderInput = z.object({}).strict();

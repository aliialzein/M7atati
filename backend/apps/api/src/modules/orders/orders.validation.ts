import { z } from 'zod';
import { positiveInteger, timestamp } from '../../utils/query.validation.js';
import { orderStatuses, orderStatus } from './orders.types.js';
import {
  currencySchema,
  decimalInput,
} from '../fuel-prices/fuel-prices.validation.js';

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
    status: z.enum(orderStatuses).optional(),
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
    status: z.literal(orderStatus.PENDING).default(orderStatus.PENDING),
    page: positiveInteger.refine((value) => value <= 1000000).default('1'),
    limit: positiveInteger.refine((value) => value <= 100).default('20'),
  })
  .strict();
export type EmployeeOrdersInput = z.infer<typeof employeeOrdersSchema>;

export const employeeWorkSchema = employeeOrdersSchema.extend({
  status: z.literal(orderStatus.IN_PROGRESS).default(orderStatus.IN_PROGRESS),
});
export type EmployeeWorkInput = z.infer<typeof employeeWorkSchema>;
export const customerOrderHistorySchema = employeeOrdersSchema
  .omit({ status: true })
  .extend({
    status: z.enum(orderStatuses).optional(),
  });
export type CustomerOrderHistoryInput = z.infer<
  typeof customerOrderHistorySchema
>;
export const emptyOrderInput = z.object({}).strict();

const id = z.number().int().positive().max(2147483647);
const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
export const quoteInputSchema = z
  .object({
    stationId: id,
    fuelTypeId: id,
    currency: currencySchema,
    fulfillmentType: z.enum(['IN_STATION', 'PICKUP']),
    inputMode: z.enum(['AMOUNT', 'LITERS']),
    value: decimalInput,
  })
  .strict();
export const createOrderSchema = z
  .object({
    quoteId: uuid,
    idempotencyKey: uuid,
    guestToken: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    customerName: z.string().trim().min(1).max(128).optional(),
    customerPhone: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .regex(/^[+0-9 ()-]+$/)
      .refine((value) => /\d/.test(value))
      .optional(),
  })
  .strict();
export type QuoteInput = z.infer<typeof quoteInputSchema>;
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

// Integers in the same units as the snapshot: USD cents or whole LBP.
export const cashConfirmationSchema = z
  .object({
    amountMinor: z.number().int().positive().max(2147483647),
    currency: currencySchema,
    pumpId: z.number().int().positive().max(2147483647),
  })
  .strict();

export type CashConfirmationInput = z.infer<typeof cashConfirmationSchema>;

import { z } from 'zod';

import { registerSchema } from '../auth/auth.validation.js';
import { roles } from './users.types.js';

const positiveInteger = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .refine((value) => Number.isSafeInteger(value) && value <= 2147483647);
export const userIdSchema = positiveInteger;
const role = z.enum(roles);

export const listUsersSchema = z
  .object({
    page: positiveInteger.refine((value) => value <= 1000000).default('1'),
    limit: positiveInteger.refine((value) => value <= 100).default('20'),
    search: z.string().trim().min(1).max(128).optional(),
    role: role.optional(),
    stationId: positiveInteger.optional(),
    isActive: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
  })
  .strict();

const stationId = z.number().int().positive().max(2147483647).nullable();
export const createUserSchema = registerSchema
  .extend({
    role,
    stationId: stationId.optional(),
  })
  .strict();
export const updateUserSchema = z
  .object({
    name: registerSchema.shape.name.optional(),
    role: role.optional(),
    stationId: stationId.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
export const userStatusSchema = z.object({ isActive: z.boolean() }).strict();

export type ListUsersInput = z.infer<typeof listUsersSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

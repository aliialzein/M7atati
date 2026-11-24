import { z } from 'zod';

const email = z.string().trim().toLowerCase().email().max(254);
const password = z
  .string()
  .min(12)
  .max(72)
  .regex(/[a-z]/)
  .regex(/[A-Z]/)
  .regex(/[0-9]/)
  .regex(/[^a-zA-Z0-9]/)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 72);

export const registerSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    email,
    password,
  })
  .strict();

export const loginSchema = z
  .object({
    email,
    // Login does not reapply registration policy to existing accounts.
    password: z
      .string()
      .min(1)
      .max(72)
      .refine((value) => Buffer.byteLength(value, 'utf8') <= 72),
  })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

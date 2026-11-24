import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { positiveInteger, timestamp } from '../../utils/query.validation.js';

const workRecordsQuery = z
  .object({
    page: positiveInteger.refine((value) => value <= 1000000).default('1'),
    limit: positiveInteger.refine((value) => value <= 100).default('20'),
    stationId: positiveInteger.optional(),
    employeeId: positiveInteger.optional(),
    from: timestamp.optional(),
    to: timestamp.optional(),
  })
  .strict();

function validRange(value: { from?: Date; to?: Date }) {
  return !value.from || !value.to || value.from < value.to;
}

export const listWorkRecordsSchema = workRecordsQuery.refine(validRange);
export const managerAttendanceSchema = workRecordsQuery
  .omit({ stationId: true })
  .refine(validRange);
export const attendanceExportSchema = workRecordsQuery
  .omit({ stationId: true, page: true, limit: true })
  .extend({ format: z.enum(['csv', 'pdf']) })
  .refine(validRange);

export type ListWorkRecordsInput = z.infer<typeof listWorkRecordsSchema>;
export type ManagerAttendanceInput = z.infer<typeof managerAttendanceSchema>;
export type AttendanceExportInput = z.infer<typeof attendanceExportSchema>;

export const SHIFT_TIMEZONE = 'Asia/Beirut';

export const employeeShiftsSchema = z
  .object({
    weekStart: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((value) => {
        try {
          const date = Temporal.PlainDate.from(value, { overflow: 'reject' });
          return date.year >= 1 && date.dayOfWeek === 1;
        } catch {
          return false;
        }
      }),
    page: positiveInteger.refine((value) => value <= 1000000).default('1'),
    limit: positiveInteger.refine((value) => value <= 100).default('20'),
  })
  .strict();

export function shiftWeekBounds(weekStart: string) {
  const monday = Temporal.PlainDate.from(weekStart);
  const nextMonday = monday.add({ weeks: 1 });
  // Convert local calendar midnights independently; a DST week is not 168 hours.
  const midnight = (date: Temporal.PlainDate) =>
    new Date(
      date.toZonedDateTime({
        timeZone: SHIFT_TIMEZONE,
        plainTime: '00:00',
      }).epochMilliseconds,
    );
  return { from: midnight(monday), to: midnight(nextMonday) };
}

export type EmployeeShiftsInput = z.infer<typeof employeeShiftsSchema>;

export const employeeCheckInSchema = z
  .object({
    requestId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
  })
  .strict();
export const emptyAttendanceInput = z.object({}).strict();

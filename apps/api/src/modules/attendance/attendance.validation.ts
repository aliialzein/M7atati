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

import type { Prisma } from '../../generated/prisma/client.js';

// Shared by the HR/Admin list, manager lists/exports, and station analytics.
// History follows the attendance record's stored station, not current assignment.
export function attendanceWhere(input: {
  stationId?: number;
  employeeId?: number;
  from?: Date;
  to?: Date;
}): Prisma.AttendanceRecordWhereInput {
  return {
    ...(input.stationId !== undefined ? { stationId: input.stationId } : {}),
    ...(input.employeeId !== undefined ? { employeeId: input.employeeId } : {}),
    ...(input.to ? { clockInAt: { lt: input.to } } : {}),
    ...(input.from
      ? { OR: [{ clockOutAt: null }, { clockOutAt: { gt: input.from } }] }
      : {}),
  };
}

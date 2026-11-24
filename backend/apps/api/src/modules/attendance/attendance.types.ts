import type { Prisma } from '../../generated/prisma/client.js';

const employeeSelect = { id: true, name: true, isActive: true };
const stationSelect = { id: true, name: true, isActive: true };

export const shiftSelect = {
  id: true,
  employeeId: true,
  stationId: true,
  startsAt: true,
  endsAt: true,
  createdAt: true,
  employee: { select: employeeSelect },
  station: { select: stationSelect },
} satisfies Prisma.ShiftSelect;

export const attendanceSelect = {
  id: true,
  employeeId: true,
  stationId: true,
  clockInAt: true,
  clockOutAt: true,
  createdAt: true,
  employee: { select: employeeSelect },
  station: { select: stationSelect },
} satisfies Prisma.AttendanceRecordSelect;

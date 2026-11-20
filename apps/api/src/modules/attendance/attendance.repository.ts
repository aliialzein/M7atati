import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../database/prisma.js';
import { shiftSelect, attendanceSelect } from './attendance.types.js';
import type { ListWorkRecordsInput } from './attendance.validation.js';

export const attendanceRepository = {
  // Rows and count must see the same snapshot, even during future imports/writes.
  transaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return prisma.$transaction(work, { isolationLevel: 'RepeatableRead' });
  },
  async shifts(
    where: Prisma.ShiftWhereInput,
    input: ListWorkRecordsInput,
    tx: Prisma.TransactionClient,
  ) {
    const [shifts, total] = await Promise.all([
      tx.shift.findMany({
        where,
        select: shiftSelect,
        skip: (input.page - 1) * input.limit,
        take: input.limit,
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      }),
      tx.shift.count({ where }),
    ]);
    return { shifts, total };
  },
  async attendance(
    where: Prisma.AttendanceRecordWhereInput,
    input: ListWorkRecordsInput,
    tx: Prisma.TransactionClient,
  ) {
    const [attendance, total] = await Promise.all([
      tx.attendanceRecord.findMany({
        where,
        select: attendanceSelect,
        skip: (input.page - 1) * input.limit,
        take: input.limit,
        orderBy: [{ clockInAt: 'asc' }, { id: 'asc' }],
      }),
      tx.attendanceRecord.count({ where }),
    ]);
    return { attendance, total };
  },
};

import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../database/prisma.js';
import { HttpError } from '../../types/http-error.js';
import { shiftSelect, attendanceSelect } from './attendance.types.js';
import type { ListWorkRecordsInput } from './attendance.validation.js';

export const attendanceRepository = {
  exportAttendance(
    where: Prisma.AttendanceRecordWhereInput,
    limit: number,
    tx: Prisma.TransactionClient,
  ) {
    // One sentinel row detects an oversized selection without loading all rows.
    return tx.attendanceRecord.findMany({
      where,
      select: attendanceSelect,
      take: limit + 1,
      orderBy: [{ clockInAt: 'asc' }, { id: 'asc' }],
    });
  },
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

export const employeeRecordSelect = {
  id: true,
  employeeId: true,
  stationId: true,
  clockInAt: true,
  clockOutAt: true,
  station: { select: { id: true, name: true, isActive: true } },
} satisfies Prisma.AttendanceRecordSelect;

export const employeeAttendanceRepository = {
  async transaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await prisma.$transaction(work, {
          isolationLevel: 'Serializable',
        });
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? error.code
            : undefined;
        // Re-run the entire attempt so a uniqueness loser resolves the original
        // request key or detects a different open request, never acknowledges it.
        if (['P2034', 'P2002'].includes(String(code))) {
          if (attempt < 2) continue;
          throw new HttpError('Concurrent update; retry request', 409);
        }
        if (code === 'P2003' || code === 'P2025')
          throw new HttpError('Related record changed; retry request', 409);
        throw error;
      }
    }
  },
  async employee(id: number, tx: Prisma.TransactionClient) {
    return tx.user.findUnique({
      where: { id },
      select: {
        id: true,
        isActive: true,
        stationId: true,
        role: { select: { name: true } },
        station: { select: { id: true, name: true, isActive: true } },
      },
    });
  },
  async open(employeeId: number, tx: Prisma.TransactionClient) {
    return tx.attendanceRecord.findFirst({
      where: { employeeId, clockOutAt: null },
      select: employeeRecordSelect,
    });
  },
  async request(
    employeeId: number,
    checkInRequestId: string,
    tx: Prisma.TransactionClient,
  ) {
    return tx.attendanceRecord.findUnique({
      where: { employeeId_checkInRequestId: { employeeId, checkInRequestId } },
      select: employeeRecordSelect,
    });
  },
  async record(employeeId: number, id: number, tx: Prisma.TransactionClient) {
    return tx.attendanceRecord.findFirst({
      where: { id, employeeId },
      select: employeeRecordSelect,
    });
  },
  async create(
    employeeId: number,
    stationId: number,
    checkInRequestId: string,
    tx: Prisma.TransactionClient,
  ) {
    return tx.attendanceRecord.create({
      data: { employeeId, stationId, checkInRequestId, clockInAt: new Date() },
      select: employeeRecordSelect,
    });
  },
  async close(
    employeeId: number,
    id: number,
    clockOutAt: Date,
    tx: Prisma.TransactionClient,
  ) {
    return tx.attendanceRecord.updateMany({
      where: { id, employeeId, clockOutAt: null },
      data: { clockOutAt },
    });
  },
};

import type { Prisma } from '../../generated/prisma/client.js';
import { attendanceRepository } from './attendance.repository.js';
import type { ListWorkRecordsInput } from './attendance.validation.js';

function pagination(input: ListWorkRecordsInput, total: number) {
  return {
    page: input.page,
    limit: input.limit,
    total,
    totalPages: Math.ceil(total / input.limit),
  };
}

export class AttendanceService {
  constructor(private readonly repository = attendanceRepository) {}

  async shifts(input: ListWorkRecordsInput) {
    const where: Prisma.ShiftWhereInput = {
      ...(input.stationId !== undefined ? { stationId: input.stationId } : {}),
      ...(input.employeeId !== undefined
        ? { employeeId: input.employeeId }
        : {}),
      ...(input.to ? { startsAt: { lt: input.to } } : {}),
      ...(input.from ? { endsAt: { gt: input.from } } : {}),
    };
    return this.repository.transaction(async (tx) => {
      const { shifts, total } = await this.repository.shifts(where, input, tx);
      return { shifts, pagination: pagination(input, total) };
    });
  }

  async attendance(input: ListWorkRecordsInput) {
    const where: Prisma.AttendanceRecordWhereInput = {
      ...(input.stationId !== undefined ? { stationId: input.stationId } : {}),
      ...(input.employeeId !== undefined
        ? { employeeId: input.employeeId }
        : {}),
      ...(input.to ? { clockInAt: { lt: input.to } } : {}),
      ...(input.from
        ? { OR: [{ clockOutAt: null }, { clockOutAt: { gt: input.from } }] }
        : {}),
    };
    return this.repository.transaction(async (tx) => {
      const { attendance, total } = await this.repository.attendance(
        where,
        input,
        tx,
      );
      return { attendance, pagination: pagination(input, total) };
    });
  }
}

export const attendanceService = new AttendanceService();

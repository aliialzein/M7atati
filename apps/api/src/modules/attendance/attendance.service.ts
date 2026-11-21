import type { Prisma } from '../../generated/prisma/client.js';
import type { UserProfile } from '../auth/auth.types.js';
import { requireManagedStation } from '../../utils/accessScope.js';
import { HttpError } from '../../types/http-error.js';
import { attendanceRepository } from './attendance.repository.js';
import { attendanceWhere } from './attendance.query.js';
import type {
  AttendanceExportInput,
  ListWorkRecordsInput,
  ManagerAttendanceInput,
} from './attendance.validation.js';

export const ATTENDANCE_EXPORT_LIMIT = 5000;

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

  async managerAttendance(
    actor: UserProfile,
    stationId: number,
    input: ManagerAttendanceInput,
  ) {
    return this.repository.transaction(async (tx) => {
      await requireManagedStation(actor, stationId, tx);
      const where = attendanceWhere({ ...input, stationId });
      const { attendance, total } = await this.repository.attendance(
        where,
        input,
        tx,
      );
      return { attendance, pagination: pagination(input, total) };
    });
  }

  async managerExport(
    actor: UserProfile,
    stationId: number,
    input: AttendanceExportInput,
  ) {
    return this.repository.transaction(async (tx) => {
      const station = await requireManagedStation(actor, stationId, tx);
      const attendance = await this.repository.exportAttendance(
        attendanceWhere({ ...input, stationId }),
        ATTENDANCE_EXPORT_LIMIT,
        tx,
      );
      if (attendance.length > ATTENDANCE_EXPORT_LIMIT)
        throw new HttpError(
          `Attendance export exceeds ${ATTENDANCE_EXPORT_LIMIT} rows; narrow the date range or employee filter`,
          422,
        );
      return { station, attendance };
    });
  }

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
    const where = attendanceWhere(input);
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

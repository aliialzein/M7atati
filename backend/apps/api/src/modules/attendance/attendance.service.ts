import type { Prisma } from '../../generated/prisma/client.js';
import type { AuthContext, UserProfile } from '../auth/auth.types.js';
import { requireManagedStation } from '../../utils/accessScope.js';
import { HttpError } from '../../types/http-error.js';
import {
  attendanceRepository,
  employeeAttendanceRepository,
} from './attendance.repository.js';
import { attendanceWhere } from './attendance.query.js';
import {
  SHIFT_TIMEZONE,
  shiftWeekBounds,
  type AttendanceExportInput,
  type ListWorkRecordsInput,
  type ManagerAttendanceInput,
  type EmployeeShiftsInput,
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

export class EmployeeAttendanceService {
  constructor(private readonly repository = employeeAttendanceRepository) {}

  private async employee(context: AuthContext, tx: Prisma.TransactionClient) {
    const employee = await this.repository.employee(context.user.id, tx);
    if (!employee?.isActive) throw new HttpError('Unauthenticated', 401);
    if (employee.role.name !== 'EMPLOYEE')
      throw new HttpError('Insufficient permissions', 403);
    return employee;
  }

  current(context: AuthContext) {
    return this.repository.transaction(async (tx) => {
      const employee = await this.employee(context, tx);
      const openRecord = await this.repository.open(employee.id, tx);
      const canWrite = context.permissions.includes('attendance.self.write');
      return {
        state: openRecord ? 'CHECKED_IN' : 'CHECKED_OUT',
        openRecord,
        assignedStation: employee.station,
        canCheckIn:
          canWrite && !openRecord && employee.station?.isActive === true,
        canCheckOut: canWrite && openRecord !== null,
      };
    });
  }

  checkIn(context: AuthContext, requestId: string) {
    return this.repository.transaction(async (tx) => {
      const employee = await this.employee(context, tx);
      const original = await this.repository.request(
        employee.id,
        requestId,
        tx,
      );
      // Retry resolution precedes assignment checks, including after transfer or closure.
      if (original) return { record: original };
      if (await this.repository.open(employee.id, tx))
        throw new HttpError('Already checked in with a different request', 409);
      if (!employee.station?.isActive || employee.stationId === null)
        throw new HttpError(
          'An active assigned station is required to check in',
          409,
        );
      return {
        record: await this.repository.create(
          employee.id,
          employee.stationId,
          requestId,
          tx,
        ),
      };
    });
  }

  checkOut(context: AuthContext, recordId: number) {
    return this.repository.transaction(async (tx) => {
      const employee = await this.employee(context, tx);
      const record = await this.repository.record(employee.id, recordId, tx);
      if (!record) throw new HttpError('Attendance record not found', 404);
      if (record.clockOutAt !== null) return { record };
      const now = new Date();
      if (now < record.clockInAt)
        throw new HttpError(
          'Clock-in is in the future; attendance requires review',
          409,
        );
      await this.repository.close(employee.id, record.id, now, tx);
      return {
        record: await this.repository.record(employee.id, record.id, tx),
      };
    });
  }
}

export const employeeAttendanceService = new EmployeeAttendanceService();

export const employeeShiftsService = {
  async list(actor: UserProfile, input: EmployeeShiftsInput) {
    if (actor.role !== 'EMPLOYEE')
      throw new HttpError('Insufficient permissions', 403);
    const { from, to } = shiftWeekBounds(input.weekStart);
    return attendanceRepository.transaction(async (tx) => {
      const { shifts, total } = await attendanceRepository.shifts(
        {
          employeeId: actor.id,
          startsAt: { lt: to },
          endsAt: { gt: from },
        },
        input,
        tx,
      );
      return {
        weekStart: input.weekStart,
        timezone: SHIFT_TIMEZONE,
        from,
        to,
        shifts,
        pagination: {
          page: input.page,
          limit: input.limit,
          total,
          totalPages: Math.ceil(total / input.limit),
        },
      };
    });
  },
};

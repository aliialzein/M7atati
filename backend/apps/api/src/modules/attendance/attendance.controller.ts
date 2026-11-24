import { asyncHandler } from '../../utils/asyncHandler.js';
import { attendanceService } from './attendance.service.js';
import {
  attendanceExportSchema,
  listWorkRecordsSchema,
  managerAttendanceSchema,
} from './attendance.validation.js';
import { stationIdSchema } from '../stations/stations.validation.js';
import { attendanceCsv, attendancePdf } from './attendance.reports.js';

export const attendanceController = {
  managerList: asyncHandler(async (req, res) => {
    res.json(
      await attendanceService.managerAttendance(
        req.auth!.user,
        stationIdSchema.parse(req.params.stationId),
        managerAttendanceSchema.parse(req.query),
      ),
    );
  }),
  managerExport: asyncHandler(async (req, res) => {
    const stationId = stationIdSchema.parse(req.params.stationId);
    const input = attendanceExportSchema.parse(req.query);
    const report = await attendanceService.managerExport(
      req.auth!.user,
      stationId,
      input,
    );
    const body =
      input.format === 'csv'
        ? attendanceCsv(report.attendance)
        : await attendancePdf(report, input);
    res.attachment(`station-${stationId}-attendance.${input.format}`);
    res.type(input.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/pdf');
    res.send(body);
  }),
  shifts: asyncHandler(async (req, res) => {
    res.json(
      await attendanceService.shifts(listWorkRecordsSchema.parse(req.query)),
    );
  }),
  attendance: asyncHandler(async (req, res) => {
    res.json(
      await attendanceService.attendance(
        listWorkRecordsSchema.parse(req.query),
      ),
    );
  }),
};

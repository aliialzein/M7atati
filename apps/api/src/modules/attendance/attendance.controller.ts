import { asyncHandler } from '../../utils/asyncHandler.js';
import { attendanceService } from './attendance.service.js';
import { listWorkRecordsSchema } from './attendance.validation.js';

export const attendanceController = {
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

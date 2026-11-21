import { Router } from 'express';
import type { RequestHandler } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { positiveInteger } from '../../utils/query.validation.js';
import { HttpError } from '../../types/http-error.js';
import { attendanceController } from './attendance.controller.js';
import {
  employeeAttendanceService,
  employeeShiftsService,
} from './attendance.service.js';
import {
  employeeCheckInSchema,
  emptyAttendanceInput,
  employeeShiftsSchema,
} from './attendance.validation.js';

function readRouter(permission: string, handler: RequestHandler) {
  const router = Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use(authenticate);
  router.use((req, _res, next) => {
    if (!['ADMIN', 'HR'].includes(req.auth!.user.role))
      return next(new HttpError('Insufficient permissions', 403));
    next();
  });
  router.get('/', authorize(permission), handler);
  return router;
}

export const shiftsRouter = readRouter(
  'shifts.read',
  attendanceController.shifts,
);
export const attendanceRouter = readRouter(
  'attendance.read',
  attendanceController.attendance,
);

export const managerAttendanceRouter = Router();
managerAttendanceRouter.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
managerAttendanceRouter.use(authenticate);
managerAttendanceRouter.use((req, _res, next) => {
  if (req.auth!.user.role !== 'MANAGER')
    return next(new HttpError('Insufficient permissions', 403));
  next();
});
managerAttendanceRouter.use(authorize('attendance.read'));
managerAttendanceRouter.get(
  '/stations/:stationId/attendance',
  attendanceController.managerList,
);
managerAttendanceRouter.get(
  '/stations/:stationId/attendance/export',
  attendanceController.managerExport,
);

export const employeeAttendanceRouter = Router();
employeeAttendanceRouter.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
employeeAttendanceRouter.use(authenticate);
employeeAttendanceRouter.use((req, _res, next) => {
  if (req.auth!.user.role !== 'EMPLOYEE')
    return next(new HttpError('Insufficient permissions', 403));
  next();
});
employeeAttendanceRouter.get(
  '/current',
  authorize('attendance.read'),
  asyncHandler(async (req, res) => {
    emptyAttendanceInput.parse(req.query);
    res.json(await employeeAttendanceService.current(req.auth!));
  }),
);
employeeAttendanceRouter.post(
  '/check-in',
  authorize('attendance.self.write'),
  asyncHandler(async (req, res) => {
    emptyAttendanceInput.parse(req.query);
    const { requestId } = employeeCheckInSchema.parse(req.body);
    res.json(await employeeAttendanceService.checkIn(req.auth!, requestId));
  }),
);
employeeAttendanceRouter.post(
  '/:recordId/check-out',
  authorize('attendance.self.write'),
  asyncHandler(async (req, res) => {
    emptyAttendanceInput.parse(req.query);
    emptyAttendanceInput.parse(req.body ?? {});
    res.json(
      await employeeAttendanceService.checkOut(
        req.auth!,
        positiveInteger.parse(req.params.recordId),
      ),
    );
  }),
);

export const employeeShiftsRouter = Router();
employeeShiftsRouter.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
employeeShiftsRouter.use(authenticate);
employeeShiftsRouter.use((req, _res, next) => {
  if (req.auth!.user.role !== 'EMPLOYEE')
    return next(new HttpError('Insufficient permissions', 403));
  next();
});
employeeShiftsRouter.get(
  '/',
  authorize('shifts.read'),
  asyncHandler(async (req, res) => {
    res.json(
      await employeeShiftsService.list(
        req.auth!.user,
        employeeShiftsSchema.parse(req.query),
      ),
    );
  }),
);

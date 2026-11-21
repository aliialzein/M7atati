import cors from 'cors';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';

import { env } from './config/env.js';
import { csrfProtection } from './middleware/csrf.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { usersRouter } from './modules/users/users.routes.js';
import { stationsRouter } from './modules/stations/stations.routes.js';
import { fuelPricesRouter } from './modules/fuel-prices/fuel-prices.routes.js';
import {
  managerOrdersRouter,
  employeeOrdersRouter,
} from './modules/orders/orders.routes.js';
import { managerAnalyticsRouter } from './modules/analytics/analytics.routes.js';
import {
  employeeAttendanceRouter,
  employeeShiftsRouter,
  shiftsRouter,
  attendanceRouter,
  managerAttendanceRouter,
} from './modules/attendance/attendance.routes.js';

import { errorHandler } from './middleware/errorHandler.js';
import { notFoundHandler } from './middleware/notFound.js';
import { healthRouter } from './routes/health.js';

export const app = express();

app.use(
  cors({
    origin: env.allowedOrigins,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Protection'],
  }),
);
app.use(helmet());
app.use(cookieParser());
app.use('/api/employee/attendance', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use('/api/employee/orders', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use('/api', csrfProtection);
app.use(express.json({ limit: '16kb' }));

app.use('/api', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/employee/attendance', employeeAttendanceRouter);
app.use('/api/employee/shifts', employeeShiftsRouter);
app.use('/api/employee/orders', employeeOrdersRouter);
app.use('/api/users', usersRouter);
app.use('/api/stations', stationsRouter);
app.use('/api/fuel-prices', fuelPricesRouter);
app.use('/api/shifts', shiftsRouter);
app.use('/api/attendance', attendanceRouter);
app.use('/api/manager', managerOrdersRouter);
app.use('/api/manager', managerAnalyticsRouter);
app.use('/api/manager', managerAttendanceRouter);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;

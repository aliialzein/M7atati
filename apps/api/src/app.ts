import cors from 'cors';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';

import { env } from './config/env.js';
import { csrfProtection } from './middleware/csrf.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { usersRouter } from './modules/users/users.routes.js';

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
app.use('/api', csrfProtection);
app.use(express.json({ limit: '16kb' }));

app.use('/api', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;

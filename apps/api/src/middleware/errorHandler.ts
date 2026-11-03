import type { ErrorRequestHandler } from 'express';

import { HttpError } from '../types/http-error.js';
import { logger } from '../utils/logger.js';

export const errorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  const statusCode = error instanceof HttpError ? error.statusCode : 500;
  const message =
    error instanceof HttpError && statusCode < 500
      ? error.message
      : 'Internal Server Error';

  logger.error(`${statusCode} - ${message}`);

  res.status(statusCode).json({
    message,
  });
};

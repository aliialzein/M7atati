import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

import { HttpError } from '../types/http-error.js';
import { logger } from '../utils/logger.js';

export const errorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  const invalidRequest =
    error instanceof ZodError ||
    (error instanceof Error &&
      'type' in error &&
      [
        'entity.parse.failed',
        'entity.too.large',
        'encoding.unsupported',
        'charset.unsupported',
        'request.size.invalid',
      ].includes(String(error.type)));
  const statusCode = invalidRequest
    ? 400
    : error instanceof HttpError
      ? error.statusCode
      : 500;
  const message = invalidRequest
    ? 'Invalid request'
    : error instanceof HttpError && statusCode < 500
      ? error.message
      : 'Internal Server Error';

  logger.error(`${statusCode} - ${message}`);

  res.status(statusCode).json({
    message,
  });
};

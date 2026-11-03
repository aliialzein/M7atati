import type { NextFunction, Request, Response } from 'express';

import { HttpError } from '../types/http-error.js';

export const notFoundHandler = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  next(new HttpError(`Route not found: ${req.originalUrl}`, 404));
};

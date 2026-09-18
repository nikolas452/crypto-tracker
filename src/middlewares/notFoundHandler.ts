import type { NextFunction, Request, Response } from 'express';
import { NotFoundError } from '../lib/errors.js';

/** Registered after all routes; converts any unmatched route into a 404 AppError. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new NotFoundError(`Ruta no encontrada: ${req.method} ${req.path}`));
}

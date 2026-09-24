import type { NextFunction, Request, Response } from 'express';
import { NotFoundError } from '../lib/errors.js';

/** Se registra después de todas las rutas; convierte cualquier ruta no encontrada en un AppError 404. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new NotFoundError(`Ruta no encontrada: ${req.method} ${req.path}`));
}

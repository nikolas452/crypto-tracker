import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ForbiddenError, UnauthenticatedError } from '../lib/errors.js';
import type { UserRole } from '../modules/users/users.model.js';

/**
 * Middleware `requireRole` (spec role-authorization): exige que
 * `req.user.role` — poblado por `requireAuth`, siempre montado antes — esté
 * entre los roles aceptados, y responde 403 `FORBIDDEN` en caso contrario. El
 * rol se lee del documento recién resuelto en este mismo request, nunca de un
 * claim del token, para que un cambio de rol surta efecto en el siguiente
 * request en lugar de esperar a que el cliente refresque su token
 * (design.md). Si `req.user` no está presente (uso incorrecto, sin
 * `requireAuth` antes), se trata como no autenticado en lugar de lanzar un
 * `TypeError`.
 */
export function requireRole(...roles: readonly UserRole[]): RequestHandler {
  return function requireRoleMiddleware(req: Request, _res: Response, next: NextFunction): void {
    if (!req.user) {
      next(new UnauthenticatedError());
      return;
    }

    if (!roles.includes(req.user.role)) {
      next(new ForbiddenError());
      return;
    }

    next();
  };
}

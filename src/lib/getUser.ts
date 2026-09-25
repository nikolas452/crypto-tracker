import { UnauthenticatedError } from './errors.js';
import type { UserRecord } from '../modules/users/users.service.js';

/**
 * Accesor tipado de `req.user` (spec auth-middleware). Devuelve el perfil ya
 * poblado por `requireAuth` sin que los controladores necesiten una
 * aserción de no-nulo (`req.user!`); si se llama sobre un request que nunca
 * pasó por `requireAuth`, lanza `UnauthenticatedError` en lugar de devolver
 * `undefined` — un error de programación en una ruta se comporta igual que
 * un cliente no autenticado, nunca como un `TypeError` no controlado.
 */
export function getUser(req: { user?: UserRecord }): UserRecord {
  if (!req.user) {
    throw new UnauthenticatedError();
  }

  return req.user;
}

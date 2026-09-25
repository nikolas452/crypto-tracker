import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { UnauthenticatedError } from '../lib/errors.js';
import { resolveFromIdentity } from '../modules/users/users.service.js';
import type { VerifyOptions } from '../integrations/firebase/tokenVerifier.js';

/**
 * Middleware `requireAuth` (spec auth-middleware): exige un token de ID de
 * Firebase válido en `Authorization: Bearer <token>`, lo verifica contra el
 * `TokenVerifier` inyectado en `app.locals.tokenVerifier` (por `createApp`,
 * Fase A) y puebla `req.auth`/`req.user` antes de seguir a la siguiente
 * rama del middleware. El token se acepta ÚNICAMENTE del header
 * `Authorization`: nunca se lee de `req.query` ni `req.body`, así nunca
 * termina en un access log ni queda invisible para la redacción de pino ya
 * configurada sobre ese header (design.md).
 */

const BEARER_SCHEME_PATTERN = /^Bearer\s+(.+)$/i;

/** Cualquier token más largo que esto se rechaza sin invocar al verificador (spec auth-middleware). */
const MAX_TOKEN_LENGTH = 4096;

export type RequireAuthOptions = VerifyOptions;

/**
 * Extrae el token del header `Authorization`, exigiendo el esquema `Bearer`
 * comparado sin distinguir mayúsculas/minúsculas. Devuelve `null` cuando el
 * header falta, el esquema no es `Bearer`, o el token está vacío o es solo
 * espacios en blanco.
 */
function extractBearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) {
    return null;
  }

  const match = BEARER_SCHEME_PATTERN.exec(authorizationHeader);
  const token = match?.[1]?.trim();

  return token && token.length > 0 ? token : null;
}

/**
 * Crea el middleware `requireAuth`. `options.checkRevoked` se reenvía tal
 * cual al `TokenVerifier` (por defecto `false`; se pasa `true` para
 * operaciones destructivas o privilegiadas: `DELETE /me` y toda ruta bajo
 * `/admin` — design.md).
 */
export function requireAuth(options: RequireAuthOptions = {}): RequestHandler {
  return async function requireAuthMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const token = extractBearerToken(req.header('authorization'));

      if (!token || token.length > MAX_TOKEN_LENGTH) {
        throw new UnauthenticatedError();
      }

      const identity = await req.app.locals.tokenVerifier.verify(token, {
        checkRevoked: options.checkRevoked,
      });

      req.auth = {
        uid: identity.uid,
        email: identity.email,
        emailVerified: identity.emailVerified,
      };
      req.user = await resolveFromIdentity(identity, new Date());

      next();
    } catch (error) {
      next(error);
    }
  };
}

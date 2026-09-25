import { rateLimit, ipKeyGenerator, type RateLimitRequestHandler } from 'express-rate-limit';
import { RateLimitedError } from '../lib/errors.js';
import type { Config } from '../config/env.js';

const MINUTE_MS = 60_000;

/**
 * Limitador de tasa por uid autenticado (spec user-rate-limiting): adicional
 * al limitador global por IP (`createRateLimiter`), no en su lugar. Se
 * registra después de `requireAuth` en cada ruta protegida, así
 * `req.auth.uid` ya existe cuando se evalúa la clave — una request que falla
 * la autenticación nunca llega hasta acá, así que nunca cuenta contra ningún
 * presupuesto por usuario. El fallback a `ipKeyGenerator(req.ip)` es solo
 * defensivo (uso incorrecto sin `requireAuth` antes); `ipKeyGenerator` (en
 * lugar de `req.ip` crudo) normaliza IPv6 como recomienda express-rate-limit
 * para cualquier clave que pueda caer de vuelta en la IP.
 *
 * Se construye una única vez en `app.ts` y la misma instancia se reutiliza en
 * cada ruta autenticada (`/me`, `/admin/*`), de modo que el presupuesto por
 * uid es uno solo compartido entre todas ellas, no uno independiente por
 * ruta (spec: "esas requests comparten un presupuesto por usuario").
 */
export function createUserRateLimiter(
  config: Pick<Config, 'USER_RATE_LIMIT_PER_MIN'>,
): RateLimitRequestHandler {
  return rateLimit({
    windowMs: MINUTE_MS,
    limit: config.USER_RATE_LIMIT_PER_MIN,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.auth?.uid ?? ipKeyGenerator(req.ip ?? 'unknown'),
    handler: (_req, _res, next) => {
      next(new RateLimitedError());
    },
  });
}

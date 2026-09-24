import { rateLimit, type RateLimitRequestHandler } from 'express-rate-limit';
import { RateLimitedError } from '../lib/errors.js';
import type { Config } from '../config/env.js';

const MINUTE_MS = 60_000;

/**
 * Limitador de tasa global por IP, montado en `/api` (spec
 * api-rate-limiting). Habilita los headers de respuesta estandarizados
 * `RateLimit-*` y deshabilita los legacy `X-RateLimit-*`. Un rechazo se
 * convierte en un {@link RateLimitedError} y se pasa a `next()`, de modo que
 * fluye por el mismo manejador de errores centralizado que cualquier otro
 * error y produce el body global del proyecto `{ error: { code, message,
 * requestId } }` con `error.code: "RATE_LIMITED"` — en lugar del body por
 * defecto de la librería.
 *
 * Usa el `MemoryStore` incorporado de express-rate-limit (el que aplica por
 * defecto cuando no se pasa la opción `store`). Ese store es por proceso:
 * correr más de una instancia de la API le daría a cada instancia su propio
 * presupuesto independiente en lugar de uno compartido, multiplicando en
 * silencio el límite efectivo. Solucionarlo requiere un store compartido
 * (por ejemplo, Redis vía `rate-limit-redis`) — fuera de alcance acá; ver la
 * etapa `bullmq-redis`. Esta es también la nota que debería llevar la
 * sección de rate-limiting del README una vez que esa etapa se concrete.
 */
export function createRateLimiter(
  config: Pick<Config, 'RATE_LIMIT_MAX' | 'RATE_LIMIT_WINDOW_MIN'>,
): RateLimitRequestHandler {
  return rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW_MIN * MINUTE_MS,
    limit: config.RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, _res, next) => {
      next(new RateLimitedError());
    },
  });
}

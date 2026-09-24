import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Middleware que asigna un id único a cada request (nuevo o reutilizado del
 * header entrante) y lo expone tanto en `req.id` como en la respuesta.
 */

const REQUEST_ID_HEADER = 'x-request-id';
const MAX_REQUEST_ID_LENGTH = 128;

/**
 * `req.id` está tipado como el `ReqId` de pino-http (`string | number |
 * object`) porque las propias declaraciones de tipos de `pino-http` extienden
 * `http.IncomingMessage` globalmente (y el `Request` de Express extiende
 * `IncomingMessage`). Esta app solo le asigna un `string`; ver
 * {@link readRequestId} para el helper de acotamiento de tipo usado
 * dondequiera que un call site necesite un `string`.
 */

/**
 * Reutiliza el header `X-Request-Id` entrante cuando está presente y no
 * supera los 128 caracteres; si no, genera un nuevo UUID v4. Guarda el
 * resultado en `req.id` y lo devuelve mediante el header de respuesta
 * `X-Request-Id`.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(REQUEST_ID_HEADER);
  const id =
    incoming && incoming.length > 0 && incoming.length <= MAX_REQUEST_ID_LENGTH
      ? incoming
      : randomUUID();

  req.id = id;
  res.setHeader('X-Request-Id', id);
  next();
}

/**
 * Acota `req.id` (tipado como la unión `ReqId` de pino-http) de vuelta a
 * `string` para los call sites que lo necesitan — esta app nunca le asigna
 * otra cosa. Acepta cualquier valor con una propiedad `id` para funcionar
 * tanto con el `IncomingMessage` plano que pino-http pasa a `genReqId` como
 * con el `Request` de Express.
 */
export function readRequestId(req: { id?: unknown }): string {
  return typeof req.id === 'string' ? req.id : String(req.id ?? '');
}

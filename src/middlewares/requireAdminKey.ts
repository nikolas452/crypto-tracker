import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config/env.js';
import { NotFoundError, UnauthenticatedError } from '../lib/errors.js';

const ADMIN_KEY_HEADER = 'x-admin-key';

/**
 * Protege toda ruta bajo `/api/v1/admin` (spec admin-api-key). Explícitamente
 * provisorio — se reemplaza por autorización basada en roles autenticados en
 * una etapa posterior.
 *
 * Cuando `adminApiKey` no está configurada, toda la superficie de admin debe
 * parecer que no existe (design.md: "una superficie de admin sin configurar
 * debe ser indistinguible de una que no existe"), así que ese chequeo corre
 * primero y produce el mismo 404 `NOT_FOUND` que produciría una ruta
 * genuinamente no encontrada — antes de siquiera leer ningún header, y mucho
 * menos compararlo.
 *
 * La comparación usa `crypto.timingSafeEqual`, que lanza una excepción ante
 * un desajuste de longitud de buffer. Como la longitud en sí no es un
 * secreto que valga la pena defender (design.md), una longitud distinta se
 * rechaza directamente, sin llegar a invocarla.
 *
 * `adminApiKey` toma por defecto `config.ADMIN_API_KEY` pero se puede
 * sobrescribir — igual que el parámetro `config` de `createRateLimiter` —
 * lo que permite que los tests unitarios ejerciten cada rama (incluida la
 * no configurada) directamente, sin mutar el singleton `config`, ya
 * congelado y parseado.
 */
export function createRequireAdminKey(adminApiKey: string | undefined = config.ADMIN_API_KEY) {
  return function requireAdminKey(req: Request, _res: Response, next: NextFunction): void {
    if (!adminApiKey) {
      next(new NotFoundError(`Ruta no encontrada: ${req.method} ${req.path}`));
      return;
    }

    const supplied = req.header(ADMIN_KEY_HEADER);

    if (!supplied || supplied.length !== adminApiKey.length) {
      next(new UnauthenticatedError());
      return;
    }

    const isMatch = timingSafeEqual(Buffer.from(supplied), Buffer.from(adminApiKey));

    if (!isMatch) {
      next(new UnauthenticatedError());
      return;
    }

    next();
  };
}

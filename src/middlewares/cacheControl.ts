import type { NextFunction, Request, Response } from 'express';

/**
 * Fábricas de middleware `Cache-Control` (spec http-caching). Se aplican una
 * vez por punto de montaje en `app.ts` — el mismo patrón que `requestId` y
 * `createRateLimiter` — en lugar de repetirse dentro de cada route handler,
 * para que una ruta nueva agregada bajo un montaje existente no pueda
 * olvidarse del header.
 */

/**
 * `Cache-Control: public, max-age=<maxAgeSeconds>` para endpoints de lectura
 * cacheables (las cuatro rutas de lectura de monedas). Combinado con la
 * generación por defecto de `ETag` débil de Express (dejada habilitada —
 * tarea 10.3), que es lo que le permite a un cliente revalidar con
 * `If-None-Match` y obtener un 304 dentro de esa ventana.
 */
export function cacheControlPublic(maxAgeSeconds: number) {
  const headerValue = `public, max-age=${maxAgeSeconds}`;

  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Cache-Control', headerValue);
    next();
  };
}

/**
 * `Cache-Control: no-store` para endpoints que nunca deben cachearse: el
 * endpoint de status y toda ruta bajo `/api/v1/admin` (incluidos los 401/403
 * que producen `requireAuth`/`requireRole` — spec role-authorization).
 */
export function cacheControlNoStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  next();
}

/**
 * `Cache-Control: private, no-cache` para `GET /api/v1/me/watchlist` (spec
 * watchlist-read-api): la respuesta es de un usuario en particular y nunca
 * debe terminar en una caché compartida (`private`), pero sí puede
 * revalidarse con el cliente (`no-cache`, a diferencia de `no-store`).
 */
export function cacheControlPrivateNoCache(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'private, no-cache');
  next();
}

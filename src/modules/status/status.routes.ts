import { Router } from 'express';
import type { Db } from 'mongodb';
import { getStatus } from './status.service.js';

/**
 * `GET /api/v1/status` (spec system-status-api): público, sin clave de
 * admin. `Cache-Control: no-store` lo aplica `cacheControlNoStore` donde se
 * monta este router en `app.ts` (spec http-caching, tarea 10.2), no acá.
 * `getDb` (desde la fase 6) resuelve el handle usado para leer
 * `nextRunAt`/`disabled` del documento recurrente de `poll-prices` en
 * `agenda_jobs` — una función, no un valor, para no exigir una conexión de
 * Mongo abierta todavía en el momento de construir el router.
 */
export function createStatusRouter(getDb: () => Db): Router {
  const router = Router();

  /**
   * @openapi
   * /api/v1/status:
   *   get:
   *     tags: [status]
   *     summary: Estado operativo de la ingesta de precios
   *     description: >-
   *       Cantidad de monedas activas y estado del job recurrente de ingesta de
   *       precios (última ejecución, si está obsoleto, próxima ejecución y si está
   *       deshabilitado). No expone detalles internos de las ejecuciones. Es
   *       público y nunca se cachea (`Cache-Control: no-store`).
   *     security: []
   *     responses:
   *       '200':
   *         description: Estado actual del sistema.
   *         headers:
   *           X-Request-Id: { $ref: '#/components/headers/XRequestId' }
   *           Cache-Control: { $ref: '#/components/headers/CacheControlNoStore' }
   *           RateLimit-Policy: { $ref: '#/components/headers/RateLimitPolicy' }
   *           RateLimit-Limit: { $ref: '#/components/headers/RateLimitLimit' }
   *           RateLimit-Remaining: { $ref: '#/components/headers/RateLimitRemaining' }
   *           RateLimit-Reset: { $ref: '#/components/headers/RateLimitReset' }
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/SystemStatusResponse'
   *       '429': { $ref: '#/components/responses/RateLimited' }
   *       '500': { $ref: '#/components/responses/InternalError' }
   */
  router.get('/', async (_req, res, next) => {
    try {
      const status = await getStatus(getDb());
      res.status(200).json({ data: status });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

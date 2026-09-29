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

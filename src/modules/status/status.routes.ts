import { Router } from 'express';
import { getStatus } from './status.service.js';

/**
 * `GET /api/v1/status` (spec system-status-api): público, sin clave de
 * admin. `Cache-Control: no-store` lo aplica `cacheControlNoStore` donde se
 * monta este router en `app.ts` (spec http-caching, tarea 10.2), no acá.
 */
export function createStatusRouter(): Router {
  const router = Router();

  router.get('/', async (_req, res, next) => {
    try {
      const status = await getStatus();
      res.status(200).json({ data: status });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

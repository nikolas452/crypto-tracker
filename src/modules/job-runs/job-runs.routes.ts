import { Router } from 'express';
import { validate, NotFoundError } from '../../lib/errors.js';
import { jobRunIdParamSchema, jobRunListQuerySchema } from './job-runs.schemas.js';
import { getJobRunById, listJobRuns } from './job-runs.service.js';

/**
 * `GET /api/v1/admin/job-runs` (listado, paginado) y
 * `GET /api/v1/admin/job-runs/:id` (detalle) — spec admin-job-runs-api.
 * Montado bajo `/api/v1/admin` en `src/app.ts`, protegido por
 * `requireAdminKey`. Los route handlers solo validan la entrada y dan forma
 * a la respuesta HTTP; toda la lógica de consulta vive en
 * `job-runs.service.ts`, invocable sin ningún objeto de Express (5.9),
 * siguiendo la separación en capas de `coins.routes.ts`. `Cache-Control:
 * no-store` lo aplica `cacheControlNoStore` en el prefijo `/api/v1/admin`
 * dentro de `app.ts` (spec http-caching, tarea 10.2), no acá.
 */
export function createJobRunsRouter(): Router {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const query = validate(jobRunListQuerySchema, req.query, 'query');
      const result = await listJobRuns(query);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const params = validate(jobRunIdParamSchema, req.params, 'params');
      const run = await getJobRunById(params.id);

      if (!run) {
        throw new NotFoundError(`Job run no encontrado: ${params.id}`);
      }

      res.status(200).json({ data: run });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

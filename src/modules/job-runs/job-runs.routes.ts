import { Router } from 'express';
import { validate, NotFoundError } from '../../lib/errors.js';
import { jobRunIdParamSchema, jobRunListQuerySchema } from './job-runs.schemas.js';
import { getJobRunById, listJobRuns } from './job-runs.service.js';

/**
 * `GET /api/v1/admin/job-runs` (listado, paginado) y
 * `GET /api/v1/admin/job-runs/:id` (detalle) — spec admin-job-runs-api.
 * Montado bajo `/api/v1/admin` en `src/app.ts`, protegido por
 * `requireAuth({ checkRevoked: true })` + `requireRole('admin')` (spec
 * role-authorization; reemplazan al retirado `requireAdminKey`). Los route
 * handlers solo validan la entrada y dan forma
 * a la respuesta HTTP; toda la lógica de consulta vive en
 * `job-runs.service.ts`, invocable sin ningún objeto de Express (5.9),
 * siguiendo la separación en capas de `coins.routes.ts`. `Cache-Control:
 * no-store` lo aplica `cacheControlNoStore` en el prefijo `/api/v1/admin`
 * dentro de `app.ts` (spec http-caching, tarea 10.2), no acá.
 */
export function createJobRunsRouter(): Router {
  const router = Router();

  /**
   * @openapi
   * /api/v1/admin/job-runs:
   *   get:
   *     tags: [admin-job-runs]
   *     summary: Lista las ejecuciones de jobs
   *     description: >-
   *       Solo para administradores: el usuario debe tener el rol `admin` y se
   *       verifica si el token fue revocado. Listado paginado del historial de
   *       ejecuciones, de la más reciente a la más antigua por `startedAt`. Los
   *       filtros `from` y `to` se aplican sobre `startedAt` (ambos extremos
   *       incluidos) y `status` acepta uno o varios estados separados por coma. Las
   *       claves de query desconocidas y los estados inválidos se rechazan con
   *       `400`. La respuesta nunca se cachea (`Cache-Control: no-store`).
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - $ref: '#/components/parameters/Page'
   *       - $ref: '#/components/parameters/Limit'
   *       - name: jobName
   *         in: query
   *         required: false
   *         description: Limita el listado a un job (por ejemplo `poll-prices`).
   *         schema:
   *           type: string
   *           minLength: 1
   *       - name: status
   *         in: query
   *         required: false
   *         description: >-
   *           Estados a incluir, separados por coma (`running`, `success`,
   *           `partial`, `failed`, `skipped`). Si se omite, se devuelven todos.
   *         style: form
   *         explode: false
   *         schema:
   *           type: array
   *           minItems: 1
   *           items:
   *             $ref: '#/components/schemas/JobRunStatus'
   *         example: [failed, partial]
   *       - name: from
   *         in: query
   *         required: false
   *         description: Inicio del rango de `startedAt`, en formato ISO 8601 con zona horaria.
   *         schema:
   *           type: string
   *           format: date-time
   *       - name: to
   *         in: query
   *         required: false
   *         description: Fin del rango de `startedAt`, en formato ISO 8601 con zona horaria.
   *         schema:
   *           type: string
   *           format: date-time
   *     responses:
   *       '200':
   *         description: Página de ejecuciones.
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
   *               $ref: '#/components/schemas/JobRunListResponse'
   *       '400': { $ref: '#/components/responses/BadRequest' }
   *       '401': { $ref: '#/components/responses/Unauthorized' }
   *       '403': { $ref: '#/components/responses/Forbidden' }
   *       '429': { $ref: '#/components/responses/RateLimited' }
   *       '500': { $ref: '#/components/responses/InternalError' }
   *       '502': { $ref: '#/components/responses/FirebaseUnavailable' }
   */
  router.get('/', async (req, res, next) => {
    try {
      const query = validate(jobRunListQuerySchema, req.query, 'query');
      const result = await listJobRuns(query);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  /**
   * @openapi
   * /api/v1/admin/job-runs/{id}:
   *   get:
   *     tags: [admin-job-runs]
   *     summary: Detalle de una ejecución de job
   *     description: >-
   *       Solo para administradores: el usuario debe tener el rol `admin` y se
   *       verifica si el token fue revocado. Devuelve el registro completo de una
   *       ejecución. Un identificador con formato inválido responde `400` y uno
   *       inexistente `404`. La respuesta nunca se cachea (`Cache-Control: no-store`).
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - $ref: '#/components/parameters/JobRunId'
   *     responses:
   *       '200':
   *         description: Ejecución del job.
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
   *               $ref: '#/components/schemas/JobRunResponse'
   *       '400': { $ref: '#/components/responses/BadRequest' }
   *       '401': { $ref: '#/components/responses/Unauthorized' }
   *       '403': { $ref: '#/components/responses/Forbidden' }
   *       '404': { $ref: '#/components/responses/NotFound' }
   *       '429': { $ref: '#/components/responses/RateLimited' }
   *       '500': { $ref: '#/components/responses/InternalError' }
   *       '502': { $ref: '#/components/responses/FirebaseUnavailable' }
   */
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

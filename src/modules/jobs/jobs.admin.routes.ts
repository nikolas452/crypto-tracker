import { Router } from 'express';
import type { Db } from 'mongodb';
import { ConflictError, NotFoundError, RateLimitedError, validate } from '../../lib/errors.js';
import { getUser } from '../../lib/getUser.js';
import type { AgendaProducerHandle } from '../../scheduler/agenda.js';
import { adminJobsListQuerySchema, jobNameParamSchema } from './jobs.admin.schemas.js';
import {
  createJobTriggerRateLimiter,
  isJobDisabled,
  JOB_NAME_VALUES,
  listAdminJobs,
} from './jobs.admin.service.js';

/**
 * `GET /api/v1/admin/jobs`, `POST /api/v1/admin/jobs/:name/run`,
 * `POST /api/v1/admin/jobs/:name/{disable,enable}` (spec admin-jobs-api).
 * Montado bajo `/api/v1/admin` en `src/app.ts`, dentro del prefijo que ya
 * exige `requireAuth({ checkRevoked: true })` + `requireRole('admin')` —
 * mismo patrón que `job-runs.routes.ts`/`coins.admin.routes.ts`.
 *
 * `agenda` es la instancia PRODUCTORA construida en `src/server.ts`
 * (`role: 'producer'`): encola trabajo con `now()`/`disable()`/`enable()`
 * pero nunca lo procesa — ese es el punto de que el endpoint responda 202 y
 * no ejecute nada dentro del request (design.md: "An API that processed
 * jobs would execute them inside a request"). `getDb` resuelve el handle de
 * Mongo por request, no al construir el router — mismo motivo que en
 * `status.routes.ts`.
 */
export function createAdminJobsRouter(agenda: AgendaProducerHandle, getDb: () => Db): Router {
  const router = Router();
  const rateLimiter = createJobTriggerRateLimiter();

  function assertKnownJob(name: string): void {
    if (!JOB_NAME_VALUES.includes(name)) {
      throw new NotFoundError(`Job desconocido: ${name}`);
    }
  }

  /**
   * @openapi
   * /api/v1/admin/jobs:
   *   get:
   *     tags: [admin-jobs]
   *     summary: Lista los jobs programados
   *     description: >-
   *       Solo para administradores: el usuario debe tener el rol `admin` y se
   *       verifica si el token fue revocado. Devuelve el estado de los tres jobs
   *       recurrentes (`poll-prices`, `send-notifications` y `maintenance`) con el
   *       resumen de su última ejecución. Con `includeOneOff=true` agrega los jobs
   *       puntuales de las últimas 24 horas. Las claves de query desconocidas se
   *       rechazan con `400`. La respuesta nunca se cachea (`Cache-Control: no-store`).
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: includeOneOff
   *         in: query
   *         required: false
   *         description: Si es `true`, incluye `oneOff` en la respuesta. Por defecto, `false`.
   *         schema:
   *           type: string
   *           enum: ['true', 'false']
   *           default: 'false'
   *     responses:
   *       '200':
   *         description: Estado de los jobs.
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
   *               $ref: '#/components/schemas/JobsListResponse'
   *       '400': { $ref: '#/components/responses/BadRequest' }
   *       '401': { $ref: '#/components/responses/Unauthorized' }
   *       '403': { $ref: '#/components/responses/Forbidden' }
   *       '429': { $ref: '#/components/responses/RateLimited' }
   *       '500': { $ref: '#/components/responses/InternalError' }
   *       '502': { $ref: '#/components/responses/FirebaseUnavailable' }
   */
  router.get('/', async (req, res, next) => {
    try {
      const query = validate(adminJobsListQuerySchema, req.query, 'query');
      const result = await listAdminJobs(getDb(), query.includeOneOff);
      res.status(200).json({ data: result });
    } catch (error) {
      next(error);
    }
  });

  /**
   * @openapi
   * /api/v1/admin/jobs/{name}/run:
   *   post:
   *     tags: [admin-jobs]
   *     summary: Dispara un job de inmediato
   *     description: >-
   *       Solo para administradores: el usuario debe tener el rol `admin` y se
   *       verifica si el token fue revocado. Encola una ejecución inmediata del job
   *       y responde `202` sin esperar a que termine: la ejecución la procesa el
   *       worker. Errores de negocio: `404` si el nombre no es uno de los tres jobs
   *       conocidos; `409` (`CONFLICT`) si el job está deshabilitado; `429`
   *       (`RATE_LIMITED`) si el mismo job ya se disparó en los últimos 30 segundos
   *       (un disparo por job cada 30 s, por instancia de la API; este `429` no
   *       lleva `Retry-After`). La respuesta nunca se cachea (`Cache-Control: no-store`).
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - $ref: '#/components/parameters/JobNamePath'
   *     responses:
   *       '202':
   *         description: Ejecución encolada.
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
   *               $ref: '#/components/schemas/JobTriggerResponse'
   *       '400': { $ref: '#/components/responses/BadRequest' }
   *       '401': { $ref: '#/components/responses/Unauthorized' }
   *       '403': { $ref: '#/components/responses/Forbidden' }
   *       '404': { $ref: '#/components/responses/NotFound' }
   *       '409':
   *         description: El job está deshabilitado (`CONFLICT`).
   *         headers:
   *           X-Request-Id: { $ref: '#/components/headers/XRequestId' }
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *       '429':
   *         description: >-
   *           Se superó el límite de peticiones (`RATE_LIMITED`): el del usuario
   *           (con `Retry-After`) o el de un disparo por job cada 30 segundos (sin
   *           `Retry-After`).
   *         headers:
   *           X-Request-Id: { $ref: '#/components/headers/XRequestId' }
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *       '500': { $ref: '#/components/responses/InternalError' }
   *       '502': { $ref: '#/components/responses/FirebaseUnavailable' }
   */
  router.post('/:name/run', async (req, res, next) => {
    try {
      const params = validate(jobNameParamSchema, req.params, 'params');
      assertKnownJob(params.name);

      if (await isJobDisabled(getDb(), params.name)) {
        throw new ConflictError(`El job "${params.name}" está deshabilitado`);
      }

      if (!rateLimiter.tryTrigger(params.name)) {
        throw new RateLimitedError();
      }

      const adminUserId = getUser(req).id;
      const queuedAt = new Date();
      const job = await agenda.now(params.name, { trigger: 'api', userId: adminUserId });

      res.status(202).json({
        data: {
          agendaJobId: job.attrs._id?.toString() ?? null,
          name: params.name,
          queuedAt,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * @openapi
   * /api/v1/admin/jobs/{name}/disable:
   *   post:
   *     tags: [admin-jobs]
   *     summary: Deshabilita un job
   *     description: >-
   *       Solo para administradores: el usuario debe tener el rol `admin` y se
   *       verifica si el token fue revocado. Deshabilita el job para que deje de
   *       programarse; mientras esté deshabilitado no se puede disparar con
   *       `POST /api/v1/admin/jobs/{name}/run`. Es idempotente. Un nombre que no sea
   *       uno de los tres jobs conocidos responde `404`. La respuesta nunca se
   *       cachea (`Cache-Control: no-store`).
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - $ref: '#/components/parameters/JobNamePath'
   *     responses:
   *       '200':
   *         description: Job deshabilitado (`disabled` es `true`).
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
   *               $ref: '#/components/schemas/JobToggleResponse'
   *       '400': { $ref: '#/components/responses/BadRequest' }
   *       '401': { $ref: '#/components/responses/Unauthorized' }
   *       '403': { $ref: '#/components/responses/Forbidden' }
   *       '404': { $ref: '#/components/responses/NotFound' }
   *       '429': { $ref: '#/components/responses/RateLimited' }
   *       '500': { $ref: '#/components/responses/InternalError' }
   *       '502': { $ref: '#/components/responses/FirebaseUnavailable' }
   */
  router.post('/:name/disable', async (req, res, next) => {
    try {
      const params = validate(jobNameParamSchema, req.params, 'params');
      assertKnownJob(params.name);

      await agenda.disable({ name: params.name });

      res.status(200).json({ data: { name: params.name, disabled: true } });
    } catch (error) {
      next(error);
    }
  });

  /**
   * @openapi
   * /api/v1/admin/jobs/{name}/enable:
   *   post:
   *     tags: [admin-jobs]
   *     summary: Habilita un job
   *     description: >-
   *       Solo para administradores: el usuario debe tener el rol `admin` y se
   *       verifica si el token fue revocado. Vuelve a habilitar un job
   *       deshabilitado. Es idempotente. Un nombre que no sea uno de los tres jobs
   *       conocidos responde `404`. La respuesta nunca se cachea
   *       (`Cache-Control: no-store`).
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - $ref: '#/components/parameters/JobNamePath'
   *     responses:
   *       '200':
   *         description: Job habilitado (`disabled` es `false`).
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
   *               $ref: '#/components/schemas/JobToggleResponse'
   *       '400': { $ref: '#/components/responses/BadRequest' }
   *       '401': { $ref: '#/components/responses/Unauthorized' }
   *       '403': { $ref: '#/components/responses/Forbidden' }
   *       '404': { $ref: '#/components/responses/NotFound' }
   *       '429': { $ref: '#/components/responses/RateLimited' }
   *       '500': { $ref: '#/components/responses/InternalError' }
   *       '502': { $ref: '#/components/responses/FirebaseUnavailable' }
   */
  router.post('/:name/enable', async (req, res, next) => {
    try {
      const params = validate(jobNameParamSchema, req.params, 'params');
      assertKnownJob(params.name);

      await agenda.enable({ name: params.name });

      res.status(200).json({ data: { name: params.name, disabled: false } });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

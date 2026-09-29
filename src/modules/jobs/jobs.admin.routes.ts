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

  router.get('/', async (req, res, next) => {
    try {
      const query = validate(adminJobsListQuerySchema, req.query, 'query');
      const result = await listAdminJobs(getDb(), query.includeOneOff);
      res.status(200).json({ data: result });
    } catch (error) {
      next(error);
    }
  });

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

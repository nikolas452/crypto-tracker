import { Router, type RequestHandler } from 'express';
import { config, type Config } from '../../config/env.js';
import { validate } from '../../lib/errors.js';
import { getUser } from '../../lib/getUser.js';
import { requireAuth } from '../../middlewares/requireAuth.js';
import {
  alertIdParamSchema,
  alertListQuerySchema,
  createAlertBodySchema,
  patchAlertBodySchema,
} from './alerts.schemas.js';
import { createAlert, deleteAlert, getAlertById, listAlerts, updateAlert } from './alerts.service.js';

/**
 * `GET`/`POST /api/v1/me/alerts` y `GET`/`PATCH`/`DELETE
 * /api/v1/me/alerts/:id` (spec alert-api). Montado bajo `/api/v1/me/alerts`
 * en `src/app.ts`, con `Cache-Control: private, no-cache` aplicado a nivel
 * de router (mismo patrón que `watchlist.routes.ts` / `notifications.routes.ts`)
 * y `requireAuth()` + el limitador de tasa por uid compartido montados una
 * sola vez para las cinco rutas. Los handlers solo validan la entrada, leen
 * `getUser(req).id` (nunca un `userId` de body/query/params) y dan forma a
 * la respuesta HTTP; toda la lógica vive en `alerts.service.ts`.
 */
export function createAlertsRouter(
  userRateLimiter: RequestHandler,
  cfg: Pick<Config, 'ALERTS_MAX_ACTIVE'> = config,
): Router {
  const router = Router();

  router.use(requireAuth(), userRateLimiter);

  router.get('/', async (req, res, next) => {
    try {
      const query = validate(alertListQuerySchema, req.query, 'query');
      const result = await listAlerts(getUser(req).id, query);

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      const body = validate(createAlertBodySchema, req.body, 'body');
      const user = getUser(req);
      const result = await createAlert(user.id, user.emailVerified, body, { cfg });

      res.status(201).location(`/api/v1/me/alerts/${result.data.id}`).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const params = validate(alertIdParamSchema, req.params, 'params');
      const alert = await getAlertById(getUser(req).id, params.id);

      res.status(200).json({ data: alert });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/:id', async (req, res, next) => {
    try {
      const params = validate(alertIdParamSchema, req.params, 'params');
      const body = validate(patchAlertBodySchema, req.body, 'body');
      const alert = await updateAlert(getUser(req).id, params.id, body, { cfg });

      res.status(200).json({ data: alert });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      const params = validate(alertIdParamSchema, req.params, 'params');
      await deleteAlert(getUser(req).id, params.id);

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  return router;
}

import { Router } from 'express';
import { validate, ConflictError, NotFoundError } from '../../lib/errors.js';
import { getUser } from '../../lib/getUser.js';
import type { Mailer } from '../../integrations/mailer/mailer.types.js';
import {
  adminNotificationIdParamSchema,
  adminNotificationListQuerySchema,
  adminTestEmailBodySchema,
} from './notifications.admin.schemas.js';
import {
  listAdminNotifications,
  retryFailedNotification,
  sendAdminTestEmail,
} from './notifications.admin.service.js';

/**
 * `GET /api/v1/admin/notifications`, `POST
 * /api/v1/admin/notifications/:id/retry` y `POST
 * /api/v1/admin/notifications/test-email` (spec admin-notifications-api).
 * Montado bajo `/api/v1/admin/notifications` en `src/app.ts`, dentro del
 * prefijo `/api/v1/admin` que ya exige `requireAuth({ checkRevoked: true })`
 * + `userRateLimiter` + `requireRole('admin')` — no se repite acá, el mismo
 * patrón que `coins.admin.routes.ts`/`job-runs.routes.ts`.
 */
export function createAdminNotificationsRouter(mailer: Mailer): Router {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const query = validate(adminNotificationListQuerySchema, req.query, 'query');
      const result = await listAdminNotifications(query);

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/:id/retry', async (req, res, next) => {
    try {
      const params = validate(adminNotificationIdParamSchema, req.params, 'params');
      const adminUserId = getUser(req).id;

      const result = await retryFailedNotification(params.id, adminUserId);

      if (result.outcome === 'not_found') {
        throw new NotFoundError(`Notificación no encontrada: ${params.id}`);
      }
      if (result.outcome === 'conflict') {
        throw new ConflictError('La notificación no está en estado failed');
      }

      res.status(200).json({ data: result.dto });
    } catch (error) {
      next(error);
    }
  });

  router.post('/test-email', async (req, res, next) => {
    try {
      // Sin body requerido (spec: "no body needed", el destinatario es
      // siempre el propio admin autenticado) — `req.body` puede llegar
      // `undefined` cuando el cliente no manda `Content-Type:
      // application/json` en absoluto, así que se normaliza a `{}` antes de
      // validar en lugar de exigirle al caller ese header para un POST sin
      // payload.
      validate(adminTestEmailBodySchema, req.body ?? {}, 'body');
      const adminEmail = getUser(req).email;

      const result = await sendAdminTestEmail(adminEmail, { mailer });

      res.status(200).json({ data: result });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

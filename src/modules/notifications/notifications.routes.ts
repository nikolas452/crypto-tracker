import { Router, type RequestHandler } from 'express';
import { validate } from '../../lib/errors.js';
import { getUser } from '../../lib/getUser.js';
import { requireAuth } from '../../middlewares/requireAuth.js';
import { notificationListQuerySchema } from './notifications.schemas.js';
import { listNotificationsForUser } from './notifications.service.js';

/**
 * `GET /api/v1/me/notifications` (spec notification-outbox). Montado bajo
 * `/api/v1/me/notifications` en `src/app.ts`, con `Cache-Control: private,
 * no-cache` aplicado a nivel de router (igual que `watchlist.routes.ts`) y
 * `requireAuth()` + el limitador de tasa por uid compartido montados una
 * sola vez. El handler solo valida la entrada, lee `getUser(req).id` (nunca
 * un `userId` de query — mismo aislamiento que `watchlist.routes.ts`) y da
 * forma a la respuesta HTTP; toda la lógica vive en `notifications.service.ts`.
 */
export function createNotificationsRouter(userRateLimiter: RequestHandler): Router {
  const router = Router();

  router.use(requireAuth(), userRateLimiter);

  router.get('/', async (req, res, next) => {
    try {
      const query = validate(notificationListQuerySchema, req.query, 'query');
      const result = await listNotificationsForUser(getUser(req).id, query);

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

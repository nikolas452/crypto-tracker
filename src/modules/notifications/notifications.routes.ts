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

  /**
   * @openapi
   * /api/v1/me/notifications:
   *   get:
   *     tags: [notifications]
   *     summary: Historial de notificaciones del usuario
   *     description: >-
   *       Listado paginado de las notificaciones por email generadas por las
   *       alertas del usuario, de la más reciente a la más antigua. Es la vista del
   *       usuario: el destinatario (`to`) va enmascarado y del último error solo se
   *       expone el código. `status` admite un único valor. Las claves de query
   *       desconocidas se rechazan con `400`. La respuesta es privada y se
   *       revalida (`Cache-Control: private, no-cache`).
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - $ref: '#/components/parameters/Page'
   *       - $ref: '#/components/parameters/Limit'
   *       - name: status
   *         in: query
   *         required: false
   *         description: Filtra por estado de la notificación (un único valor).
   *         schema:
   *           $ref: '#/components/schemas/NotificationStatus'
   *     responses:
   *       '200':
   *         description: Página de notificaciones.
   *         headers:
   *           X-Request-Id: { $ref: '#/components/headers/XRequestId' }
   *           Cache-Control: { $ref: '#/components/headers/CacheControlPrivateNoCache' }
   *           RateLimit-Policy: { $ref: '#/components/headers/RateLimitPolicy' }
   *           RateLimit-Limit: { $ref: '#/components/headers/RateLimitLimit' }
   *           RateLimit-Remaining: { $ref: '#/components/headers/RateLimitRemaining' }
   *           RateLimit-Reset: { $ref: '#/components/headers/RateLimitReset' }
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/NotificationListResponse'
   *       '400': { $ref: '#/components/responses/BadRequest' }
   *       '401': { $ref: '#/components/responses/Unauthorized' }
   *       '403': { $ref: '#/components/responses/Forbidden' }
   *       '429': { $ref: '#/components/responses/RateLimited' }
   *       '500': { $ref: '#/components/responses/InternalError' }
   */
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

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

  /**
   * @openapi
   * /api/v1/admin/notifications:
   *   get:
   *     tags: [admin-notifications]
   *     summary: Lista las notificaciones (administración)
   *     description: >-
   *       Solo para administradores: el usuario debe tener el rol `admin` y se
   *       verifica si el token fue revocado. Listado paginado de las notificaciones
   *       de todos los usuarios, de la más reciente a la más antigua por
   *       `createdAt`. Es la vista administrativa: expone el último error completo y
   *       `lockedBy`; el destinatario (`to`) sigue enmascarado. Los filtros `from` y
   *       `to` se aplican sobre `createdAt` (ambos extremos incluidos) y `status`
   *       acepta uno o varios estados separados por coma. Las claves de query
   *       desconocidas y los estados inválidos se rechazan con `400`. La respuesta
   *       nunca se cachea (`Cache-Control: no-store`).
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - $ref: '#/components/parameters/Page'
   *       - $ref: '#/components/parameters/Limit'
   *       - name: status
   *         in: query
   *         required: false
   *         description: >-
   *           Estados a incluir, separados por coma (`pending`, `sending`, `sent`,
   *           `failed`, `cancelled`). Si se omite, se devuelven todos.
   *         style: form
   *         explode: false
   *         schema:
   *           type: array
   *           minItems: 1
   *           items:
   *             $ref: '#/components/schemas/NotificationStatus'
   *         example: [failed]
   *       - name: userId
   *         in: query
   *         required: false
   *         description: Limita el listado a las notificaciones de un usuario (ObjectId de 24 caracteres hexadecimales).
   *         schema:
   *           type: string
   *           pattern: '^[a-fA-F0-9]{24}$'
   *       - name: from
   *         in: query
   *         required: false
   *         description: Inicio del rango de `createdAt`, en formato ISO 8601 con zona horaria.
   *         schema:
   *           type: string
   *           format: date-time
   *       - name: to
   *         in: query
   *         required: false
   *         description: Fin del rango de `createdAt`, en formato ISO 8601 con zona horaria.
   *         schema:
   *           type: string
   *           format: date-time
   *     responses:
   *       '200':
   *         description: Página de notificaciones.
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
   *               $ref: '#/components/schemas/AdminNotificationListResponse'
   *       '400': { $ref: '#/components/responses/BadRequest' }
   *       '401': { $ref: '#/components/responses/Unauthorized' }
   *       '403': { $ref: '#/components/responses/Forbidden' }
   *       '429': { $ref: '#/components/responses/RateLimited' }
   *       '500': { $ref: '#/components/responses/InternalError' }
   *       '502': { $ref: '#/components/responses/FirebaseUnavailable' }
   */
  router.get('/', async (req, res, next) => {
    try {
      const query = validate(adminNotificationListQuerySchema, req.query, 'query');
      const result = await listAdminNotifications(query);

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  /**
   * @openapi
   * /api/v1/admin/notifications/{id}/retry:
   *   post:
   *     tags: [admin-notifications]
   *     summary: Reintenta una notificación fallida
   *     description: >-
   *       Solo para administradores: el usuario debe tener el rol `admin` y se
   *       verifica si el token fue revocado. Devuelve a `pending` una notificación
   *       en estado `failed` (reinicia `attempts` y borra `lastError`) para que el
   *       job de envío la procese de nuevo; no envía nada dentro de la petición.
   *       Errores de negocio: `404` si la notificación no existe; `409`
   *       (`CONFLICT`) si existe pero no está en estado `failed`. Un identificador
   *       con formato inválido responde `400`. La respuesta nunca se cachea
   *       (`Cache-Control: no-store`).
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - $ref: '#/components/parameters/NotificationId'
   *     responses:
   *       '200':
   *         description: Notificación reencolada (`status` es `pending`).
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
   *               $ref: '#/components/schemas/AdminNotificationResponse'
   *       '400': { $ref: '#/components/responses/BadRequest' }
   *       '401': { $ref: '#/components/responses/Unauthorized' }
   *       '403': { $ref: '#/components/responses/Forbidden' }
   *       '404': { $ref: '#/components/responses/NotFound' }
   *       '409':
   *         description: La notificación no está en estado `failed` (`CONFLICT`).
   *         headers:
   *           X-Request-Id: { $ref: '#/components/headers/XRequestId' }
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *       '429': { $ref: '#/components/responses/RateLimited' }
   *       '500': { $ref: '#/components/responses/InternalError' }
   *       '502': { $ref: '#/components/responses/FirebaseUnavailable' }
   */
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

  /**
   * @openapi
   * /api/v1/admin/notifications/test-email:
   *   post:
   *     tags: [admin-notifications]
   *     summary: Envía un email de prueba al propio administrador
   *     description: >-
   *       Solo para administradores: el usuario debe tener el rol `admin` y se
   *       verifica si el token fue revocado. Envía de inmediato un email de prueba a
   *       la dirección del administrador autenticado (nunca a un destinatario
   *       indicado por el cliente) sin pasar por el outbox ni crear
   *       notificaciones. El cuerpo es opcional y, si se envía, debe ser un objeto
   *       vacío: cualquier clave se rechaza con `400`. Errores de negocio: `422`
   *       (`UNPROCESSABLE`) con `details.reason` `NO_EMAIL_ON_FILE` si la cuenta no
   *       tiene email registrado; `502` (`UPSTREAM_ERROR`) con `details.reason`
   *       `SMTP_REJECTED` o `SMTP_UNAVAILABLE` si el servidor SMTP falla. La
   *       respuesta nunca se cachea (`Cache-Control: no-store`).
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: false
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/AdminTestEmailRequest'
   *     responses:
   *       '200':
   *         description: Email enviado.
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
   *               $ref: '#/components/schemas/AdminTestEmailResponse'
   *       '400': { $ref: '#/components/responses/BadRequest' }
   *       '401': { $ref: '#/components/responses/Unauthorized' }
   *       '403': { $ref: '#/components/responses/Forbidden' }
   *       '413': { $ref: '#/components/responses/PayloadTooLarge' }
   *       '422':
   *         description: >-
   *           La cuenta del administrador no tiene email (`UNPROCESSABLE`).
   *           `details.reason` vale `NO_EMAIL_ON_FILE`.
   *         headers:
   *           X-Request-Id: { $ref: '#/components/headers/XRequestId' }
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *             example:
   *               error:
   *                 code: UNPROCESSABLE
   *                 message: El admin no tiene un email registrado
   *                 requestId: 7c9e6679-7425-40de-944b-e07fc1f90ae7
   *                 details: { reason: NO_EMAIL_ON_FILE }
   *       '429': { $ref: '#/components/responses/RateLimited' }
   *       '500': { $ref: '#/components/responses/InternalError' }
   *       '502':
   *         description: >-
   *           Falló una dependencia externa: `UPSTREAM_ERROR` con `details.reason`
   *           `SMTP_REJECTED` o `SMTP_UNAVAILABLE` si falló el envío, o
   *           `FIREBASE_UNAVAILABLE` si Firebase no respondió al comprobar la
   *           revocación del token.
   *         headers:
   *           X-Request-Id: { $ref: '#/components/headers/XRequestId' }
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *             example:
   *               error:
   *                 code: UPSTREAM_ERROR
   *                 message: Falló el envío de prueba
   *                 requestId: 7c9e6679-7425-40de-944b-e07fc1f90ae7
   *                 details: { reason: SMTP_UNAVAILABLE }
   */
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

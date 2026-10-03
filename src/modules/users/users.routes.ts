import { Router, type RequestHandler } from 'express';
import { validate } from '../../lib/errors.js';
import { getUser } from '../../lib/getUser.js';
import { requireAuth } from '../../middlewares/requireAuth.js';
import { patchMeBodySchema } from './users.schemas.js';
import { toUserMeDto } from './users.dto.js';
import { deleteAccount, updateDisplayName } from './users.service.js';

/**
 * `GET`/`PATCH`/`DELETE /api/v1/me` (specs me-endpoints): perfil del usuario
 * autenticado. Cada ruta llama a `requireAuth` con las opciones que le
 * corresponden (`DELETE` exige `checkRevoked: true`, spec: "operación
 * destructiva" — las otras dos usan el valor por defecto `false`), así que no
 * puede montarse una única vez a nivel de router. `userRateLimiter` se recibe
 * como dependencia (en lugar de construirse acá) para que `app.ts` pase la
 * misma instancia compartida que usan las rutas de admin — un solo
 * presupuesto por uid entre todas las rutas autenticadas (spec
 * user-rate-limiting). Los handlers solo validan la entrada y dan forma a la
 * respuesta HTTP; la escritura vive en `users.service.ts`.
 */
export function createUsersRouter(userRateLimiter: RequestHandler): Router {
  const router = Router();

  /**
   * @openapi
   * /api/v1/me:
   *   get:
   *     tags: [me]
   *     summary: Perfil del usuario autenticado
   *     description: >-
   *       Devuelve el perfil del usuario dueño del token. La primera petición
   *       autenticada de una cuenta nueva crea su perfil.
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: Perfil del usuario.
   *         headers:
   *           X-Request-Id: { $ref: '#/components/headers/XRequestId' }
   *           RateLimit-Policy: { $ref: '#/components/headers/RateLimitPolicy' }
   *           RateLimit-Limit: { $ref: '#/components/headers/RateLimitLimit' }
   *           RateLimit-Remaining: { $ref: '#/components/headers/RateLimitRemaining' }
   *           RateLimit-Reset: { $ref: '#/components/headers/RateLimitReset' }
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/UserMeResponse'
   *       '401': { $ref: '#/components/responses/Unauthorized' }
   *       '403': { $ref: '#/components/responses/Forbidden' }
   *       '429': { $ref: '#/components/responses/RateLimited' }
   *       '500': { $ref: '#/components/responses/InternalError' }
   */
  router.get('/', requireAuth(), userRateLimiter, (req, res, next) => {
    try {
      res.status(200).json({ data: toUserMeDto(getUser(req)) });
    } catch (error) {
      next(error);
    }
  });

  /**
   * @openapi
   * /api/v1/me:
   *   patch:
   *     tags: [me]
   *     summary: Actualiza el nombre para mostrar
   *     description: >-
   *       Cambia `displayName`, el único campo editable del perfil. Con `null` lo
   *       borra. El cuerpo debe incluir `displayName`; las claves desconocidas
   *       (por ejemplo `email` o `role`) y el cuerpo vacío se rechazan con `400`.
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             additionalProperties: false
   *             required: [displayName]
   *             properties:
   *               displayName:
   *                 type: string
   *                 nullable: true
   *                 minLength: 1
   *                 maxLength: 50
   *                 description: Nombre nuevo (1 a 50 caracteres, se recorta) o `null` para borrarlo.
   *           example:
   *             displayName: Nicolás
   *     responses:
   *       '200':
   *         description: Perfil actualizado.
   *         headers:
   *           X-Request-Id: { $ref: '#/components/headers/XRequestId' }
   *           RateLimit-Policy: { $ref: '#/components/headers/RateLimitPolicy' }
   *           RateLimit-Limit: { $ref: '#/components/headers/RateLimitLimit' }
   *           RateLimit-Remaining: { $ref: '#/components/headers/RateLimitRemaining' }
   *           RateLimit-Reset: { $ref: '#/components/headers/RateLimitReset' }
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/UserMeResponse'
   *       '400': { $ref: '#/components/responses/BadRequest' }
   *       '401': { $ref: '#/components/responses/Unauthorized' }
   *       '403': { $ref: '#/components/responses/Forbidden' }
   *       '413': { $ref: '#/components/responses/PayloadTooLarge' }
   *       '429': { $ref: '#/components/responses/RateLimited' }
   *       '500': { $ref: '#/components/responses/InternalError' }
   */
  router.patch('/', requireAuth(), userRateLimiter, async (req, res, next) => {
    try {
      const body = validate(patchMeBodySchema, req.body, 'body');
      const currentUser = getUser(req);
      const updated = await updateDisplayName(currentUser.id, body.displayName ?? null);

      res.status(200).json({ data: toUserMeDto(updated ?? currentUser) });
    } catch (error) {
      next(error);
    }
  });

  /**
   * @openapi
   * /api/v1/me:
   *   delete:
   *     tags: [me]
   *     summary: Elimina la cuenta del usuario
   *     description: >-
   *       Borra los datos del usuario (historial de notificaciones, alertas,
   *       watchlist y perfil). Al ser una operación destructiva, se comprueba que
   *       el token no esté revocado (`TOKEN_REVOKED` si lo está; `502`
   *       `FIREBASE_UNAVAILABLE` si Firebase no responde a esa comprobación). No
   *       elimina la cuenta de Firebase: una petición posterior con un token
   *       todavía válido vuelve a crear un perfil vacío. Es idempotente en sus
   *       pasos y responde `204` sin cuerpo.
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '204': { $ref: '#/components/responses/NoContent' }
   *       '401': { $ref: '#/components/responses/Unauthorized' }
   *       '403': { $ref: '#/components/responses/Forbidden' }
   *       '429': { $ref: '#/components/responses/RateLimited' }
   *       '500': { $ref: '#/components/responses/InternalError' }
   *       '502': { $ref: '#/components/responses/FirebaseUnavailable' }
   */
  router.delete(
    '/',
    requireAuth({ checkRevoked: true }),
    userRateLimiter,
    async (req, res, next) => {
      try {
        const currentUser = getUser(req);
        // RF-4.7 / spec account-deletion-cascade: delega en el orquestador
        // en lugar de borrar el documento de `users` acá directamente, así
        // los dependientes (watchlist) se borran primero.
        await deleteAccount(currentUser.id);

        res.status(204).send();
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

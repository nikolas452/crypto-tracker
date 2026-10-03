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

  /**
   * @openapi
   * /api/v1/me/alerts:
   *   get:
   *     tags: [alerts]
   *     summary: Lista las alertas del usuario
   *     description: >-
   *       Listado paginado de las alertas del usuario, de la más reciente a la más
   *       antigua, con los datos básicos de su moneda. `status` acepta uno o varios
   *       estados separados por coma (por ejemplo `armed,triggered`). Un
   *       `coingeckoId` que no corresponde a ninguna moneda devuelve una página
   *       vacía. Las claves de query desconocidas y los estados inválidos se
   *       rechazan con `400`. La respuesta es privada y se revalida
   *       (`Cache-Control: private, no-cache`).
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - $ref: '#/components/parameters/Page'
   *       - $ref: '#/components/parameters/Limit'
   *       - name: status
   *         in: query
   *         required: false
   *         description: >-
   *           Estados a incluir, separados por coma (`armed`, `triggered`,
   *           `completed`, `disabled`). Si se omite, se devuelven todos.
   *         style: form
   *         explode: false
   *         schema:
   *           type: array
   *           minItems: 1
   *           items:
   *             $ref: '#/components/schemas/AlertStatus'
   *         example: [armed, triggered]
   *       - name: coingeckoId
   *         in: query
   *         required: false
   *         description: Limita el listado a una moneda (se normaliza a minúsculas).
   *         schema:
   *           type: string
   *           minLength: 1
   *     responses:
   *       '200':
   *         description: Página de alertas.
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
   *               $ref: '#/components/schemas/AlertListResponse'
   *       '400': { $ref: '#/components/responses/BadRequest' }
   *       '401': { $ref: '#/components/responses/Unauthorized' }
   *       '403': { $ref: '#/components/responses/Forbidden' }
   *       '429': { $ref: '#/components/responses/RateLimited' }
   *       '500': { $ref: '#/components/responses/InternalError' }
   */
  router.get('/', async (req, res, next) => {
    try {
      const query = validate(alertListQuerySchema, req.query, 'query');
      const result = await listAlerts(getUser(req).id, query);

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  /**
   * @openapi
   * /api/v1/me/alerts:
   *   post:
   *     tags: [alerts]
   *     summary: Crea una alerta
   *     description: >-
   *       Crea una alerta en estado `armed`. El cuerpo es una de tres variantes
   *       según `type` (`PRICE_ABOVE`, `PRICE_BELOW` o `CHANGE_24H_ABS_GTE`), cada
   *       una con su propio rango de `threshold`; `mode`, `cooldownMinutes`,
   *       `rearmPct` y `note` son opcionales y toman los valores por defecto del
   *       servicio. Las claves desconocidas se rechazan con `400`. No evalúa la
   *       alerta: `meta` solo informa el valor actual y si la condición ya se
   *       cumple. Errores de negocio: `422` con `details.reason`
   *       `EMAIL_NOT_VERIFIED` si el email del usuario no está verificado, o
   *       `LIMIT_REACHED` si ya tiene el máximo de alertas activas (`armed` y
   *       `triggered`); `404` si la moneda no existe o está desactivada. La
   *       respuesta `201` incluye `Location` con la ruta de la alerta.
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/AlertCreateRequest'
   *           examples:
   *             priceAbove:
   *               summary: Precio por encima del umbral
   *               value:
   *                 type: PRICE_ABOVE
   *                 coingeckoId: bitcoin
   *                 threshold: 70000
   *                 mode: once
   *             change24h:
   *               summary: Variación absoluta de 24 horas
   *               value:
   *                 type: CHANGE_24H_ABS_GTE
   *                 coingeckoId: ethereum
   *                 threshold: 5
   *                 cooldownMinutes: 120
   *                 note: Movimiento fuerte
   *     responses:
   *       '201':
   *         description: Alerta creada.
   *         headers:
   *           Location: { $ref: '#/components/headers/Location' }
   *           X-Request-Id: { $ref: '#/components/headers/XRequestId' }
   *           Cache-Control: { $ref: '#/components/headers/CacheControlPrivateNoCache' }
   *           RateLimit-Policy: { $ref: '#/components/headers/RateLimitPolicy' }
   *           RateLimit-Limit: { $ref: '#/components/headers/RateLimitLimit' }
   *           RateLimit-Remaining: { $ref: '#/components/headers/RateLimitRemaining' }
   *           RateLimit-Reset: { $ref: '#/components/headers/RateLimitReset' }
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AlertCreateResponse'
   *       '400': { $ref: '#/components/responses/BadRequest' }
   *       '401': { $ref: '#/components/responses/Unauthorized' }
   *       '403': { $ref: '#/components/responses/Forbidden' }
   *       '404':
   *         description: La moneda no existe o está desactivada.
   *         headers:
   *           X-Request-Id: { $ref: '#/components/headers/XRequestId' }
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *       '413': { $ref: '#/components/responses/PayloadTooLarge' }
   *       '422':
   *         description: >-
   *           Regla de negocio incumplida (`UNPROCESSABLE`). `details.reason` vale
   *           `EMAIL_NOT_VERIFIED` si el email no está verificado, o
   *           `LIMIT_REACHED` si el usuario ya tiene el máximo de alertas activas.
   *         headers:
   *           X-Request-Id: { $ref: '#/components/headers/XRequestId' }
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *             examples:
   *               emailNotVerified:
   *                 summary: Email sin verificar
   *                 value:
   *                   error:
   *                     code: UNPROCESSABLE
   *                     message: Verificá tu email antes de crear una alerta
   *                     requestId: 7c9e6679-7425-40de-944b-e07fc1f90ae7
   *                     details: { reason: EMAIL_NOT_VERIFIED }
   *               limitReached:
   *                 summary: Máximo de alertas activas
   *                 value:
   *                   error:
   *                     code: UNPROCESSABLE
   *                     message: Alcanzaste el límite de alertas activas
   *                     requestId: 7c9e6679-7425-40de-944b-e07fc1f90ae7
   *                     details: { reason: LIMIT_REACHED }
   *       '429': { $ref: '#/components/responses/RateLimited' }
   *       '500': { $ref: '#/components/responses/InternalError' }
   */
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

  /**
   * @openapi
   * /api/v1/me/alerts/{id}:
   *   get:
   *     tags: [alerts]
   *     summary: Detalle de una alerta
   *     description: >-
   *       Devuelve una alerta del usuario. Una alerta inexistente y una de otro
   *       usuario responden igual (`404`), para no revelar su existencia.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - $ref: '#/components/parameters/AlertId'
   *     responses:
   *       '200':
   *         description: Alerta del usuario.
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
   *               $ref: '#/components/schemas/AlertResponse'
   *       '400': { $ref: '#/components/responses/BadRequest' }
   *       '401': { $ref: '#/components/responses/Unauthorized' }
   *       '403': { $ref: '#/components/responses/Forbidden' }
   *       '404': { $ref: '#/components/responses/NotFound' }
   *       '429': { $ref: '#/components/responses/RateLimited' }
   *       '500': { $ref: '#/components/responses/InternalError' }
   */
  router.get('/:id', async (req, res, next) => {
    try {
      const params = validate(alertIdParamSchema, req.params, 'params');
      const alert = await getAlertById(getUser(req).id, params.id);

      res.status(200).json({ data: alert });
    } catch (error) {
      next(error);
    }
  });

  /**
   * @openapi
   * /api/v1/me/alerts/{id}:
   *   patch:
   *     tags: [alerts]
   *     summary: Edita una alerta
   *     description: >-
   *       Modifica los campos indicados de una alerta. El cuerpo no admite `type`
   *       (es inmutable) ni ninguna otra clave no listada, y debe incluir al menos
   *       un campo: de lo contrario responde `400`. `threshold` se valida también
   *       contra el rango del tipo ya guardado (`400` si queda fuera de rango).
   *       `enabled: false` deshabilita la alerta; `enabled: true` la vuelve a
   *       armar si estaba `disabled` o `completed`, y falla con `422` y
   *       `details.reason` `LIMIT_REACHED` si el usuario ya tiene el máximo de
   *       alertas activas. Cambiar `threshold` de una alerta `triggered` la
   *       rearma. Una alerta inexistente o de otro usuario responde `404`.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - $ref: '#/components/parameters/AlertId'
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/AlertUpdateRequest'
   *           example:
   *             threshold: 72000
   *             enabled: true
   *     responses:
   *       '200':
   *         description: Alerta actualizada.
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
   *               $ref: '#/components/schemas/AlertResponse'
   *       '400': { $ref: '#/components/responses/BadRequest' }
   *       '401': { $ref: '#/components/responses/Unauthorized' }
   *       '403': { $ref: '#/components/responses/Forbidden' }
   *       '404': { $ref: '#/components/responses/NotFound' }
   *       '413': { $ref: '#/components/responses/PayloadTooLarge' }
   *       '422':
   *         description: >-
   *           Regla de negocio incumplida (`UNPROCESSABLE`). `details.reason` vale
   *           `LIMIT_REACHED` al volver a armar una alerta cuando el usuario ya
   *           tiene el máximo de alertas activas.
   *         headers:
   *           X-Request-Id: { $ref: '#/components/headers/XRequestId' }
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *             example:
   *               error:
   *                 code: UNPROCESSABLE
   *                 message: Alcanzaste el límite de alertas activas
   *                 requestId: 7c9e6679-7425-40de-944b-e07fc1f90ae7
   *                 details: { reason: LIMIT_REACHED }
   *       '429': { $ref: '#/components/responses/RateLimited' }
   *       '500': { $ref: '#/components/responses/InternalError' }
   */
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

  /**
   * @openapi
   * /api/v1/me/alerts/{id}:
   *   delete:
   *     tags: [alerts]
   *     summary: Elimina una alerta
   *     description: >-
   *       Elimina la alerta y cancela sus notificaciones pendientes. Es
   *       idempotente: responde `204` sin cuerpo aunque la alerta no exista o sea
   *       de otro usuario.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - $ref: '#/components/parameters/AlertId'
   *     responses:
   *       '204': { $ref: '#/components/responses/NoContent' }
   *       '400': { $ref: '#/components/responses/BadRequest' }
   *       '401': { $ref: '#/components/responses/Unauthorized' }
   *       '403': { $ref: '#/components/responses/Forbidden' }
   *       '429': { $ref: '#/components/responses/RateLimited' }
   *       '500': { $ref: '#/components/responses/InternalError' }
   */
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

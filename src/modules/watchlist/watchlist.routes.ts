import { Router, type RequestHandler } from 'express';
import { config, type Config } from '../../config/env.js';
import { validate } from '../../lib/errors.js';
import { getUser } from '../../lib/getUser.js';
import { requireAuth } from '../../middlewares/requireAuth.js';
import {
  addWatchlistItemBodySchema,
  patchWatchlistItemBodySchema,
  watchlistCoinIdParamSchema,
  watchlistListQuerySchema,
} from './watchlist.schemas.js';
import {
  addWatchlistItem,
  listWatchlist,
  removeWatchlistItem,
  updateWatchlistItemNote,
} from './watchlist.service.js';

/**
 * `GET`/`POST /api/v1/me/watchlist` y `PATCH`/`DELETE
 * /api/v1/me/watchlist/:coingeckoId` (specs watchlist-read-api /
 * watchlist-write-api / user-data-isolation). Montado bajo
 * `/api/v1/me/watchlist` en `src/app.ts`, con `Cache-Control: private,
 * no-cache` aplicado a nivel de router (igual que `cacheControlPublic` /
 * `cacheControlNoStore` en otros mounts) y `requireAuth()` + el limitador de
 * tasa por uid compartido montados una sola vez para las cuatro rutas — a
 * diferencia de `users.routes.ts`, ninguna necesita `checkRevoked: true` ni
 * ninguna otra opción distinta. Los handlers solo validan la entrada, leen
 * `req.user.id` (nunca un `userId` de body/query/params — RF-4.5) y dan
 * forma a la respuesta HTTP; toda la lógica vive en `watchlist.service.ts`.
 */
export function createWatchlistRouter(
  userRateLimiter: RequestHandler,
  cfg: Pick<Config, 'WATCHLIST_MAX_ITEMS'> = config,
): Router {
  const router = Router();

  router.use(requireAuth(), userRateLimiter);

  /**
   * @openapi
   * /api/v1/me/watchlist:
   *   get:
   *     tags: [watchlist]
   *     summary: Lista la watchlist del usuario
   *     description: >-
   *       Devuelve todas las monedas que sigue el usuario, con su último precio. No
   *       se pagina: `meta` informa `count` y el máximo permitido (`max`). Admite
   *       `sort` y `order`; cualquier otra clave de query (incluidas `page` y
   *       `limit`) se rechaza con `400`. La respuesta es privada y se revalida
   *       (`Cache-Control: private, no-cache`).
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: sort
   *         in: query
   *         required: false
   *         description: Campo de orden.
   *         schema:
   *           type: string
   *           enum: [addedAt, name, change24h, marketCap]
   *           default: addedAt
   *       - name: order
   *         in: query
   *         required: false
   *         description: >-
   *           Sentido del orden. Si se omite, es `asc` para `name` y `desc` para
   *           `addedAt`, `change24h` y `marketCap`.
   *         schema:
   *           type: string
   *           enum: [asc, desc]
   *     responses:
   *       '200':
   *         description: Watchlist completa del usuario.
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
   *               $ref: '#/components/schemas/WatchlistResponse'
   *       '400': { $ref: '#/components/responses/BadRequest' }
   *       '401': { $ref: '#/components/responses/Unauthorized' }
   *       '403': { $ref: '#/components/responses/Forbidden' }
   *       '429': { $ref: '#/components/responses/RateLimited' }
   *       '500': { $ref: '#/components/responses/InternalError' }
   */
  router.get('/', async (req, res, next) => {
    try {
      const query = validate(watchlistListQuerySchema, req.query, 'query');
      const result = await listWatchlist(getUser(req).id, query, cfg);

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  /**
   * @openapi
   * /api/v1/me/watchlist:
   *   post:
   *     tags: [watchlist]
   *     summary: Agrega una moneda a la watchlist
   *     description: >-
   *       Agrega una moneda activa a la watchlist del usuario. Las claves
   *       desconocidas del cuerpo se rechazan con `400`. Errores de negocio:
   *       `404` si la moneda no existe o está desactivada; `409` si ya está en la
   *       watchlist; `422` con `details.reason` `LIMIT_REACHED` si el usuario
   *       alcanzó el máximo de monedas (`meta.max` del listado). La respuesta
   *       `201` incluye `Location` con la ruta del ítem.
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             additionalProperties: false
   *             required: [coingeckoId]
   *             properties:
   *               coingeckoId:
   *                 type: string
   *                 minLength: 1
   *                 description: Identificador de la moneda en CoinGecko, en minúsculas.
   *                 example: bitcoin
   *               note:
   *                 type: string
   *                 nullable: true
   *                 maxLength: 200
   *                 description: Nota opcional (hasta 200 caracteres, se recorta).
   *           example:
   *             coingeckoId: bitcoin
   *             note: Comprar en la próxima caída
   *     responses:
   *       '201':
   *         description: Moneda agregada.
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
   *               $ref: '#/components/schemas/WatchlistItemResponse'
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
   *       '409':
   *         description: La moneda ya está en la watchlist (`CONFLICT`).
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
   *           `LIMIT_REACHED` cuando el usuario ya tiene el máximo de monedas.
   *         headers:
   *           X-Request-Id: { $ref: '#/components/headers/XRequestId' }
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *             example:
   *               error:
   *                 code: UNPROCESSABLE
   *                 message: Alcanzaste el límite de ítems en tu watchlist
   *                 requestId: 7c9e6679-7425-40de-944b-e07fc1f90ae7
   *                 details: { reason: LIMIT_REACHED }
   *       '429': { $ref: '#/components/responses/RateLimited' }
   *       '500': { $ref: '#/components/responses/InternalError' }
   */
  router.post('/', async (req, res, next) => {
    try {
      const body = validate(addWatchlistItemBodySchema, req.body, 'body');
      const item = await addWatchlistItem(getUser(req).id, body, { cfg });

      res.status(201).location(`/api/v1/me/watchlist/${item.coingeckoId}`).json({ data: item });
    } catch (error) {
      next(error);
    }
  });

  /**
   * @openapi
   * /api/v1/me/watchlist/{coingeckoId}:
   *   patch:
   *     tags: [watchlist]
   *     summary: Edita la nota de una moneda de la watchlist
   *     description: >-
   *       Reemplaza la nota del ítem (`null` la borra). `note` es obligatoria y las
   *       claves desconocidas del cuerpo se rechazan con `400`. El identificador de
   *       la ruta se normaliza a minúsculas antes de validarse. Responde `404` si
   *       el usuario no sigue esa moneda; sigue funcionando si la moneda fue
   *       desactivada.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - $ref: '#/components/parameters/CoingeckoId'
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             additionalProperties: false
   *             required: [note]
   *             properties:
   *               note:
   *                 type: string
   *                 nullable: true
   *                 maxLength: 200
   *                 description: Nota nueva (hasta 200 caracteres, se recorta) o `null` para borrarla.
   *           example:
   *             note: Revisar el viernes
   *     responses:
   *       '200':
   *         description: Ítem actualizado.
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
   *               $ref: '#/components/schemas/WatchlistItemResponse'
   *       '400': { $ref: '#/components/responses/BadRequest' }
   *       '401': { $ref: '#/components/responses/Unauthorized' }
   *       '403': { $ref: '#/components/responses/Forbidden' }
   *       '404': { $ref: '#/components/responses/NotFound' }
   *       '413': { $ref: '#/components/responses/PayloadTooLarge' }
   *       '429': { $ref: '#/components/responses/RateLimited' }
   *       '500': { $ref: '#/components/responses/InternalError' }
   */
  router.patch('/:coingeckoId', async (req, res, next) => {
    try {
      const params = validate(watchlistCoinIdParamSchema, req.params, 'params');
      const body = validate(patchWatchlistItemBodySchema, req.body, 'body');
      const item = await updateWatchlistItemNote(getUser(req).id, params.coingeckoId, body.note);

      res.status(200).json({ data: item });
    } catch (error) {
      next(error);
    }
  });

  /**
   * @openapi
   * /api/v1/me/watchlist/{coingeckoId}:
   *   delete:
   *     tags: [watchlist]
   *     summary: Quita una moneda de la watchlist
   *     description: >-
   *       Quita la moneda de la watchlist del usuario. Es idempotente: responde
   *       `204` sin cuerpo aunque la moneda no estuviera en la watchlist o no
   *       exista. El identificador de la ruta se normaliza a minúsculas antes de
   *       validarse.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - $ref: '#/components/parameters/CoingeckoId'
   *     responses:
   *       '204': { $ref: '#/components/responses/NoContent' }
   *       '400': { $ref: '#/components/responses/BadRequest' }
   *       '401': { $ref: '#/components/responses/Unauthorized' }
   *       '403': { $ref: '#/components/responses/Forbidden' }
   *       '429': { $ref: '#/components/responses/RateLimited' }
   *       '500': { $ref: '#/components/responses/InternalError' }
   */
  router.delete('/:coingeckoId', async (req, res, next) => {
    try {
      const params = validate(watchlistCoinIdParamSchema, req.params, 'params');
      await removeWatchlistItem(getUser(req).id, params.coingeckoId);

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  return router;
}

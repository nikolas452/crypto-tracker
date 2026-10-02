import { Router } from 'express';
import { validate, NotFoundError } from '../../lib/errors.js';
import { getUser } from '../../lib/getUser.js';
import type { CoinGeckoClient } from '../../integrations/coingecko/coingecko.types.js';
import {
  adminCoinIdParamSchema,
  adminCoinListQuerySchema,
  createAdminCoinBodySchema,
  setAdminCoinActiveBodySchema,
} from './coins.admin.schemas.js';
import { createOrReactivateCoin, listAdminCoins, setCoinActive } from './coins.admin.service.js';

/**
 * `GET`/`POST /api/v1/admin/coins` y `PATCH /api/v1/admin/coins/:coingeckoId`
 * (spec admin-coin-management). Montado bajo `/api/v1/admin/coins` en
 * `src/app.ts`, dentro del prefijo `/api/v1/admin` que ya exige
 * `requireAuth({ checkRevoked: true })` + `requireRole('admin')` (spec
 * role-authorization) — no se repite acá, el mismo patrón que
 * `job-runs.routes.ts`. No existe ningún `DELETE`: las monedas nunca se
 * borran, solo se desactivan (spec: "Coins are never deleted" — un intento
 * de `DELETE` en este prefijo cae en el manejador 404 global porque no hay
 * ninguna ruta registrada para ese verbo).
 */
export function createAdminCoinsRouter(coingecko: Pick<CoinGeckoClient, 'getMarkets'>): Router {
  const router = Router();

  /**
   * @openapi
   * /api/v1/admin/coins:
   *   get:
   *     tags: [admin-coins]
   *     summary: Lista las monedas del catálogo (administración)
   *     description: >-
   *       Solo para administradores: el usuario debe tener el rol `admin` y se
   *       verifica si el token fue revocado. Listado paginado de todas las monedas,
   *       activas e inactivas, ordenado por `coingeckoId`, con la cantidad de
   *       usuarios que sigue cada una (`watchersCount`). Las claves de query
   *       desconocidas se rechazan con `400`. La respuesta nunca se cachea
   *       (`Cache-Control: no-store`).
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - $ref: '#/components/parameters/Page'
   *       - $ref: '#/components/parameters/Limit'
   *       - name: isActive
   *         in: query
   *         required: false
   *         description: Filtra por estado de la moneda. Si se omite, se devuelven todas.
   *         schema:
   *           type: string
   *           enum: ['true', 'false']
   *     responses:
   *       '200':
   *         description: Página de monedas.
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
   *               $ref: '#/components/schemas/AdminCoinListResponse'
   *       '400': { $ref: '#/components/responses/BadRequest' }
   *       '401': { $ref: '#/components/responses/Unauthorized' }
   *       '403': { $ref: '#/components/responses/Forbidden' }
   *       '429': { $ref: '#/components/responses/RateLimited' }
   *       '500': { $ref: '#/components/responses/InternalError' }
   *       '502': { $ref: '#/components/responses/FirebaseUnavailable' }
   */
  router.get('/', async (req, res, next) => {
    try {
      const query = validate(adminCoinListQuerySchema, req.query, 'query');
      const result = await listAdminCoins(query);

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  /**
   * @openapi
   * /api/v1/admin/coins:
   *   post:
   *     tags: [admin-coins]
   *     summary: Da de alta o reactiva una moneda
   *     description: >-
   *       Solo para administradores: el usuario debe tener el rol `admin` y se
   *       verifica si el token fue revocado. Valida el `coingeckoId` contra
   *       CoinGecko antes de escribir. Si la moneda no existía la crea y responde
   *       `201`; si existía inactiva la reactiva y responde `200`; ambas con la misma
   *       moneda en el cuerpo. Las claves desconocidas del cuerpo se rechazan con
   *       `400`. Errores de negocio: `409` (`CONFLICT`) si la moneda ya está activa;
   *       `422` con `details.reason` `UNKNOWN_COINGECKO_ID` si CoinGecko no
   *       reconoce el identificador; `502` (`UPSTREAM_ERROR`) si falla la consulta a
   *       CoinGecko. La respuesta nunca se cachea (`Cache-Control: no-store`).
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/AdminCoinCreateRequest'
   *           example:
   *             coingeckoId: solana
   *     responses:
   *       '201':
   *         description: Moneda creada.
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
   *               $ref: '#/components/schemas/AdminCoinResponse'
   *       '200':
   *         description: Moneda inactiva reactivada.
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
   *               $ref: '#/components/schemas/AdminCoinResponse'
   *       '400': { $ref: '#/components/responses/BadRequest' }
   *       '401': { $ref: '#/components/responses/Unauthorized' }
   *       '403': { $ref: '#/components/responses/Forbidden' }
   *       '409':
   *         description: La moneda ya está activa (`CONFLICT`).
   *         headers:
   *           X-Request-Id: { $ref: '#/components/headers/XRequestId' }
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *       '413': { $ref: '#/components/responses/PayloadTooLarge' }
   *       '422':
   *         description: >-
   *           CoinGecko no reconoce el identificador (`UNPROCESSABLE`).
   *           `details.reason` vale `UNKNOWN_COINGECKO_ID`.
   *         headers:
   *           X-Request-Id: { $ref: '#/components/headers/XRequestId' }
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   *             example:
   *               error:
   *                 code: UNPROCESSABLE
   *                 message: CoinGecko no reconoce este id
   *                 requestId: 7c9e6679-7425-40de-944b-e07fc1f90ae7
   *                 details: { reason: UNKNOWN_COINGECKO_ID }
   *       '429': { $ref: '#/components/responses/RateLimited' }
   *       '500': { $ref: '#/components/responses/InternalError' }
   *       '502':
   *         description: >-
   *           Falló una dependencia externa: `UPSTREAM_ERROR` si la consulta a
   *           CoinGecko falló, o `FIREBASE_UNAVAILABLE` si Firebase no respondió al
   *           comprobar la revocación del token.
   *         headers:
   *           X-Request-Id: { $ref: '#/components/headers/XRequestId' }
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  router.post('/', async (req, res, next) => {
    try {
      const body = validate(createAdminCoinBodySchema, req.body, 'body');
      const adminUserId = getUser(req).id;

      const { dto, created } = await createOrReactivateCoin(body.coingeckoId, adminUserId, {
        coingecko,
      });

      res.status(created ? 201 : 200).json({ data: dto });
    } catch (error) {
      next(error);
    }
  });

  /**
   * @openapi
   * /api/v1/admin/coins/{coingeckoId}:
   *   patch:
   *     tags: [admin-coins]
   *     summary: Activa o desactiva una moneda
   *     description: >-
   *       Solo para administradores: el usuario debe tener el rol `admin` y se
   *       verifica si el token fue revocado. Cambia `isActive` de la moneda; nunca
   *       se borra, y desactivarla no toca su historial ni las watchlists que la
   *       referencian. El identificador se normaliza a minúsculas. Las claves
   *       desconocidas del cuerpo se rechazan con `400`. Una moneda inexistente
   *       responde `404`. La respuesta nunca se cachea (`Cache-Control: no-store`).
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - $ref: '#/components/parameters/CoingeckoId'
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/AdminCoinSetActiveRequest'
   *           example:
   *             isActive: false
   *     responses:
   *       '200':
   *         description: Moneda actualizada.
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
   *               $ref: '#/components/schemas/AdminCoinResponse'
   *       '400': { $ref: '#/components/responses/BadRequest' }
   *       '401': { $ref: '#/components/responses/Unauthorized' }
   *       '403': { $ref: '#/components/responses/Forbidden' }
   *       '404': { $ref: '#/components/responses/NotFound' }
   *       '413': { $ref: '#/components/responses/PayloadTooLarge' }
   *       '429': { $ref: '#/components/responses/RateLimited' }
   *       '500': { $ref: '#/components/responses/InternalError' }
   *       '502': { $ref: '#/components/responses/FirebaseUnavailable' }
   */
  router.patch('/:coingeckoId', async (req, res, next) => {
    try {
      const params = validate(adminCoinIdParamSchema, req.params, 'params');
      const body = validate(setAdminCoinActiveBodySchema, req.body, 'body');
      const adminUserId = getUser(req).id;

      const dto = await setCoinActive(params.coingeckoId, body.isActive, adminUserId);

      if (!dto) {
        throw new NotFoundError(`Moneda no encontrada: ${params.coingeckoId}`);
      }

      res.status(200).json({ data: dto });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

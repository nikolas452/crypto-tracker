import { Router } from 'express';
import { validate, NotFoundError } from '../../lib/errors.js';
import { coinIdParamSchema, coinListQuerySchema } from './coins.schemas.js';
import { getCoinDetail, listCoins } from './coins.service.js';
import { historyQuerySchema, statsQuerySchema } from '../snapshots/snapshots.schemas.js';
import { getCoinHistory, getCoinStats } from '../snapshots/snapshots.service.js';

/**
 * `GET /api/v1/coins` (listado, paginado + buscable),
 * `GET /api/v1/coins/:coingeckoId` (detalle) — spec coin-read-api — más
 * `GET /api/v1/coins/:coingeckoId/history` y `.../stats` (specs
 * price-history-api / price-stats-api). Las rutas de history/stats cuelgan
 * de este mismo router en lugar de un router `mergeParams` separado:
 * comparten exactamente el mismo espacio de parámetro `:coingeckoId` que la
 * ruta de detalle, y Express solo las matchea porque llevan un segmento de
 * path extra, así que no hay ambigüedad que resolver con `/:coingeckoId`.
 * Los route handlers solo validan la entrada y dan forma a la respuesta
 * HTTP; toda la lógica de consulta vive en `coins.service.ts` /
 * `../snapshots/snapshots.service.ts`, invocable sin ningún objeto de
 * Express (5.9). `Cache-Control: public, max-age=60` lo aplica
 * `cacheControlPublic` donde se monta este router en `app.ts` (spec
 * http-caching, tarea 10.1), no acá.
 */
export function createCoinsRouter(): Router {
  const router = Router();

  /**
   * @openapi
   * /api/v1/coins:
   *   get:
   *     tags: [coins]
   *     summary: Lista las monedas activas
   *     description: >-
   *       Listado paginado de las monedas activas del catálogo, con su último precio.
   *       Admite búsqueda por prefijo de símbolo o nombre (`q`, sin distinguir
   *       mayúsculas) y orden por `sort` y `order`; las monedas sin precio quedan
   *       siempre al final. Las claves de query desconocidas se rechazan con `400`.
   *       Es público y cacheable (`Cache-Control: public, max-age=60`).
   *     security: []
   *     parameters:
   *       - $ref: '#/components/parameters/Page'
   *       - $ref: '#/components/parameters/Limit'
   *       - name: sort
   *         in: query
   *         required: false
   *         description: Campo de orden.
   *         schema:
   *           type: string
   *           enum: [marketCap, name, symbol, change24h]
   *           default: marketCap
   *       - name: order
   *         in: query
   *         required: false
   *         description: >-
   *           Sentido del orden. Si se omite, es `desc` para `marketCap` y `change24h`,
   *           y `asc` para `name` y `symbol`.
   *         schema:
   *           type: string
   *           enum: [asc, desc]
   *       - name: q
   *         in: query
   *         required: false
   *         description: Prefijo del símbolo o del nombre (1 a 50 caracteres).
   *         schema:
   *           type: string
   *           minLength: 1
   *           maxLength: 50
   *     responses:
   *       '200':
   *         description: Página de monedas.
   *         headers:
   *           X-Request-Id: { $ref: '#/components/headers/XRequestId' }
   *           Cache-Control: { $ref: '#/components/headers/CacheControlPublic' }
   *           ETag: { $ref: '#/components/headers/ETag' }
   *           RateLimit-Policy: { $ref: '#/components/headers/RateLimitPolicy' }
   *           RateLimit-Limit: { $ref: '#/components/headers/RateLimitLimit' }
   *           RateLimit-Remaining: { $ref: '#/components/headers/RateLimitRemaining' }
   *           RateLimit-Reset: { $ref: '#/components/headers/RateLimitReset' }
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/CoinListResponse'
   *       '304': { $ref: '#/components/responses/NotModified' }
   *       '400': { $ref: '#/components/responses/BadRequest' }
   *       '429': { $ref: '#/components/responses/RateLimited' }
   *       '500': { $ref: '#/components/responses/InternalError' }
   */
  router.get('/', async (req, res, next) => {
    try {
      const query = validate(coinListQuerySchema, req.query, 'query');
      const result = await listCoins(query);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  /**
   * @openapi
   * /api/v1/coins/{coingeckoId}:
   *   get:
   *     tags: [coins]
   *     summary: Detalle de una moneda
   *     description: >-
   *       Devuelve una moneda activa con su último precio y la fecha desde la que
   *       está en el catálogo. Una moneda inexistente o desactivada responde `404`.
   *       Es público y cacheable (`Cache-Control: public, max-age=60`).
   *     security: []
   *     parameters:
   *       - $ref: '#/components/parameters/CoingeckoId'
   *     responses:
   *       '200':
   *         description: Detalle de la moneda.
   *         headers:
   *           X-Request-Id: { $ref: '#/components/headers/XRequestId' }
   *           Cache-Control: { $ref: '#/components/headers/CacheControlPublic' }
   *           ETag: { $ref: '#/components/headers/ETag' }
   *           RateLimit-Policy: { $ref: '#/components/headers/RateLimitPolicy' }
   *           RateLimit-Limit: { $ref: '#/components/headers/RateLimitLimit' }
   *           RateLimit-Remaining: { $ref: '#/components/headers/RateLimitRemaining' }
   *           RateLimit-Reset: { $ref: '#/components/headers/RateLimitReset' }
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/CoinDetailResponse'
   *       '304': { $ref: '#/components/responses/NotModified' }
   *       '400': { $ref: '#/components/responses/BadRequest' }
   *       '404': { $ref: '#/components/responses/NotFound' }
   *       '429': { $ref: '#/components/responses/RateLimited' }
   *       '500': { $ref: '#/components/responses/InternalError' }
   */
  router.get('/:coingeckoId', async (req, res, next) => {
    try {
      const params = validate(coinIdParamSchema, req.params, 'params');
      const coin = await getCoinDetail(params.coingeckoId);

      if (!coin) {
        throw new NotFoundError(`Moneda no encontrada: ${params.coingeckoId}`);
      }

      res.status(200).json({ data: coin });
    } catch (error) {
      next(error);
    }
  });

  /**
   * @openapi
   * /api/v1/coins/{coingeckoId}/history:
   *   get:
   *     tags: [coins]
   *     summary: Historial de precios de una moneda
   *     description: >-
   *       Serie de precios en la ventana `from`-`to` (por defecto, los últimos 7
   *       días hasta ahora). Si se omite `interval`, se elige según el rango:
   *       `raw` hasta 2 días, `1h` hasta 30 días y `1d` por encima. Rangos máximos:
   *       7 días con `raw` (y como mucho 2000 puntos), 90 días con `1h` y 365 con
   *       `1d`; un rango mayor responde `400`. `sma` solo es válido con buckets
   *       (`1h` o `1d`), también cuando el intervalo se elige automáticamente: con
   *       `interval=raw` o con un rango que se resuelve a `raw` responde `400`.
   *       Las claves de query desconocidas se rechazan con `400`. Una moneda
   *       inexistente o desactivada responde `404`. Es público y cacheable
   *       (`Cache-Control: public, max-age=60`).
   *     security: []
   *     parameters:
   *       - $ref: '#/components/parameters/CoingeckoId'
   *       - name: from
   *         in: query
   *         required: false
   *         description: >-
   *           Inicio de la ventana (fecha y hora ISO 8601 con `Z` u offset; una hora
   *           local sin zona se rechaza). Debe ser anterior a `to`. Por defecto,
   *           7 días antes de `to`.
   *         schema:
   *           type: string
   *           format: date-time
   *       - name: to
   *         in: query
   *         required: false
   *         description: >-
   *           Fin de la ventana (fecha y hora ISO 8601 con `Z` u offset). No puede
   *           superar en más de 5 minutos al momento actual. Por defecto, ahora.
   *         schema:
   *           type: string
   *           format: date-time
   *       - name: interval
   *         in: query
   *         required: false
   *         description: Intervalo de agregación. Si se omite, se elige según el rango.
   *         schema:
   *           type: string
   *           enum: [raw, 1h, 1d]
   *       - name: sma
   *         in: query
   *         required: false
   *         description: >-
   *           Ventana de la media móvil simple sobre el `close` de cada bucket
   *           (entero de 2 a 200). No se admite con `interval=raw`.
   *         schema:
   *           type: integer
   *           minimum: 2
   *           maximum: 200
   *     responses:
   *       '200':
   *         description: Serie de puntos en orden cronológico ascendente.
   *         headers:
   *           X-Request-Id: { $ref: '#/components/headers/XRequestId' }
   *           Cache-Control: { $ref: '#/components/headers/CacheControlPublic' }
   *           ETag: { $ref: '#/components/headers/ETag' }
   *           RateLimit-Policy: { $ref: '#/components/headers/RateLimitPolicy' }
   *           RateLimit-Limit: { $ref: '#/components/headers/RateLimitLimit' }
   *           RateLimit-Remaining: { $ref: '#/components/headers/RateLimitRemaining' }
   *           RateLimit-Reset: { $ref: '#/components/headers/RateLimitReset' }
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/CoinHistoryResponse'
   *       '304': { $ref: '#/components/responses/NotModified' }
   *       '400': { $ref: '#/components/responses/BadRequest' }
   *       '404': { $ref: '#/components/responses/NotFound' }
   *       '429': { $ref: '#/components/responses/RateLimited' }
   *       '500': { $ref: '#/components/responses/InternalError' }
   */
  router.get('/:coingeckoId/history', async (req, res, next) => {
    try {
      const params = validate(coinIdParamSchema, req.params, 'params');
      const query = validate(historyQuerySchema, req.query, 'query');
      const history = await getCoinHistory(params.coingeckoId, query);

      if (!history) {
        throw new NotFoundError(`Moneda no encontrada: ${params.coingeckoId}`);
      }

      res.status(200).json({ data: history });
    } catch (error) {
      next(error);
    }
  });

  /**
   * @openapi
   * /api/v1/coins/{coingeckoId}/stats:
   *   get:
   *     tags: [coins]
   *     summary: Estadísticas de precio de una moneda
   *     description: >-
   *       Apertura, cierre, variación, mínimo, máximo y promedio del precio en la
   *       ventana `range` que termina ahora. Si no hay datos en la ventana,
   *       `samples` es 0 y el resto de las métricas son `null`. Las claves de
   *       query desconocidas se rechazan con `400`. Una moneda inexistente o
   *       desactivada responde `404`. Es público y cacheable
   *       (`Cache-Control: public, max-age=60`).
   *     security: []
   *     parameters:
   *       - $ref: '#/components/parameters/CoingeckoId'
   *       - name: range
   *         in: query
   *         required: false
   *         description: Ventana de tiempo hasta ahora.
   *         schema:
   *           type: string
   *           enum: [24h, 7d, 30d, 90d]
   *           default: 24h
   *     responses:
   *       '200':
   *         description: Estadísticas de la ventana.
   *         headers:
   *           X-Request-Id: { $ref: '#/components/headers/XRequestId' }
   *           Cache-Control: { $ref: '#/components/headers/CacheControlPublic' }
   *           ETag: { $ref: '#/components/headers/ETag' }
   *           RateLimit-Policy: { $ref: '#/components/headers/RateLimitPolicy' }
   *           RateLimit-Limit: { $ref: '#/components/headers/RateLimitLimit' }
   *           RateLimit-Remaining: { $ref: '#/components/headers/RateLimitRemaining' }
   *           RateLimit-Reset: { $ref: '#/components/headers/RateLimitReset' }
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/CoinStatsResponse'
   *       '304': { $ref: '#/components/responses/NotModified' }
   *       '400': { $ref: '#/components/responses/BadRequest' }
   *       '404': { $ref: '#/components/responses/NotFound' }
   *       '429': { $ref: '#/components/responses/RateLimited' }
   *       '500': { $ref: '#/components/responses/InternalError' }
   */
  router.get('/:coingeckoId/stats', async (req, res, next) => {
    try {
      const params = validate(coinIdParamSchema, req.params, 'params');
      const query = validate(statsQuerySchema, req.query, 'query');
      const stats = await getCoinStats(params.coingeckoId, query);

      if (!stats) {
        throw new NotFoundError(`Moneda no encontrada: ${params.coingeckoId}`);
      }

      res.status(200).json({ data: stats });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

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

  router.get('/', async (req, res, next) => {
    try {
      const query = validate(coinListQuerySchema, req.query, 'query');
      const result = await listCoins(query);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

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

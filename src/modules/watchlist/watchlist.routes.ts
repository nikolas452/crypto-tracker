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

  router.get('/', async (req, res, next) => {
    try {
      const query = validate(watchlistListQuerySchema, req.query, 'query');
      const result = await listWatchlist(getUser(req).id, query, cfg);

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      const body = validate(addWatchlistItemBodySchema, req.body, 'body');
      const item = await addWatchlistItem(getUser(req).id, body, { cfg });

      res.status(201).location(`/api/v1/me/watchlist/${item.coingeckoId}`).json({ data: item });
    } catch (error) {
      next(error);
    }
  });

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

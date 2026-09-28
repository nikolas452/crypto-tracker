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

  router.get('/', async (req, res, next) => {
    try {
      const query = validate(adminCoinListQuerySchema, req.query, 'query');
      const result = await listAdminCoins(query);

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

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

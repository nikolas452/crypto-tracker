import { z } from 'zod';
import { COINGECKO_ID_PATTERN } from './coins.model.js';

/**
 * Schemas de Zod para las rutas de administración de monedas: query de
 * listado (paginado, con filtro `isActive`), body de alta, parámetro de ruta
 * `coingeckoId` y body de activación/desactivación (spec
 * admin-coin-management).
 */

const rawAdminCoinListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    isActive: z.enum(['true', 'false']).optional(),
  })
  .strict();

export const adminCoinListQuerySchema = rawAdminCoinListQuerySchema.transform((data) => ({
  page: data.page,
  limit: data.limit,
  isActive: data.isActive === undefined ? undefined : data.isActive === 'true',
}));

export type AdminCoinListQuery = z.infer<typeof adminCoinListQuerySchema>;

/** Body estricto de `POST /api/v1/admin/coins`: un único campo, sin normalización acá (se lo pasa a minúsculas en el service antes de llamar a CoinGecko). */
export const createAdminCoinBodySchema = z
  .object({
    coingeckoId: z.string().min(1, 'coingeckoId es obligatorio'),
  })
  .strict();

export type CreateAdminCoinBody = z.infer<typeof createAdminCoinBodySchema>;

/**
 * Parámetro de ruta compartido por `PATCH /api/v1/admin/coins/:coingeckoId`.
 * Se normaliza a minúsculas antes de validar, igual que en el módulo de
 * watchlist — el modelo `coins` siempre guarda el id en minúsculas.
 */
export const adminCoinIdParamSchema = z
  .object({
    coingeckoId: z.preprocess(
      (value) => (typeof value === 'string' ? value.toLowerCase() : value),
      z.string().regex(COINGECKO_ID_PATTERN, 'Formato de coingeckoId inválido'),
    ),
  })
  .strict();

export type AdminCoinIdParam = z.infer<typeof adminCoinIdParamSchema>;

export const setAdminCoinActiveBodySchema = z
  .object({
    isActive: z.boolean(),
  })
  .strict();

export type SetAdminCoinActiveBody = z.infer<typeof setAdminCoinActiveBodySchema>;

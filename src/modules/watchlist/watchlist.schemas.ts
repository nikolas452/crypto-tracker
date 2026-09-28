import { z } from 'zod';
import { COINGECKO_ID_PATTERN } from '../coins/coins.model.js';

/**
 * Schemas de Zod para las rutas de la watchlist: query de listado, body de
 * alta, body de edición de nota y parámetro de ruta `coingeckoId`.
 */

/** Valores de `sort` aceptados por `GET /api/v1/me/watchlist` (spec watchlist-read-api). */
export const WATCHLIST_SORT_FIELDS = ['addedAt', 'name', 'change24h', 'marketCap'] as const;
export type WatchlistSortField = (typeof WATCHLIST_SORT_FIELDS)[number];

export const WATCHLIST_SORT_ORDERS = ['asc', 'desc'] as const;
export type WatchlistSortOrder = (typeof WATCHLIST_SORT_ORDERS)[number];

/**
 * `order` por defecto según `sort`, mismo patrón que `coins.schemas.ts`
 * (`DEFAULT_ORDER_BY_SORT`): más reciente/más alto primero para
 * `addedAt`/`change24h`/`marketCap`, alfabético para `name`. La spec no fija
 * un default explícito por campo, así que se elige el más útil en cada caso.
 */
const DEFAULT_ORDER_BY_SORT: Record<WatchlistSortField, WatchlistSortOrder> = {
  addedAt: 'desc',
  change24h: 'desc',
  marketCap: 'desc',
  name: 'asc',
};

/**
 * Schema de query estricto para `GET /api/v1/me/watchlist`: cualquier clave
 * fuera de `sort`/`order` falla la validación con 400 `VALIDATION_ERROR`. Sin
 * `page`/`limit` a propósito — el listado nunca pagina (spec
 * watchlist-read-api).
 */
const rawWatchlistListQuerySchema = z
  .object({
    sort: z.enum(WATCHLIST_SORT_FIELDS).default('addedAt'),
    order: z.enum(WATCHLIST_SORT_ORDERS).optional(),
  })
  .strict();

export const watchlistListQuerySchema = rawWatchlistListQuerySchema.transform((data) => ({
  ...data,
  order: data.order ?? DEFAULT_ORDER_BY_SORT[data.sort],
}));

export type WatchlistListQuery = z.infer<typeof watchlistListQuerySchema>;

/**
 * Normaliza a minúsculas antes de validar contra el patrón (spec
 * watchlist-write-api: "Coin id normalization in paths" — comparte el mismo
 * patrón que impone el modelo `coins`, así ambos nunca validan distinto).
 */
export const watchlistCoinIdParamSchema = z
  .object({
    coingeckoId: z.preprocess(
      (value) => (typeof value === 'string' ? value.toLowerCase() : value),
      z.string().regex(COINGECKO_ID_PATTERN, 'Formato de coingeckoId inválido'),
    ),
  })
  .strict();

export type WatchlistCoinIdParam = z.infer<typeof watchlistCoinIdParamSchema>;

/**
 * Body estricto de `POST /api/v1/me/watchlist` (spec watchlist-write-api).
 * `coingeckoId` no se normaliza acá (a diferencia del parámetro de ruta): un
 * id con mayúsculas simplemente no matchea ninguna moneda almacenada
 * (siempre en minúsculas) y resuelve en 404, el mismo resultado que un id
 * inexistente.
 */
export const addWatchlistItemBodySchema = z
  .object({
    coingeckoId: z.string().min(1, 'coingeckoId es obligatorio'),
    note: z
      .union([z.string().trim().max(200, 'La nota admite hasta 200 caracteres'), z.null()])
      .optional(),
  })
  .strict();

export type AddWatchlistItemBody = z.infer<typeof addWatchlistItemBodySchema>;

/**
 * Body estricto de `PATCH /api/v1/me/watchlist/:coingeckoId`: `note` es
 * obligatorio (a diferencia de `POST`, donde es opcional) — un body vacío
 * `{}` no tiene nada que actualizar y se rechaza con 400.
 */
export const patchWatchlistItemBodySchema = z
  .object({
    note: z.union([z.string().trim().max(200, 'La nota admite hasta 200 caracteres'), z.null()]),
  })
  .strict();

export type PatchWatchlistItemBody = z.infer<typeof patchWatchlistItemBodySchema>;

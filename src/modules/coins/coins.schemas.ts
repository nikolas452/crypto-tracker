import { z } from 'zod';
import { COINGECKO_ID_PATTERN } from './coins.model.js';

/**
 * Schemas de Zod para las rutas de lectura de monedas: query de listado (con
 * orden y búsqueda) y parámetro de id de ruta.
 */

/** Valores de `sort` aceptados por `GET /api/v1/coins` (spec coin-read-api). */
export const COIN_SORT_FIELDS = ['marketCap', 'name', 'symbol', 'change24h'] as const;
export type CoinSortField = (typeof COIN_SORT_FIELDS)[number];

export const COIN_SORT_ORDERS = ['asc', 'desc'] as const;
export type CoinSortOrder = (typeof COIN_SORT_ORDERS)[number];

/**
 * `order` por defecto según `sort` (spec coin-read-api: "order... por
 * defecto desc para marketCap y change24h y asc para name y symbol"): valor
 * más alto primero para los campos numéricos, alfabético para los de texto.
 */
const DEFAULT_ORDER_BY_SORT: Record<CoinSortField, CoinSortOrder> = {
  marketCap: 'desc',
  change24h: 'desc',
  name: 'asc',
  symbol: 'asc',
};

/**
 * Schema de query estricto para `GET /api/v1/coins`: cualquier clave que no
 * sea `page`, `limit`, `sort`, `order` o `q` falla la validación (spec
 * coin-read-api: "Cualquier parámetro de query desconocido DEBE producir un
 * 400 VALIDATION_ERROR"). El valor por defecto de `order` depende del `sort`
 * ya resuelto, así que se aplica en el `.transform()` de abajo en lugar de
 * un default de Zod por campo.
 */
const rawCoinListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    sort: z.enum(COIN_SORT_FIELDS).default('marketCap'),
    order: z.enum(COIN_SORT_ORDERS).optional(),
    q: z.string().min(1).max(50).optional(),
  })
  .strict();

export const coinListQuerySchema = rawCoinListQuerySchema.transform((data) => ({
  ...data,
  order: data.order ?? DEFAULT_ORDER_BY_SORT[data.sort],
}));

export type CoinListQuery = z.infer<typeof coinListQuerySchema>;

/**
 * Schema del parámetro de ruta para `GET /api/v1/coins/:coingeckoId`.
 * Reutiliza exactamente el patrón que impone el modelo `coins` (5.5: "el
 * mismo patrón que impone el modelo de coins") para que ambos nunca validen
 * de forma distinta.
 */
export const coinIdParamSchema = z
  .object({
    coingeckoId: z.string().regex(COINGECKO_ID_PATTERN, 'Formato de coingeckoId inválido'),
  })
  .strict();

export type CoinIdParam = z.infer<typeof coinIdParamSchema>;

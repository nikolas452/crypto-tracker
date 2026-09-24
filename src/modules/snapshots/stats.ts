/**
 * Rangos de estadísticas aceptados y el cálculo del porcentaje de cambio
 * para el endpoint de estadísticas de precios.
 */

/** Valores de `range` aceptados por `GET /api/v1/coins/:coingeckoId/stats` (spec price-stats-api). */
export const STATS_RANGES = ['24h', '7d', '30d', '90d'] as const;
export type StatsRange = (typeof STATS_RANGES)[number];

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Duración del rango en milisegundos, terminando en el momento actual (spec price-stats-api). */
export const STATS_RANGE_MS: Record<StatsRange, number> = {
  '24h': 24 * HOUR_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
  '90d': 90 * DAY_MS,
};

/**
 * `changePct = (close - open) / open × 100`, redondeado a 4 decimales (spec
 * price-stats-api). Pura — sin DB, sin HTTP.
 */
export function computeChangePct(open: number, close: number): number {
  const raw = ((close - open) / open) * 100;
  return Math.round(raw * 10000) / 10000;
}

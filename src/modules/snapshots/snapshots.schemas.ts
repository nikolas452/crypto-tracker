import { z } from 'zod';
import { HISTORY_INTERVALS } from './interval.js';
import { STATS_RANGES, STATS_RANGE_MS } from './stats.js';

/**
 * Schemas de query de Zod para los endpoints de historial y estadísticas de
 * precios: validación estricta más las transformaciones que resuelven
 * defaults y reglas cruzadas entre campos.
 */

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Schema de query estricto para `GET /api/v1/coins/:coingeckoId/history`
 * (spec price-history-api). `from`/`to` deben llevar una `Z` UTC explícita o
 * un offset — un datetime local sin más se rechaza. Las reglas entre campos
 * (`from` < `to`, `to` no más de 5 minutos en el futuro, `sma` solo con un
 * `interval` en buckets) se imponen en el `.transform()` de abajo vía
 * `ctx.addIssue`, y el mismo paso resuelve los defaults de `from`/`to` y da
 * forma a la salida como `Date`s.
 */
const rawHistoryQuerySchema = z
  .object({
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    interval: z.enum(HISTORY_INTERVALS).optional(),
    sma: z.coerce.number().int().min(2).max(200).optional(),
  })
  .strict();

export const historyQuerySchema = rawHistoryQuerySchema.transform((data, ctx) => {
  const to = data.to ? new Date(data.to) : new Date();
  const from = data.from ? new Date(data.from) : new Date(to.getTime() - SEVEN_DAYS_MS);

  if (!(from.getTime() < to.getTime())) {
    ctx.addIssue({
      code: 'custom',
      path: ['from'],
      message: 'from debe ser estrictamente anterior a to',
    });
  }

  if (to.getTime() - Date.now() > FIVE_MINUTES_MS) {
    ctx.addIssue({
      code: 'custom',
      path: ['to'],
      message: 'to no puede ser más de 5 minutos posterior al momento actual',
    });
  }

  if (data.sma !== undefined && data.interval === 'raw') {
    ctx.addIssue({
      code: 'custom',
      path: ['sma'],
      message: 'sma solo puede usarse junto con interval=1h o interval=1d',
    });
  }

  return { from, to, interval: data.interval, sma: data.sma };
});

export type HistoryQuery = z.infer<typeof historyQuerySchema>;

/**
 * Schema de query estricto para `GET /api/v1/coins/:coingeckoId/stats`
 * (spec price-stats-api). `from`/`to` se derivan de `range`, terminando en
 * el momento actual, al momento de parsear.
 */
export const statsQuerySchema = z
  .object({
    range: z.enum(STATS_RANGES).default('24h'),
  })
  .strict()
  .transform((data) => {
    const to = new Date();
    const from = new Date(to.getTime() - STATS_RANGE_MS[data.range]);
    return { range: data.range, from, to };
  });

export type StatsQuery = z.infer<typeof statsQuerySchema>;

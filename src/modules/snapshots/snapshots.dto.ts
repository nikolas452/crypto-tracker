import type { HistoryInterval } from './interval.js';
import type { StatsRange } from './stats.js';

/**
 * DTOs de respuesta para los endpoints de historial y estadísticas de
 * precios de una moneda.
 */

export interface RawHistoryPointDto {
  readonly t: Date;
  readonly priceUsd: number;
  readonly marketCapUsd: number | null;
  readonly volume24hUsd: number | null;
  readonly change24hPct: number | null;
}

export interface BucketedHistoryPointDto {
  readonly t: Date;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly avg: number;
  readonly samples: number;
  readonly sma?: number | null;
}

export type HistoryPointDto = RawHistoryPointDto | BucketedHistoryPointDto;

/** Forma de la respuesta de `GET /api/v1/coins/:coingeckoId/history` (spec price-history-api). */
export interface HistoryResponseDto {
  readonly coingeckoId: string;
  readonly interval: HistoryInterval;
  readonly from: Date;
  readonly to: Date;
  readonly points: readonly HistoryPointDto[];
}

/** Forma de la respuesta de `GET /api/v1/coins/:coingeckoId/stats` (spec price-stats-api). */
export interface StatsResponseDto {
  readonly coingeckoId: string;
  readonly range: StatsRange;
  readonly from: Date;
  readonly to: Date;
  readonly open: number | null;
  readonly close: number | null;
  readonly changePct: number | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly avg: number | null;
  readonly samples: number;
  readonly firstAt: Date | null;
  readonly lastAt: Date | null;
}

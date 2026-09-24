import { ValidationError } from '../../lib/errors.js';

/**
 * Selección y validación del intervalo de bucket para el endpoint de
 * historial de precios: auto-selección por rango y límites máximos por
 * intervalo.
 */

/** Valores de `interval` aceptados por `GET /api/v1/coins/:coingeckoId/history` (spec price-history-api). */
export const HISTORY_INTERVALS = ['raw', '1h', '1d'] as const;
export type HistoryInterval = (typeof HISTORY_INTERVALS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Umbrales de auto-selección (spec price-history-api: "raw para 2 días o menos, 1h para 30 días o menos"). */
const AUTO_SELECT_RAW_MAX_MS = 2 * DAY_MS;
const AUTO_SELECT_1H_MAX_MS = 30 * DAY_MS;

/**
 * Selecciona el intervalo de bucket a partir del rango solicitado cuando el
 * cliente omite `interval` (spec price-history-api / design.md: "una función
 * pura, separada de la ruta" para que E2-9 sea un test unitario en lugar de
 * un round trip HTTP). Sin DB, sin HTTP.
 */
export function selectInterval(from: Date, to: Date): HistoryInterval {
  const rangeMs = to.getTime() - from.getTime();

  if (rangeMs <= AUTO_SELECT_RAW_MAX_MS) {
    return 'raw';
  }
  if (rangeMs <= AUTO_SELECT_1H_MAX_MS) {
    return '1h';
  }
  return '1d';
}

/** Rango máximo solicitable por intervalo, en días (spec price-history-api). */
const MAX_RANGE_DAYS: Record<HistoryInterval, number> = {
  raw: 7,
  '1h': 90,
  '1d': 365,
};

/** El siguiente intervalo más grueso a sugerir cuando se rechaza un rango; `1d` no tiene ninguno. */
const COARSER_INTERVAL: Record<HistoryInterval, HistoryInterval | null> = {
  raw: '1h',
  '1h': '1d',
  '1d': null,
};

/**
 * Impone el rango máximo de cada intervalo (spec price-history-api), lanzando
 * un `VALIDATION_ERROR` cuyo mensaje nombra un intervalo más grueso a usar en
 * su lugar. Pura — sin DB, sin HTTP (design.md).
 */
export function assertRangeAllowed(interval: HistoryInterval, from: Date, to: Date): void {
  const rangeMs = to.getTime() - from.getTime();
  const maxDays = MAX_RANGE_DAYS[interval];
  const maxMs = maxDays * DAY_MS;

  if (rangeMs > maxMs) {
    const coarser = COARSER_INTERVAL[interval];
    const suggestion = coarser ? ` Use interval=${coarser} instead.` : '';
    throw new ValidationError(
      `El rango solicitado supera el máximo de ${maxDays} días para interval=${interval}.${suggestion}`,
    );
  }
}

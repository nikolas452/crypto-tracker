/**
 * Función pura de decisión de la máquina de estados de alertas (spec
 * alert-store): dado el estado actual de una alerta, el valor de mercado
 * evaluado y el instante actual, decide qué transición corresponde. Sin
 * DB, sin HTTP, sin Mongoose — mismo estilo que `sma.ts`/`stats.ts` del
 * módulo de snapshots. El caller (job de evaluación, fase posterior) es
 * quien traduce el resultado a una escritura real, incluida la rama
 * once-vs-recurring de un TRIGGER (`decide()` nunca la decide).
 */

/** Los tres tipos de alerta soportados (mismos valores que `AlertType` en `alerts.model.ts`). */
export type AlertConditionType = 'PRICE_ABOVE' | 'PRICE_BELOW' | 'CHANGE_24H_ABS_GTE';

/** Los cuatro estados de una alerta (mismos valores que `AlertStatus` en `alerts.model.ts`). */
export type AlertConditionStatus = 'armed' | 'triggered' | 'completed' | 'disabled';

/** Las cuatro decisiones posibles de `decide()`. */
export type Decision = 'TRIGGER' | 'REARM' | 'COOLDOWN' | 'NOOP';

/** Subconjunto de campos de una alerta que necesita `decide()` para resolver una decisión. */
export interface AlertDecisionInput {
  readonly type: AlertConditionType;
  readonly status: AlertConditionStatus;
  readonly threshold: number;
  readonly rearmPct: number;
  readonly cooldownMinutes: number;
  readonly lastTriggeredAt: Date | null;
}

/** Lo que el job de evaluación tiene a mano tras cada corrida de poll-prices. */
export interface AlertValue {
  readonly priceUsd: number;
  readonly change24hPct: number | null;
}

/**
 * Condición de disparo por tipo (spec alert-store, límite inclusivo en
 * ambos extremos). Para `CHANGE_24H_ABS_GTE`, un `change24hPct` `null`
 * significa "todavía no evaluable" — nunca dispara.
 */
export function isTriggerConditionMet(
  type: AlertConditionType,
  threshold: number,
  value: AlertValue,
): boolean {
  switch (type) {
    case 'PRICE_ABOVE':
      return value.priceUsd >= threshold;
    case 'PRICE_BELOW':
      return value.priceUsd <= threshold;
    case 'CHANGE_24H_ABS_GTE':
      if (value.change24hPct === null) {
        return false;
      }
      return Math.abs(value.change24hPct) >= threshold;
  }
}

/**
 * Condición de rearme con histéresis (spec alert-store), solo relevante
 * cuando la alerta está `triggered`. Mismo guard de `null` que la condición
 * de disparo: sin `change24hPct`, una alerta `CHANGE_24H_ABS_GTE` nunca
 * rearma sola (queda `triggered` hasta la próxima evaluación con dato).
 */
export function isRearmConditionMet(
  type: AlertConditionType,
  threshold: number,
  rearmPct: number,
  value: AlertValue,
): boolean {
  switch (type) {
    case 'PRICE_ABOVE':
      return value.priceUsd < threshold * (1 - rearmPct / 100);
    case 'PRICE_BELOW':
      return value.priceUsd > threshold * (1 + rearmPct / 100);
    case 'CHANGE_24H_ABS_GTE':
      if (value.change24hPct === null) {
        return false;
      }
      return Math.abs(value.change24hPct) < Math.max(0, threshold - rearmPct);
  }
}

const MINUTE_MS = 60 * 1000;

/**
 * `true` cuando todavía no pasaron `cooldownMinutes` desde `lastTriggeredAt`
 * (spec alert-store). Sin disparo previo (`null`), nunca hay cooldown.
 */
export function isWithinCooldown(
  lastTriggeredAt: Date | null,
  cooldownMinutes: number,
  now: Date,
): boolean {
  if (lastTriggeredAt === null) {
    return false;
  }
  const elapsedMinutes = (now.getTime() - lastTriggeredAt.getTime()) / MINUTE_MS;
  return elapsedMinutes < cooldownMinutes;
}

/**
 * Árbol de decisión completo de la máquina de estados de alertas (spec
 * alert-store):
 * - `disabled`/`completed`: nunca se evalúan -> NOOP.
 * - `triggered`: solo importa la condición de rearme -> REARM o NOOP.
 * - `armed`: condición de disparo -> si no se cumple, NOOP; si se cumple,
 *   cooldown -> COOLDOWN o TRIGGER.
 */
export function decide(alert: AlertDecisionInput, value: AlertValue, now: Date): Decision {
  if (alert.status === 'disabled' || alert.status === 'completed') {
    return 'NOOP';
  }

  if (alert.status === 'triggered') {
    return isRearmConditionMet(alert.type, alert.threshold, alert.rearmPct, value)
      ? 'REARM'
      : 'NOOP';
  }

  // alert.status === 'armed'
  if (!isTriggerConditionMet(alert.type, alert.threshold, value)) {
    return 'NOOP';
  }

  return isWithinCooldown(alert.lastTriggeredAt, alert.cooldownMinutes, now)
    ? 'COOLDOWN'
    : 'TRIGGER';
}

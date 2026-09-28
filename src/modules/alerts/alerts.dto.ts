import type { Types } from 'mongoose';
import type { LatestDto } from '../coins/coins.dto.js';
import type { AlertMode, AlertStatus, AlertType } from './alerts.model.js';

/**
 * DTOs de salida del módulo de alertas y los builders que los arman a partir
 * de un registro de `alerts` ya combinado con el `coingeckoId` de su moneda.
 * Explícito campo por campo (design.md: "los DTOs de salida son explícitos,
 * no transforms de `toJSON`") — nunca incluye `userId`, `coinId` ni el `_id`
 * de Mongo tal cual: la alerta se identifica por `id` (string) y la moneda
 * por `coingeckoId`, nunca por su ObjectId interno.
 */

export interface AlertDto {
  readonly id: string;
  readonly coingeckoId: string;
  readonly type: AlertType;
  readonly threshold: number;
  readonly mode: AlertMode;
  readonly status: AlertStatus;
  readonly cooldownMinutes: number;
  readonly rearmPct: number;
  readonly note: string | null;
  readonly version: number;
  readonly triggerCount: number;
  readonly lastTriggeredAt: Date | null;
  readonly lastTriggeredValue: number | null;
  readonly lastEvaluatedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** La forma de la que lee `toAlertDto`: un registro de `alerts` con el `coingeckoId` de su moneda ya resuelto. */
export interface AlertDtoSource {
  readonly id: Types.ObjectId;
  readonly coingeckoId: string;
  readonly type: AlertType;
  readonly threshold: number;
  readonly mode: AlertMode;
  readonly status: AlertStatus;
  readonly cooldownMinutes: number;
  readonly rearmPct: number;
  readonly note: string | null;
  readonly version: number;
  readonly triggerCount: number;
  readonly lastTriggeredAt: Date | null;
  readonly lastTriggeredValue: number | null;
  readonly lastEvaluatedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function toAlertDto(source: AlertDtoSource): AlertDto {
  return {
    id: source.id.toString(),
    coingeckoId: source.coingeckoId,
    type: source.type,
    threshold: source.threshold,
    mode: source.mode,
    status: source.status,
    cooldownMinutes: source.cooldownMinutes,
    rearmPct: source.rearmPct,
    note: source.note,
    version: source.version,
    triggerCount: source.triggerCount,
    lastTriggeredAt: source.lastTriggeredAt,
    lastTriggeredValue: source.lastTriggeredValue,
    lastEvaluatedAt: source.lastEvaluatedAt,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

/** Identidad y `latest` de la moneda de una alerta, agrupados (mismo criterio que `watchlist.dto.ts`) en vez de campos sueltos mezclados con los de la alerta. */
export interface AlertListItemCoinDto {
  readonly symbol: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly latest: LatestDto | null;
}

export interface AlertListItemDto extends AlertDto {
  readonly coin: AlertListItemCoinDto;
}

/** La forma de la que lee `toAlertListItemDto`: la fila que produce la agregación de listado (alerta + `$lookup` a `coins`). */
export interface AlertListItemDtoSource extends AlertDtoSource {
  readonly symbol: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly latest: AlertListItemCoinDto['latest'];
}

export function toAlertListItemDto(source: AlertListItemDtoSource): AlertListItemDto {
  return {
    ...toAlertDto(source),
    coin: {
      symbol: source.symbol,
      name: source.name,
      isActive: source.isActive,
      latest: source.latest,
    },
  };
}

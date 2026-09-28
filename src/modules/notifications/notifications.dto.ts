import type { Types } from 'mongoose';
import { maskEmail } from '../../lib/maskEmail.js';
import type { AlertType } from '../alerts/alerts.model.js';
import type { NotificationStatus } from './notifications.model.js';

/**
 * DTOs de salida del módulo de notifications y el builder que los arma a
 * partir de un documento de `notifications`. Explícito campo por campo
 * (design.md: "los DTOs de salida son explícitos, no transforms de
 * `toJSON`") — nunca incluye `userId`, `lockedAt`/`lockedBy`, `dedupeKey`,
 * `maxAttempts`, `nextAttemptAt`, `providerMessageId` ni el `lastError`
 * completo (spec notification-outbox: "internal fields are never exposed to
 * users"); cuando hay un error, solo se expone `lastError.code`, nunca
 * `.message` ni `.permanent`.
 */

export interface NotificationPayloadDto {
  readonly coingeckoId: string;
  readonly coinName: string;
  readonly symbol: string;
  readonly alertType: AlertType;
  readonly threshold: number;
  readonly value: number;
  readonly priceUsd: number;
  readonly change24hPct: number | null;
  readonly triggeredAt: Date;
  readonly note: string | null;
}

/** Solo el código del error — ver el comentario de arriba sobre por qué nunca se expone `.message`. */
export interface NotificationLastErrorDto {
  readonly code: string;
}

export interface NotificationDto {
  readonly id: string;
  readonly alertId: string;
  readonly status: NotificationStatus;
  readonly to: string;
  readonly payload: NotificationPayloadDto;
  readonly attempts: number;
  readonly sentAt: Date | null;
  readonly createdAt: Date;
  readonly lastError: NotificationLastErrorDto | null;
}

/** La forma de la que lee este builder: la proyección leída de un documento de `notifications`. */
export interface NotificationDtoSource {
  readonly _id: Types.ObjectId;
  readonly alertId: Types.ObjectId;
  readonly status: NotificationStatus;
  readonly to: string;
  readonly payload: NotificationPayloadDto;
  readonly attempts: number;
  readonly sentAt: Date | null;
  readonly createdAt: Date;
  readonly lastError: { code: string; message: string; permanent: boolean } | null;
}

export function toNotificationDto(source: NotificationDtoSource): NotificationDto {
  return {
    id: source._id.toString(),
    alertId: source.alertId.toString(),
    status: source.status,
    to: maskEmail(source.to),
    payload: source.payload,
    attempts: source.attempts,
    sentAt: source.sentAt,
    createdAt: source.createdAt,
    lastError: source.lastError ? { code: source.lastError.code } : null,
  };
}

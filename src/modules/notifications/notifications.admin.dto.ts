import type { Types } from 'mongoose';
import { maskEmail } from '../../lib/maskEmail.js';
import type { NotificationPayloadDto } from './notifications.dto.js';
import type { NotificationStatus } from './notifications.model.js';

/**
 * DTO de salida de los endpoints de administración de notifications (spec
 * admin-notifications-api) y el builder que lo arma. Es un DTO
 * DISTINTO del `NotificationDto` público de `notifications.dto.ts` — mismo
 * criterio de separación que `coins.admin.dto.ts` frente a `coins.dto.ts` —
 * porque expone diagnóstico adicional que el usuario final nunca ve: el
 * `lastError` COMPLETO (`code`/`message`/`permanent`, no solo `.code`) y
 * `lockedBy`. `to` se mantiene enmascarado igual que en el DTO público: la
 * spec solo pide exponer más diagnóstico, no el email crudo, y este listado
 * no lo necesita para nada operativo.
 */

/** A diferencia de `NotificationLastErrorDto` (solo `.code`), acá se expone el objeto completo. */
export interface AdminNotificationLastErrorDto {
  readonly code: string;
  readonly message: string;
  readonly permanent: boolean;
}

export interface AdminNotificationDto {
  readonly id: string;
  readonly alertId: string;
  readonly status: NotificationStatus;
  readonly to: string;
  readonly payload: NotificationPayloadDto;
  readonly attempts: number;
  readonly sentAt: Date | null;
  readonly createdAt: Date;
  readonly lastError: AdminNotificationLastErrorDto | null;
  readonly lockedBy: string | null;
}

/** La forma de la que lee este builder: la proyección leída de un documento de `notifications`. */
export interface AdminNotificationDtoSource {
  readonly _id: Types.ObjectId;
  readonly alertId: Types.ObjectId;
  readonly status: NotificationStatus;
  readonly to: string;
  readonly payload: NotificationPayloadDto;
  readonly attempts: number;
  readonly sentAt: Date | null;
  readonly createdAt: Date;
  readonly lastError: AdminNotificationLastErrorDto | null;
  readonly lockedBy: string | null;
}

export function toAdminNotificationDto(source: AdminNotificationDtoSource): AdminNotificationDto {
  return {
    id: source._id.toString(),
    alertId: source.alertId.toString(),
    status: source.status,
    to: maskEmail(source.to),
    payload: source.payload,
    attempts: source.attempts,
    sentAt: source.sentAt,
    createdAt: source.createdAt,
    lastError: source.lastError,
    lockedBy: source.lockedBy,
  };
}

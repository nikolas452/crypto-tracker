import type { Logger } from 'pino';
import { Types } from 'mongoose';
import { logger as defaultLogger } from '../../lib/logger.js';
import { UnprocessableError, UpstreamError } from '../../lib/errors.js';
import { buildPaginationMeta, type PaginatedResult } from '../../lib/pagination.js';
import type { Mailer } from '../../integrations/mailer/mailer.types.js';
import { MailError } from '../../integrations/mailer/mailer.errors.js';
import { NotificationModel } from './notifications.model.js';
import {
  toAdminNotificationDto,
  type AdminNotificationDto,
  type AdminNotificationDtoSource,
} from './notifications.admin.dto.js';
import type { AdminNotificationListQuery } from './notifications.admin.schemas.js';

/**
 * Capa de servicio de administración de notifications (spec
 * admin-notifications-api, tareas 10.1-10.3): listado paginado con
 * diagnóstico completo, reintento atómico de una notificación `failed`, y
 * envío inmediato de un email de prueba que jamás toca el outbox. Archivo
 * separado de `notifications.service.ts`, mismo criterio de separación que
 * `coins.admin.service.ts` frente a `coins.service.ts`.
 */

/** Proyección leída por el listado de admin: agrega `lockedBy` y el `lastError` completo sobre la proyección del listado de usuario. */
const ADMIN_NOTIFICATION_LIST_PROJECTION = {
  alertId: 1,
  status: 1,
  to: 1,
  payload: 1,
  attempts: 1,
  sentAt: 1,
  createdAt: 1,
  lastError: 1,
  lockedBy: 1,
} as const;

/**
 * Fuente de datos de `GET /api/v1/admin/notifications` (spec
 * admin-notifications-api): filtros `status` (uno o más), `userId`, `from`/
 * `to` sobre `createdAt`, y paginación — mismo patrón que `listJobRuns`.
 */
export async function listAdminNotifications(
  query: AdminNotificationListQuery,
): Promise<PaginatedResult<AdminNotificationDto>> {
  const filter: Record<string, unknown> = {};

  if (query.status !== undefined) {
    filter.status = { $in: query.status };
  }
  if (query.userId !== undefined) {
    filter.userId = new Types.ObjectId(query.userId);
  }
  if (query.from !== undefined || query.to !== undefined) {
    filter.createdAt = {
      ...(query.from !== undefined ? { $gte: query.from } : {}),
      ...(query.to !== undefined ? { $lte: query.to } : {}),
    };
  }

  const skip = (query.page - 1) * query.limit;

  const [docs, total] = await Promise.all([
    NotificationModel.find(filter)
      .select(ADMIN_NOTIFICATION_LIST_PROJECTION)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(query.limit)
      .lean<AdminNotificationDtoSource[]>()
      .exec(),
    NotificationModel.countDocuments(filter).exec(),
  ]);

  return {
    data: docs.map(toAdminNotificationDto),
    meta: buildPaginationMeta(query.page, query.limit, total),
  };
}

/** Resultado de {@link retryFailedNotification}: distingue un id inexistente (404) de uno en un estado distinto a `failed` (409). */
export type RetryFailedNotificationResult =
  | { readonly outcome: 'retried'; readonly dto: AdminNotificationDto }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'conflict' };

export interface RetryFailedNotificationDeps {
  readonly logger?: Logger;
  readonly now?: Date;
}

/**
 * Reintento de una notificación `failed` (spec admin-notifications-api,
 * `POST /api/v1/admin/notifications/:id/retry`). El chequeo de estado y la
 * escritura son atómicos vía un único `findOneAndUpdate` condicional
 * (`{ _id, status: 'failed' }`) — nunca un read-then-write separado, que
 * sería una condición de carrera frente a otro reintento o un reclamo
 * concurrente del job de envío.
 *
 * Cuando el `findOneAndUpdate` condicional no matchea nada, una segunda
 * consulta liviana (solo `_id`) distingue el id inexistente (404
 * `NOT_FOUND`, decisión de esta fase: la spec solo cubre `failed`->éxito y
 * `sent`->409, así que un id inexistente se trata como "no encontrado" en
 * lugar de forzarlo al 409 `CONFLICT` genérico) de uno que existe en otro
 * estado (409 `CONFLICT`, spec: "any other status responds 409"). El log de
 * la acción de admin (`'Admin notification write'`, mismo patrón que
 * `'Admin coin write'` en `coins.admin.service.ts`) solo se emite en el
 * camino de éxito.
 */
export async function retryFailedNotification(
  id: string,
  adminUserId: string,
  deps: RetryFailedNotificationDeps = {},
): Promise<RetryFailedNotificationResult> {
  const logger = deps.logger ?? defaultLogger;
  const now = deps.now ?? new Date();

  const updated = await NotificationModel.findOneAndUpdate(
    { _id: id, status: 'failed' },
    { $set: { status: 'pending', attempts: 0, nextAttemptAt: now, lastError: null } },
    { returnDocument: 'after' },
  )
    .select({
      alertId: 1,
      status: 1,
      to: 1,
      payload: 1,
      attempts: 1,
      sentAt: 1,
      createdAt: 1,
      lastError: 1,
      lockedBy: 1,
    })
    .lean<AdminNotificationDtoSource | null>()
    .exec();

  if (updated) {
    logger.info({ adminUserId, notificationId: id, action: 'retry' }, 'Admin notification write');
    return { outcome: 'retried', dto: toAdminNotificationDto(updated) };
  }

  const exists = await NotificationModel.exists({ _id: id });
  return exists ? { outcome: 'conflict' } : { outcome: 'not_found' };
}

export interface SendAdminTestEmailDeps {
  readonly mailer: Mailer;
}

/**
 * Envío inmediato de un email de prueba (spec admin-notifications-api, `POST
 * /api/v1/admin/notifications/test-email`): SIEMPRE al email del propio
 * admin autenticado, nunca a un destinatario provisto por el cliente, y sin
 * crear ningún documento de `notifications` — bypassea el outbox por
 * completo. El mensaje es un texto mínimo fijo, no pasa por
 * `templates/alert-triggered.ts` (esto no es una notificación de alerta).
 *
 * Un `email` `null` (cuenta de admin sin email en Firebase) es un caso de
 * borde real e irrecuperable acá: 422 `UNPROCESSABLE` con
 * `details.reason: 'NO_EMAIL_ON_FILE'`, distinto de `EMAIL_NOT_VERIFIED`
 * (que sí implica que hay una dirección, solo que no está verificada).
 *
 * Un `MailError` del mailer (spec mailer: `SMTP_REJECTED`/
 * `SMTP_UNAVAILABLE`) se traduce a 502 `UPSTREAM_ERROR` con el código
 * específico del mailer en `details.reason` — el mismo patrón que ya usa
 * este proyecto para un sub-código de negocio dentro de un `AppError`
 * genérico (`details: { reason: 'EMAIL_NOT_VERIFIED' }` en
 * `alerts.service.ts`), ya que `AppError.code` es fijo por subclase y no se
 * puede sobreescribir por instancia.
 */
export async function sendAdminTestEmail(
  email: string | null,
  deps: SendAdminTestEmailDeps,
): Promise<{ readonly messageId: string }> {
  if (email === null) {
    throw new UnprocessableError('El admin no tiene un email registrado', {
      details: { reason: 'NO_EMAIL_ON_FILE' },
    });
  }

  try {
    const result = await deps.mailer.send({
      to: email,
      subject: 'Test email from crypto-tracker admin panel',
      text: 'Este es un email de prueba enviado desde el panel de administración de crypto-tracker. Si lo recibiste, la configuración de SMTP funciona correctamente.',
      html: '<p>Este es un email de prueba enviado desde el panel de administración de crypto-tracker. Si lo recibiste, la configuración de SMTP funciona correctamente.</p>',
    });

    return { messageId: result.messageId };
  } catch (error) {
    if (error instanceof MailError) {
      throw new UpstreamError('Falló el envío de prueba', {
        details: { reason: error.code },
        cause: error,
      });
    }
    throw error;
  }
}

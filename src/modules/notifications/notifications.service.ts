import { Types } from 'mongoose';
import { buildPaginationMeta, type PaginatedResult } from '../../lib/pagination.js';
import { NotificationModel } from './notifications.model.js';
import {
  toNotificationDto,
  type NotificationDto,
  type NotificationDtoSource,
} from './notifications.dto.js';
import type { NotificationListQuery } from './notifications.schemas.js';
import type { RenderAlertType } from './templates/alert-triggered.js';

/**
 * Capa de servicio del módulo de notifications: por ahora, solo el
 * repositorio y la consulta de listado que necesita `GET
 * /api/v1/me/notifications` (spec notification-outbox). El resto de las
 * operaciones sobre `notifications` (creación desde el job de evaluación,
 * reclamo/envío, endpoints de admin) llega en fases posteriores — mismo
 * patrón de repositorio + factory que `alerts.service.ts` / `watchlist.service.ts`.
 */

/** Filtro de `listByUser`: `status` es opcional, ya validado contra el enum por la ruta. */
export interface NotificationListFilter {
  readonly status?: NotificationListQuery['status'];
}

/**
 * Contrato de repositorio para `notifications`. Se inyecta en las funciones
 * de servicio de abajo para que los tests unitarios puedan usar una
 * implementación falsa en memoria, el mismo patrón que `AlertsRepo` /
 * `WatchlistRepo`.
 */
export interface NotificationsRepo {
  listByUser(
    userId: Types.ObjectId,
    filter: NotificationListFilter,
    page: number,
    limit: number,
  ): Promise<{ docs: NotificationDtoSource[]; total: number }>;
  /** Mueve a `cancelled` las notificaciones `pending` de una alerta (spec alert-api: baja de alerta) — nunca toca una `sending`, ya reclamada por un job de envío. */
  cancelPendingForAlert(alertId: Types.ObjectId): Promise<void>;
  /** Borra todo el historial de un usuario excepto lo que esté `sending` (spec account-deletion-cascade). Devuelve la cantidad eliminada. */
  deleteAllByUser(userId: Types.ObjectId): Promise<number>;
}

/** Proyección leída por el listado: nunca `lockedAt`/`lockedBy`/`dedupeKey`/`maxAttempts`/`nextAttemptAt`/`providerMessageId` (spec notification-outbox). */
const NOTIFICATION_LIST_PROJECTION = {
  alertId: 1,
  status: 1,
  to: 1,
  payload: 1,
  attempts: 1,
  sentAt: 1,
  createdAt: 1,
  lastError: 1,
} as const;

/** Crea el repositorio de `notifications` respaldado por Mongoose. Función factory simple, sin contenedor de DI. */
export function createNotificationsRepo(): NotificationsRepo {
  return {
    async listByUser(userId, filter, page, limit) {
      const query: Record<string, unknown> = { userId };
      if (filter.status !== undefined) {
        query.status = filter.status;
      }

      const skip = (page - 1) * limit;

      const [docs, total] = await Promise.all([
        NotificationModel.find(query)
          .select(NOTIFICATION_LIST_PROJECTION)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean<NotificationDtoSource[]>()
          .exec(),
        NotificationModel.countDocuments(query).exec(),
      ]);

      return { docs, total };
    },

    async cancelPendingForAlert(alertId) {
      await NotificationModel.updateMany(
        { alertId, status: 'pending' },
        { $set: { status: 'cancelled' } },
      ).exec();
    },

    async deleteAllByUser(userId) {
      const result = await NotificationModel.deleteMany({
        userId,
        status: { $ne: 'sending' },
      }).exec();
      return result.deletedCount;
    },
  };
}

export interface ListNotificationsForUserDeps {
  readonly repo?: NotificationsRepo;
}

/**
 * Fuente de datos de `GET /api/v1/me/notifications` (spec
 * notification-outbox). Filtrado siempre por el `userId` del caller — nunca
 * un valor recibido del cliente (mismo aislamiento que
 * `listWatchlist`/`countActiveAlerts`) — y con la forma de paginación
 * compartida del proyecto (`buildPaginationMeta`, la misma que usa
 * `listJobRuns`).
 */
export async function listNotificationsForUser(
  userId: string,
  query: NotificationListQuery,
  deps: ListNotificationsForUserDeps = {},
): Promise<PaginatedResult<NotificationDto>> {
  const repo = deps.repo ?? createNotificationsRepo();

  const { docs, total } = await repo.listByUser(
    new Types.ObjectId(userId),
    { status: query.status },
    query.page,
    query.limit,
  );

  return {
    data: docs.map(toNotificationDto),
    meta: buildPaginationMeta(query.page, query.limit, total),
  };
}

/**
 * Cancela las notificaciones `pending` de una alerta (spec alert-api:
 * `DELETE /api/v1/me/alerts/:id` mueve sus pendientes a `cancelled` después
 * de borrar la alerta). Llamada por `alerts.service.ts` — este módulo nunca
 * sabe nada de `alerts` más allá del `alertId` recibido, mismo criterio de
 * aislamiento que `deleteAllWatchlistItemsForUser`.
 */
export async function cancelPendingNotificationsForAlert(
  alertId: Types.ObjectId,
  repo: NotificationsRepo = createNotificationsRepo(),
): Promise<void> {
  await repo.cancelPendingForAlert(alertId);
}

/**
 * Borra el historial de notificaciones de un usuario (spec
 * account-deletion-cascade), excepto las que estén `sending`: ya las
 * reclamó un job de envío en curso, y tocarlas ahora corrompería ese envío
 * en progreso — se dejan intactas y las limpia después la retención TTL
 * (`NOTIFICATIONS_RETENTION_DAYS`). Un borrado directo cumple a la vez el
 * "mover `pending` a `cancelled`" y el "borrar el resto del historial" que
 * pide la spec por separado: una `pending` borrada nunca se envía, que es
 * exactamente la garantía que "cancelada" también daría (la spec acepta
 * ambas — "cancelled or deleted" — como resultado válido). La llama
 * `usersService.deleteAccount(userId)` antes de borrar las alertas del
 * usuario — este módulo nunca sabe nada de `users`/`alerts`, mismo criterio
 * de aislamiento que `deleteAllWatchlistItemsForUser`.
 */
export async function deleteAllNotificationsForUser(
  userId: string,
  repo: NotificationsRepo = createNotificationsRepo(),
): Promise<number> {
  return repo.deleteAllByUser(new Types.ObjectId(userId));
}

/**
 * Snapshot congelado del `payload` de una notificación reclamada por el job
 * de envío (spec send-notifications-job) — mismo shape que
 * `RenderAlertTriggeredPayload` sin `alertId`/`displayTimezone`: esos dos
 * campos los agrega `sendNotifications.ts` al momento de renderizar, nunca
 * forman parte del documento persistido.
 */
export interface NotificationJobPayload {
  readonly coingeckoId: string;
  readonly coinName: string;
  readonly symbol: string;
  readonly alertType: RenderAlertType;
  readonly threshold: number;
  readonly value: number;
  readonly priceUsd: number;
  readonly change24hPct: number | null;
  readonly triggeredAt: Date;
  readonly note: string | null;
}

/** Una notificación reclamada por `NotificationsJobRepo.claimNext` (spec send-notifications-job). */
export interface ClaimedNotification {
  readonly id: Types.ObjectId;
  readonly userId: Types.ObjectId;
  readonly alertId: Types.ObjectId;
  readonly to: string;
  readonly payload: NotificationJobPayload;
  readonly attempts: number;
  readonly maxAttempts: number;
}

/** `{ code, message, permanent }` — mismo shape que `notificationLastErrorSchema`, nunca un stack trace ni un secreto. */
export interface NotificationLastError {
  readonly code: string;
  readonly message: string;
  readonly permanent: boolean;
}

/**
 * Contrato de repositorio para el job `send-notifications` (spec
 * send-notifications-job, tareas 9.1-9.6): recuperación de locks obsoletos,
 * el bucle de reclamo atómico, y las cinco transiciones post-reclamo, cada
 * una con el mismo filtro owner-scoped `{ _id, status: 'sending', lockedBy:
 * workerId }` — si ese filtro no matchea nada (otro proceso ya recuperó y
 * reclamó esta notificación por lock obsoleto), la transición devuelve
 * `false` y el caller simplemente sigue, sin tratarlo como error. Se inyecta
 * en `createSendNotificationsJob` para que `sendNotifications.ts` se
 * mantenga enfocado en el control de flujo (el bucle, el branching, las
 * estadísticas) y nunca en queries de Mongoose inline — mismo criterio que
 * `CoinsRepo`/`SnapshotsRepo` en `pollPrices.ts`.
 */
export interface NotificationsJobRepo {
  /**
   * `updateMany` atómico (pipeline de agregación, un solo round trip) sobre
   * toda notificación `sending` cuyo `lockedAt` sea anterior a
   * `staleThreshold`: vuelve a `pending` con `attempts + 1`, o a `failed`
   * (sin resetear `nextAttemptAt`) si ese incremento alcanza `maxAttempts`.
   * Libera `lockedAt`/`lockedBy` en ambos casos. Devuelve cuántos documentos
   * tocó en total — ambos desenlaces cuentan para `stats.recoveredStale`.
   */
  recoverStaleLocks(staleThreshold: Date, now: Date): Promise<number>;
  /**
   * Reclamo atómico de la próxima notificación `pending` lista
   * (`nextAttemptAt <= now`), ordenada por `nextAttemptAt` ascendente.
   * `null` cuando no queda ninguna — señal para que el bucle de reclamo pare.
   */
  claimNext(now: Date, workerId: string): Promise<ClaimedNotification | null>;
  markCancelled(id: Types.ObjectId, workerId: string): Promise<boolean>;
  markSent(
    id: Types.ObjectId,
    workerId: string,
    sentAt: Date,
    providerMessageId: string,
  ): Promise<boolean>;
  markFailedPermanent(
    id: Types.ObjectId,
    workerId: string,
    error: NotificationLastError,
  ): Promise<boolean>;
  markFailedExhausted(
    id: Types.ObjectId,
    workerId: string,
    newAttempts: number,
    error: NotificationLastError,
  ): Promise<boolean>;
  markRetry(
    id: Types.ObjectId,
    workerId: string,
    newAttempts: number,
    nextAttemptAt: Date,
    error: NotificationLastError,
  ): Promise<boolean>;
}

interface ClaimedNotificationProjection {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  alertId: Types.ObjectId;
  to: string;
  payload: NotificationJobPayload;
  attempts: number;
  maxAttempts: number;
}

/**
 * Crea el repositorio de `notifications` para el job `send-notifications`,
 * respaldado por Mongoose. Función factory simple, sin contenedor de DI —
 * mismo patrón que {@link createNotificationsRepo}.
 */
export function createNotificationsJobRepo(): NotificationsJobRepo {
  return {
    async recoverStaleLocks(staleThreshold, now) {
      // Pipeline de agregación como argumento de `update` (array, no objeto):
      // estándar de MongoDB 4.2+, un solo round trip atómico. Se pasa por
      // `.collection.updateMany` (el driver nativo, no el overload de
      // documento de Mongoose) para evitar fricción de tipos con Mongoose
      // 9.x sobre esta forma de `update` — verificado contra
      // `MongoMemoryReplSet` en `tests/integration/sendNotifications.test.ts`
      // (E5-13).
      const result = await NotificationModel.collection.updateMany(
        { status: 'sending', lockedAt: { $lt: staleThreshold } },
        [
          {
            $set: {
              attempts: { $add: ['$attempts', 1] },
              status: {
                $cond: [
                  { $gte: [{ $add: ['$attempts', 1] }, '$maxAttempts'] },
                  'failed',
                  'pending',
                ],
              },
              nextAttemptAt: {
                $cond: [
                  { $gte: [{ $add: ['$attempts', 1] }, '$maxAttempts'] },
                  '$nextAttemptAt',
                  now,
                ],
              },
              lockedAt: null,
              lockedBy: null,
            },
          },
        ],
      );
      return result.modifiedCount;
    },

    async claimNext(now, workerId) {
      const doc = await NotificationModel.findOneAndUpdate(
        { status: 'pending', nextAttemptAt: { $lte: now } },
        { $set: { status: 'sending', lockedAt: now, lockedBy: workerId } },
        { sort: { nextAttemptAt: 1 }, returnDocument: 'after' },
      )
        .select({ userId: 1, alertId: 1, to: 1, payload: 1, attempts: 1, maxAttempts: 1 })
        .lean<ClaimedNotificationProjection | null>()
        .exec();

      if (!doc) {
        return null;
      }

      return {
        id: doc._id,
        userId: doc.userId,
        alertId: doc.alertId,
        to: doc.to,
        payload: doc.payload,
        attempts: doc.attempts,
        maxAttempts: doc.maxAttempts,
      };
    },

    async markCancelled(id, workerId) {
      const result = await NotificationModel.updateOne(
        { _id: id, status: 'sending', lockedBy: workerId },
        { $set: { status: 'cancelled' } },
      ).exec();
      return result.modifiedCount > 0;
    },

    async markSent(id, workerId, sentAt, providerMessageId) {
      const result = await NotificationModel.updateOne(
        { _id: id, status: 'sending', lockedBy: workerId },
        {
          $set: {
            status: 'sent',
            sentAt,
            providerMessageId,
            lockedAt: null,
            lockedBy: null,
          },
        },
      ).exec();
      return result.modifiedCount > 0;
    },

    async markFailedPermanent(id, workerId, error) {
      const result = await NotificationModel.updateOne(
        { _id: id, status: 'sending', lockedBy: workerId },
        { $set: { status: 'failed', lastError: error, lockedAt: null, lockedBy: null } },
      ).exec();
      return result.modifiedCount > 0;
    },

    async markFailedExhausted(id, workerId, newAttempts, error) {
      const result = await NotificationModel.updateOne(
        { _id: id, status: 'sending', lockedBy: workerId },
        {
          $set: {
            status: 'failed',
            attempts: newAttempts,
            lastError: error,
            lockedAt: null,
            lockedBy: null,
          },
        },
      ).exec();
      return result.modifiedCount > 0;
    },

    async markRetry(id, workerId, newAttempts, nextAttemptAt, error) {
      const result = await NotificationModel.updateOne(
        { _id: id, status: 'sending', lockedBy: workerId },
        {
          $set: {
            status: 'pending',
            attempts: newAttempts,
            nextAttemptAt,
            lastError: error,
            lockedAt: null,
            lockedBy: null,
          },
        },
      ).exec();
      return result.modifiedCount > 0;
    },
  };
}

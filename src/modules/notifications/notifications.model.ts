import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { config } from '../../config/env.js';
import { ALERT_TYPES } from '../alerts/alerts.model.js';

/**
 * Modelo de Mongoose para `notifications`: el outbox de notificaciones por
 * email que produce el job de evaluación de alertas y consume el job de
 * envío de una fase posterior (spec notification-outbox). Un documento por
 * disparo de una alerta, con su propia máquina de estados (`pending` /
 * `sending` / `sent` / `failed` / `cancelled`).
 *
 * `dedupeKey` (`${alertId}:${triggerCount}`, único) es el mecanismo de
 * idempotencia del proyecto frente a un disparo evaluado más de una vez: un
 * segundo insert con la misma clave falla con un error nativo de clave
 * duplicada de MongoDB (E11000) en lugar de crear una notificación repetida.
 * Este módulo solo define el campo y su índice; construir el valor y tratar
 * el E11000 como éxito idempotente es responsabilidad del job de evaluación
 * (fase posterior), no de este modelo.
 */

export const NOTIFICATION_CHANNELS = ['email'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_STATUSES = ['pending', 'sending', 'sent', 'failed', 'cancelled'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/**
 * Subdocumento explícito de `payload`: el snapshot congelado del evento en
 * el momento del disparo (spec notification-outbox, "frozen event
 * snapshot") — valores planos copiados en ese instante, nunca referencias
 * que puedan cambiar después (un cambio posterior de precio o de la alerta
 * no debe alterar una notificación ya encolada). `_id: false` porque es un
 * valor embebido sin identidad propia, mismo patrón que `error`/`stats` en
 * `job-runs.model.ts`.
 */
const notificationPayloadSchema = new Schema(
  {
    coingeckoId: { type: String, required: true },
    coinName: { type: String, required: true },
    symbol: { type: String, required: true },
    alertType: { type: String, required: true, enum: ALERT_TYPES },
    threshold: { type: Number, required: true },
    // El valor real que cruzó el umbral (el precio o el cambio de 24h, según el tipo de alerta).
    value: { type: Number, required: true },
    priceUsd: { type: Number, required: true },
    change24hPct: { type: Number, default: null },
    triggeredAt: { type: Date, required: true },
    note: { type: String, default: null },
  },
  { _id: false },
);

/**
 * Subdocumento explícito de `lastError`: solo `{ code, message, permanent }`
 * — nunca un stack trace ni un secreto, mismo patrón que `jobRunErrorSchema`
 * en `job-runs.model.ts`. `permanent` distingue un fallo definitivo (por
 * ejemplo, un 5xx de SMTP) de uno transitorio reintentable, lógica que
 * implementa el mailer de una fase posterior.
 */
const notificationLastErrorSchema = new Schema(
  {
    code: { type: String, required: true },
    message: { type: String, required: true },
    permanent: { type: Boolean, required: true },
  },
  { _id: false },
);

const notificationSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: 'User',
    },
    alertId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: 'Alert',
    },
    // Enum de un solo valor a propósito (spec notification-outbox): agregar
    // un canal más adelante es una nueva entrada de enum, no una migración.
    channel: {
      type: String,
      required: true,
      enum: NOTIFICATION_CHANNELS,
      default: 'email',
    },
    // Email del usuario al momento del disparo — un snapshot congelado, no
    // una referencia viva a `users.email` (spec notification-outbox).
    to: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      required: true,
      enum: NOTIFICATION_STATUSES,
      default: 'pending',
    },
    // Construido por el job de evaluación como `${alertId}:${triggerCount}`;
    // acá solo se declara el campo y su índice único (ver comentario de
    // cabecera).
    dedupeKey: {
      type: String,
      required: true,
    },
    payload: {
      type: notificationPayloadSchema,
      required: true,
    },
    attempts: {
      type: Number,
      required: true,
      default: 0,
    },
    // Valor leído de `config` al cargar este módulo (singleton congelado):
    // el default queda fijo para todo documento nuevo mientras el proceso
    // sigue corriendo, mismo patrón que la retención TTL de `job_runs`.
    maxAttempts: {
      type: Number,
      required: true,
      default: config.NOTIFY_MAX_ATTEMPTS,
    },
    nextAttemptAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    lockedAt: {
      type: Date,
      default: null,
    },
    lockedBy: {
      type: String,
      default: null,
    },
    lastError: {
      type: notificationLastErrorSchema,
      default: null,
    },
    sentAt: {
      type: Date,
      default: null,
    },
    providerMessageId: {
      type: String,
      default: null,
    },
  },
  {
    collection: 'notifications',
    timestamps: true,
    versionKey: false,
  },
);

// Único: impide que el mismo disparo (alertId + triggerCount) produzca dos
// notificaciones, incluso bajo evaluaciones concurrentes o repetidas (spec
// notification-outbox: mecanismo de idempotencia del job de evaluación).
notificationSchema.index({ dedupeKey: 1 }, { unique: true });
// Sirve la consulta de reclamo del job de envío: pendientes listas para
// intentarse, ordenadas por su próximo intento.
notificationSchema.index({ status: 1, nextAttemptAt: 1 });
// Sirve la recuperación de locks obsoletos: notificaciones "sending" cuyo
// lock quedó viejo (el worker que las tomó murió sin cerrarlas).
notificationSchema.index({ status: 1, lockedAt: 1 });
// Sirve el listado de notificaciones de un usuario, ordenado por fecha de alta.
notificationSchema.index({ userId: 1, createdAt: -1 });
// Sirve la búsqueda de las notificaciones de una alerta puntual (por
// ejemplo, cancelar sus pendientes al borrarla).
notificationSchema.index({ alertId: 1, status: 1 });
// TTL: purga notificaciones viejas después de NOTIFICATIONS_RETENTION_DAYS
// (spec notification-outbox), mismo mecanismo que la retención de `job_runs`.
notificationSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: config.NOTIFICATIONS_RETENTION_DAYS * 86400 },
);

export type NotificationDocument = HydratedDocument<InferSchemaType<typeof notificationSchema>>;

export const NotificationModel = model('Notification', notificationSchema);

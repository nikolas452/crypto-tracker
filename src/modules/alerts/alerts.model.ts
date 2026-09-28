import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * Modelo de Mongoose para `alerts`: las alertas de precio/cambio que un
 * usuario configura sobre una moneda (spec alert-store). Un documento por
 * alerta, con su propia máquina de estados (`armed` / `triggered` /
 * `completed` / `disabled`) evaluada por el job de alertas de una fase
 * posterior — este módulo solo define la forma persistida y la función pura
 * de decisión (`decide()`, ver `alerts.decide.ts`).
 */

export const ALERT_TYPES = ['PRICE_ABOVE', 'PRICE_BELOW', 'CHANGE_24H_ABS_GTE'] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

export const ALERT_MODES = ['once', 'recurring'] as const;
export type AlertMode = (typeof ALERT_MODES)[number];

export const ALERT_STATUSES = ['armed', 'triggered', 'completed', 'disabled'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

const NOTE_MAX_LENGTH = 200;

// Rangos de threshold: los tipos de precio aceptan cualquier valor positivo
// hasta 1e9; el tipo de cambio porcentual queda acotado a 0.1-100 puntos
// (spec alert-store). El rango depende de `type`, así que no alcanza con un
// `min`/`max` fijo del schema — se valida con un validador custom más abajo.
const PRICE_THRESHOLD_MAX = 1e9;
const CHANGE_THRESHOLD_MIN = 0.1;
const CHANGE_THRESHOLD_MAX = 100;

/**
 * Único punto de verdad del rango válido de `threshold` según `type` (spec
 * alert-store). La usa el validador del schema de abajo y, en el módulo de
 * servicio, `updateAlert` (`alerts.service.ts`) — `PATCH` no vuelve a pasar
 * `type` en el body (es inmutable), así que revalida `threshold` contra el
 * `type` ya guardado de la alerta antes de escribir, en vez de confiar solo
 * en el validador de Mongoose (que `findOneAndUpdate` no corre por defecto).
 */
export function isThresholdInRange(type: AlertType, value: number): boolean {
  if (type === 'CHANGE_24H_ABS_GTE') {
    return value >= CHANGE_THRESHOLD_MIN && value <= CHANGE_THRESHOLD_MAX;
  }
  return value > 0 && value <= PRICE_THRESHOLD_MAX;
}

const COOLDOWN_MINUTES_MIN = 5;
const COOLDOWN_MINUTES_MAX = 10080;
const COOLDOWN_MINUTES_DEFAULT = 60;

const REARM_PCT_MIN = 0;
const REARM_PCT_MAX = 20;
const REARM_PCT_DEFAULT = 1;

const alertSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: 'User',
    },
    coinId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: 'Coin',
    },
    // Inmutable después de la creación (spec alert-store): cambiar el tipo
    // de una alerta ya creada cambiaría el significado de su `threshold`
    // sin que el usuario lo haya revisado. `immutable: true` es la opción
    // estándar de Mongoose (compatible con la 9.x instalada), preferida a
    // un hook `pre('save')` porque la valida el propio schema.
    type: {
      type: String,
      required: true,
      enum: ALERT_TYPES,
      immutable: true,
    },
    threshold: {
      type: Number,
      required: true,
      // Validador custom (en lugar de `min`/`max` fijos) porque el rango
      // válido depende de `type`: > 0 y <= 1e9 para los tipos de precio,
      // entre 0.1 y 100 puntos porcentuales para CHANGE_24H_ABS_GTE.
      validate: {
        validator: function (this: { type: AlertType }, value: number): boolean {
          return isThresholdInRange(this.type, value);
        },
        message: 'threshold fuera de rango para el tipo de alerta',
      },
    },
    mode: {
      type: String,
      required: true,
      enum: ALERT_MODES,
      default: 'recurring',
    },
    status: {
      type: String,
      required: true,
      enum: ALERT_STATUSES,
      default: 'armed',
    },
    cooldownMinutes: {
      type: Number,
      required: true,
      min: COOLDOWN_MINUTES_MIN,
      max: COOLDOWN_MINUTES_MAX,
      default: COOLDOWN_MINUTES_DEFAULT,
    },
    rearmPct: {
      type: Number,
      required: true,
      min: REARM_PCT_MIN,
      max: REARM_PCT_MAX,
      default: REARM_PCT_DEFAULT,
    },
    note: {
      type: String,
      default: null,
      trim: true,
      maxlength: NOTE_MAX_LENGTH,
    },
    // Contador de optimistic concurrency (tarea 6, fase posterior) — un
    // concepto distinto del `versionKey` propio de Mongoose (`__v`), que
    // queda deshabilitado más abajo para que no colisione con este campo
    // explícito.
    version: {
      type: Number,
      required: true,
      default: 0,
    },
    triggerCount: {
      type: Number,
      required: true,
      default: 0,
    },
    lastTriggeredAt: {
      type: Date,
      default: null,
    },
    lastTriggeredValue: {
      type: Number,
      default: null,
    },
    // OJO: pese al nombre, `lastEvaluatedAt` NO es "la última vez que se
    // evaluó la alerta" — se actualiza únicamente cuando la evaluación
    // decide TRIGGER o REARM, es decir, cuando el `status` efectivamente
    // cambia (spec alert-evaluation, job de evaluación en
    // `src/jobs/alertEvaluation.ts`). Una decisión COOLDOWN o NOOP nunca
    // toca este campo, a propósito: escribir en cada alerta evaluada en
    // cada corrida (potencialmente miles) sería un costo de escritura que
    // no aporta nada, ya que ninguna consulta necesita distinguir "evaluada
    // sin cambios" de "no evaluada todavía".
    lastEvaluatedAt: {
      type: Date,
      default: null,
    },
  },
  {
    collection: 'alerts',
    timestamps: true,
    versionKey: false,
  },
);

// Sirve la evaluación periódica: buscar las alertas activas de una moneda.
alertSchema.index({ coinId: 1, status: 1 });
// Sirve el listado de alertas de un usuario, ordenado por fecha de alta.
alertSchema.index({ userId: 1, createdAt: -1 });
// Sirve el conteo de alertas activas de un usuario (cap de ALERTS_MAX_ACTIVE).
alertSchema.index({ userId: 1, status: 1 });

export type AlertDocument = HydratedDocument<InferSchemaType<typeof alertSchema>>;

export const AlertModel = model('Alert', alertSchema);

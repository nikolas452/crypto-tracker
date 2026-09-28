import { z } from 'zod';
import { Types } from 'mongoose';
import { ALERT_MODES, ALERT_STATUSES, type AlertStatus } from './alerts.model.js';

/**
 * Schemas de Zod para las rutas de alertas: query de listado, body de alta
 * (unión discriminada por `type`, spec alert-api), parámetro de ruta `id` y
 * body de edición.
 */

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// Rangos de threshold/cooldownMinutes/rearmPct/note duplicados acá desde
// `alerts.model.ts` (mismos valores, nunca defaults) a propósito: permite
// que un valor fuera de rango se rechace acá con 400 VALIDATION_ERROR en
// lugar de llegar a un `ValidationError` nativo de Mongoose sin traducir
// (mismo motivo que `NOTE_MAX_LENGTH` duplicado en `watchlist.schemas.ts`).
const PRICE_THRESHOLD_MAX = 1e9;
const CHANGE_THRESHOLD_MIN = 0.1;
const CHANGE_THRESHOLD_MAX = 100;
const COOLDOWN_MINUTES_MIN = 5;
const COOLDOWN_MINUTES_MAX = 10080;
const REARM_PCT_MIN = 0;
const REARM_PCT_MAX = 20;
const NOTE_MAX_LENGTH = 200;

/**
 * Schema de query estricto para `GET /api/v1/me/alerts` (spec alert-api):
 * `status` acepta uno o más valores separados por coma (mismo patrón que
 * `job-runs.schemas.ts`), `coingeckoId` filtra a una sola moneda.
 */
const rawAlertListQuerySchema = z
  .object({
    status: z.string().min(1).optional(),
    coingeckoId: z.string().min(1).toLowerCase().optional(),
    page: z.coerce.number().int().min(1).default(DEFAULT_PAGE),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  })
  .strict();

export const alertListQuerySchema = rawAlertListQuerySchema.transform((data, ctx) => {
  let status: AlertStatus[] | undefined;

  if (data.status !== undefined) {
    const values = data.status.split(',');
    const invalid = values.filter((value) => !ALERT_STATUSES.includes(value as AlertStatus));

    if (invalid.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message: `Valores de status inválidos: ${invalid.join(', ')}`,
      });
    } else {
      status = values as AlertStatus[];
    }
  }

  return {
    status,
    coingeckoId: data.coingeckoId,
    page: data.page,
    limit: data.limit,
  };
});

export type AlertListQuery = z.infer<typeof alertListQuerySchema>;

/**
 * Schema del parámetro de ruta `:id` para `GET`/`PATCH`/`DELETE
 * /api/v1/me/alerts/:id`. Mismo patrón que `jobRunIdParamSchema`
 * (`job-runs.schemas.ts`): valida por adelantado que sea un `ObjectId` bien
 * formado, así uno malformado es 400 `VALIDATION_ERROR` en vez de un
 * `CastError` de Mongoose sin traducir.
 */
export const alertIdParamSchema = z
  .object({
    id: z.string().refine((value) => Types.ObjectId.isValid(value), 'Identificador inválido'),
  })
  .strict();

export type AlertIdParam = z.infer<typeof alertIdParamSchema>;

/**
 * Campos comunes a las tres ramas de `createAlertBodySchema`. Los opcionales
 * no llevan `.default()` a propósito (spec alert-api): si se omiten, el
 * `undefined` llega tal cual al repositorio y es Mongoose quien aplica el
 * default del modelo al insertar — única fuente de verdad para esos
 * valores, nunca duplicados acá.
 */
const commonCreateAlertFields = {
  coingeckoId: z.string().min(1, 'coingeckoId es obligatorio'),
  mode: z.enum(ALERT_MODES).optional(),
  cooldownMinutes: z.number().int().min(COOLDOWN_MINUTES_MIN).max(COOLDOWN_MINUTES_MAX).optional(),
  rearmPct: z.number().min(REARM_PCT_MIN).max(REARM_PCT_MAX).optional(),
  note: z.union([z.string().trim().max(NOTE_MAX_LENGTH), z.null()]).optional(),
};

/**
 * Body estricto de `POST /api/v1/me/alerts` (spec alert-api): unión
 * discriminada por `type`, preferida a un `superRefine` porque cada rama
 * declara su propio rango de `threshold` de forma clara — los dos tipos de
 * precio aceptan `>0` y `<=1e9`, `CHANGE_24H_ABS_GTE` acota a 0.1-100.
 */
export const createAlertBodySchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('PRICE_ABOVE'),
      threshold: z.number().gt(0, 'threshold debe ser mayor a 0').max(PRICE_THRESHOLD_MAX),
      ...commonCreateAlertFields,
    })
    .strict(),
  z
    .object({
      type: z.literal('PRICE_BELOW'),
      threshold: z.number().gt(0, 'threshold debe ser mayor a 0').max(PRICE_THRESHOLD_MAX),
      ...commonCreateAlertFields,
    })
    .strict(),
  z
    .object({
      type: z.literal('CHANGE_24H_ABS_GTE'),
      threshold: z.number().min(CHANGE_THRESHOLD_MIN).max(CHANGE_THRESHOLD_MAX),
      ...commonCreateAlertFields,
    })
    .strict(),
]);

export type CreateAlertBody = z.infer<typeof createAlertBodySchema>;

/**
 * Body estricto de `PATCH /api/v1/me/alerts/:id` (spec alert-api): acepta
 * SOLO estas seis claves — `type` deliberadamente no es una clave de este
 * schema, así que `.strict()` ya rechaza cualquier body que la incluya con
 * 400 `VALIDATION_ERROR` (el mecanismo es la ausencia, no una validación
 * extra). Se exige al menos un campo presente vía `.refine()` — un body
 * vacío `{}` no tiene nada que actualizar.
 */
export const patchAlertBodySchema = z
  .object({
    threshold: z.number().gt(0, 'threshold debe ser mayor a 0').max(PRICE_THRESHOLD_MAX).optional(),
    cooldownMinutes: z.number().int().min(COOLDOWN_MINUTES_MIN).max(COOLDOWN_MINUTES_MAX).optional(),
    rearmPct: z.number().min(REARM_PCT_MIN).max(REARM_PCT_MAX).optional(),
    note: z.union([z.string().trim().max(NOTE_MAX_LENGTH), z.null()]).optional(),
    mode: z.enum(ALERT_MODES).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'Debe incluir al menos un campo a modificar',
  });

export type PatchAlertBody = z.infer<typeof patchAlertBodySchema>;

import { Types } from 'mongoose';
import { config, type Config } from '../../config/env.js';
import { InternalError, NotFoundError, UnprocessableError, ValidationError } from '../../lib/errors.js';
import { buildPaginationMeta, type PaginatedResult } from '../../lib/pagination.js';
import { isTriggerConditionMet, type AlertValue } from './alerts.decide.js';
import {
  AlertModel,
  isThresholdInRange,
  type AlertMode,
  type AlertStatus,
  type AlertType,
} from './alerts.model.js';
import {
  toAlertDto,
  toAlertListItemDto,
  type AlertDto,
  type AlertDtoSource,
  type AlertListItemDto,
  type AlertListItemDtoSource,
} from './alerts.dto.js';
import { findCoinRefByCoingeckoId, findCoinRefById, type CoinRef } from '../coins/coins.service.js';
import { cancelPendingNotificationsForAlert } from '../notifications/notifications.service.js';
import type { AlertListQuery, CreateAlertBody, PatchAlertBody } from './alerts.schemas.js';

/**
 * Capa de servicio del módulo de alertas: repositorio de `alerts` y la
 * lógica de negocio de RF-5.1 a RF-5.5 (spec alert-api) — alta, listado,
 * lectura, edición y baja, además del conteo de alertas activas que ya
 * existía desde la fase 3. Mismo patrón de repositorio + factory que
 * `watchlist.service.ts`. Toda función pública recibe `userId` como primer
 * parámetro explícito (mismo aislamiento por usuario que el resto de `/me`),
 * nunca lo lee de un objeto de contexto ambiente.
 */

/** Estados que cuentan contra el cap de alertas activas por usuario (spec alert-store). */
const ACTIVE_ALERT_STATUSES = ['armed', 'triggered'] as const;

export interface InsertAlertInput {
  readonly userId: Types.ObjectId;
  readonly coinId: Types.ObjectId;
  readonly type: AlertType;
  readonly threshold: number;
  readonly mode?: AlertMode;
  readonly cooldownMinutes?: number;
  readonly rearmPct?: number;
  readonly note?: string | null;
}

/** Registro plano de una alerta (sin el `coingeckoId` de su moneda, que resuelve el caller). */
export interface AlertRecord {
  readonly id: Types.ObjectId;
  readonly coinId: Types.ObjectId;
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

/** Fila del listado paginado: un `AlertRecord` combinado con la identidad y `latest` de su moneda ($lookup). */
export interface AlertListRow extends AlertRecord {
  readonly coingeckoId: string;
  readonly symbol: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly latest: CoinRef['latest'];
}

export interface AlertListFilter {
  readonly status?: readonly AlertStatus[];
  readonly coinId?: Types.ObjectId;
}

/** Solo las claves que puede tocar un `PATCH` (spec alert-api, paso 2/3 del algoritmo de `updateAlert`). */
export interface AlertPatchSet {
  readonly threshold?: number;
  readonly cooldownMinutes?: number;
  readonly rearmPct?: number;
  readonly note?: string | null;
  readonly mode?: AlertMode;
  readonly status?: AlertStatus;
}

/**
 * Contrato de repositorio para `alerts`. Se inyecta en las funciones de
 * servicio de abajo para que los tests unitarios puedan usar una
 * implementación falsa en memoria, el mismo patrón que `WatchlistRepo`.
 */
export interface AlertsRepo {
  /** Cuenta las alertas `armed`/`triggered` de un usuario (spec alert-store: cap de `ALERTS_MAX_ACTIVE`). */
  countActiveAlerts(userId: Types.ObjectId): Promise<number>;
  /** Inserta con `status: 'armed'`; los campos opcionales ausentes quedan `undefined` — Mongoose aplica el default del modelo, nunca uno duplicado acá. */
  insert(input: InsertAlertInput): Promise<AlertRecord>;
  findByIdAndUser(id: Types.ObjectId, userId: Types.ObjectId): Promise<AlertRecord | null>;
  /** `findOneAndUpdate({ _id, userId }, { $set, $inc: { version: 1 } }, { returnDocument: 'after' })` — el filtro `{ _id, userId }` es alcance de ownership, no concurrencia optimista (esa es otra fase). */
  updateByIdAndUser(
    id: Types.ObjectId,
    userId: Types.ObjectId,
    set: AlertPatchSet,
  ): Promise<AlertRecord | null>;
  /** `true` cuando había una alerta de ese usuario para borrar; `false` cuando no (DELETE siempre 204 de todos modos). */
  deleteByIdAndUser(id: Types.ObjectId, userId: Types.ObjectId): Promise<boolean>;
  /** Devuelve la cantidad de alertas eliminadas — usado por la cascada de borrado de cuenta (spec account-deletion-cascade). */
  deleteAllByUser(userId: Types.ObjectId): Promise<number>;
  listByUser(
    userId: Types.ObjectId,
    filter: AlertListFilter,
    page: number,
    limit: number,
  ): Promise<{ docs: AlertListRow[]; total: number }>;
}

const ALERT_RECORD_PROJECTION = {
  coinId: 1,
  type: 1,
  threshold: 1,
  mode: 1,
  status: 1,
  cooldownMinutes: 1,
  rearmPct: 1,
  note: 1,
  version: 1,
  triggerCount: 1,
  lastTriggeredAt: 1,
  lastTriggeredValue: 1,
  lastEvaluatedAt: 1,
  createdAt: 1,
  updatedAt: 1,
} as const;

interface AlertRecordProjection {
  _id: Types.ObjectId;
  coinId: Types.ObjectId;
  type: AlertType;
  threshold: number;
  mode: AlertMode;
  status: AlertStatus;
  cooldownMinutes: number;
  rearmPct: number;
  note: string | null;
  version: number;
  triggerCount: number;
  lastTriggeredAt: Date | null;
  lastTriggeredValue: number | null;
  lastEvaluatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toAlertRecord(doc: AlertRecordProjection): AlertRecord {
  return {
    id: doc._id,
    coinId: doc.coinId,
    type: doc.type,
    threshold: doc.threshold,
    mode: doc.mode,
    status: doc.status,
    cooldownMinutes: doc.cooldownMinutes,
    rearmPct: doc.rearmPct,
    note: doc.note,
    version: doc.version,
    triggerCount: doc.triggerCount,
    lastTriggeredAt: doc.lastTriggeredAt,
    lastTriggeredValue: doc.lastTriggeredValue,
    lastEvaluatedAt: doc.lastEvaluatedAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** Crea el repositorio de `alerts` respaldado por Mongoose. Función factory simple, sin contenedor de DI. */
export function createAlertsRepo(): AlertsRepo {
  return {
    async countActiveAlerts(userId) {
      return AlertModel.countDocuments({
        userId,
        status: { $in: ACTIVE_ALERT_STATUSES },
      }).exec();
    },

    async insert(input) {
      const doc = await AlertModel.create({
        userId: input.userId,
        coinId: input.coinId,
        type: input.type,
        threshold: input.threshold,
        // Sin evaluar-y-omitir explícito acá: un campo `undefined` nunca
        // sobrescribe el default del schema (spec alert-api: "single source
        // of truth" para los defaults, nunca duplicados en el servicio).
        mode: input.mode,
        cooldownMinutes: input.cooldownMinutes,
        rearmPct: input.rearmPct,
        note: input.note,
        status: 'armed',
      });
      return {
        id: doc._id,
        coinId: doc.coinId,
        type: doc.type,
        threshold: doc.threshold,
        mode: doc.mode,
        status: doc.status,
        cooldownMinutes: doc.cooldownMinutes,
        rearmPct: doc.rearmPct,
        note: doc.note ?? null,
        version: doc.version,
        triggerCount: doc.triggerCount,
        lastTriggeredAt: doc.lastTriggeredAt ?? null,
        lastTriggeredValue: doc.lastTriggeredValue ?? null,
        lastEvaluatedAt: doc.lastEvaluatedAt ?? null,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      };
    },

    async findByIdAndUser(id, userId) {
      return AlertModel.findOne({ _id: id, userId })
        .select(ALERT_RECORD_PROJECTION)
        .lean<AlertRecordProjection | null>()
        .exec()
        .then((doc) => (doc ? toAlertRecord(doc) : null));
    },

    async updateByIdAndUser(id, userId, set) {
      const doc = await AlertModel.findOneAndUpdate(
        { _id: id, userId },
        { $set: set, $inc: { version: 1 } },
        { returnDocument: 'after' },
      )
        .select(ALERT_RECORD_PROJECTION)
        .lean<AlertRecordProjection | null>()
        .exec();
      return doc ? toAlertRecord(doc) : null;
    },

    async deleteByIdAndUser(id, userId) {
      const result = await AlertModel.deleteOne({ _id: id, userId }).exec();
      return result.deletedCount > 0;
    },

    async deleteAllByUser(userId) {
      const result = await AlertModel.deleteMany({ userId }).exec();
      return result.deletedCount;
    },

    /**
     * Misma forma que `WatchlistRepo.listByUser` (`$match` -> `$lookup` a
     * `coins` -> `$unwind`), pero CON paginación (`$sort` -> `$skip` ->
     * `$limit`, en ese orden, antes del `$lookup` para no traer la moneda de
     * documentos que la página descarta) — el listado de alertas sí pagina,
     * a diferencia del de watchlist (spec alert-api).
     */
    async listByUser(userId, filter, page, limit) {
      const match: Record<string, unknown> = { userId };
      if (filter.status !== undefined) {
        match.status = { $in: filter.status };
      }
      if (filter.coinId !== undefined) {
        match.coinId = filter.coinId;
      }

      const skip = (page - 1) * limit;

      const [docs, total] = await Promise.all([
        AlertModel.aggregate<AlertListRow>([
          { $match: match },
          { $sort: { createdAt: -1 } },
          { $skip: skip },
          { $limit: limit },
          {
            $lookup: {
              from: 'coins',
              localField: 'coinId',
              foreignField: '_id',
              as: 'coin',
              pipeline: [
                { $project: { _id: 0, coingeckoId: 1, symbol: 1, name: 1, isActive: 1, latest: 1 } },
              ],
            },
          },
          { $unwind: '$coin' },
          {
            $project: {
              _id: 0,
              id: '$_id',
              coinId: 1,
              type: 1,
              threshold: 1,
              mode: 1,
              status: 1,
              cooldownMinutes: 1,
              rearmPct: 1,
              note: 1,
              version: 1,
              triggerCount: 1,
              lastTriggeredAt: 1,
              lastTriggeredValue: 1,
              lastEvaluatedAt: 1,
              createdAt: 1,
              updatedAt: 1,
              coingeckoId: '$coin.coingeckoId',
              symbol: '$coin.symbol',
              name: '$coin.name',
              isActive: '$coin.isActive',
              latest: '$coin.latest',
            },
          },
        ]).exec(),
        AlertModel.countDocuments(match).exec(),
      ]);

      return { docs, total };
    },
  };
}

/**
 * Cantidad de alertas activas (`armed` o `triggered`) de un usuario. Las
 * alertas `completed`/`disabled` no cuentan contra el cap (spec
 * alert-store) — deshabilitar una alerta al tope libera capacidad para una
 * nueva.
 */
export async function countActiveAlerts(
  userId: string,
  repo: AlertsRepo = createAlertsRepo(),
): Promise<number> {
  return repo.countActiveAlerts(new Types.ObjectId(userId));
}

/** Arma un `AlertDtoSource` a partir de un `AlertRecord` de repo más el `coingeckoId` ya resuelto de su moneda. */
function toAlertDtoSource(record: AlertRecord, coingeckoId: string): AlertDtoSource {
  return {
    id: record.id,
    coingeckoId,
    type: record.type,
    threshold: record.threshold,
    mode: record.mode,
    status: record.status,
    cooldownMinutes: record.cooldownMinutes,
    rearmPct: record.rearmPct,
    note: record.note,
    version: record.version,
    triggerCount: record.triggerCount,
    lastTriggeredAt: record.lastTriggeredAt,
    lastTriggeredValue: record.lastTriggeredValue,
    lastEvaluatedAt: record.lastEvaluatedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export interface CreateAlertDeps {
  readonly repo?: AlertsRepo;
  /** Inyectable para tests unitarios; por defecto, `findCoinRefByCoingeckoId` del módulo de monedas. */
  readonly findCoin?: (coingeckoId: string) => Promise<CoinRef | null>;
  readonly cfg?: Pick<Config, 'ALERTS_MAX_ACTIVE'>;
}

export interface CreateAlertResult {
  readonly data: AlertDto;
  readonly meta: {
    readonly currentValue: number | null;
    readonly conditionCurrentlyMet: boolean;
  };
}

/**
 * Alta de una alerta (spec alert-api, `POST /api/v1/me/alerts`). Orden de
 * validaciones FIJO, no reordenable: (1) la forma del body ya la validó la
 * ruta antes de llamar acá; (2) el email del caller está verificado -> 422
 * `UNPROCESSABLE`/`EMAIL_NOT_VERIFIED`; (3) la moneda existe y está activa
 * -> 404 `NOT_FOUND`; (4) el cap de alertas activas no está alcanzado -> 422
 * `UNPROCESSABLE`/`LIMIT_REACHED`.
 *
 * Sin evaluación en el alta: inserta con `status: 'armed'` y nunca llama a
 * `decide()` — en su lugar calcula `meta.currentValue`/`conditionCurrentlyMet`
 * directamente con `isTriggerConditionMet()` sobre el `latest` de la moneda
 * ya resuelta en el paso (3), sin una consulta extra.
 */
export async function createAlert(
  userId: string,
  emailVerified: boolean,
  body: CreateAlertBody,
  deps: CreateAlertDeps = {},
): Promise<CreateAlertResult> {
  if (!emailVerified) {
    throw new UnprocessableError('Verificá tu email antes de crear una alerta', {
      details: { reason: 'EMAIL_NOT_VERIFIED' },
    });
  }

  const repo = deps.repo ?? createAlertsRepo();
  const findCoin = deps.findCoin ?? findCoinRefByCoingeckoId;
  const cfg = deps.cfg ?? config;

  const coin = await findCoin(body.coingeckoId);
  if (!coin || !coin.isActive) {
    throw new NotFoundError('La moneda no está disponible');
  }

  const userObjectId = new Types.ObjectId(userId);
  const currentCount = await repo.countActiveAlerts(userObjectId);
  if (currentCount >= cfg.ALERTS_MAX_ACTIVE) {
    throw new UnprocessableError('Alcanzaste el límite de alertas activas', {
      details: { reason: 'LIMIT_REACHED' },
    });
  }

  const created = await repo.insert({
    userId: userObjectId,
    coinId: coin.id,
    type: body.type,
    threshold: body.threshold,
    mode: body.mode,
    cooldownMinutes: body.cooldownMinutes,
    rearmPct: body.rearmPct,
    note: body.note,
  });

  // `latest: null` -> todavía no evaluable: `conditionCurrentlyMet: false` y
  // `currentValue: null` sin llamar a `isTriggerConditionMet` con ceros
  // fabricados (spec alert-api).
  const value: AlertValue | null = coin.latest
    ? { priceUsd: coin.latest.priceUsd, change24hPct: coin.latest.change24hPct }
    : null;
  const conditionCurrentlyMet = value ? isTriggerConditionMet(body.type, body.threshold, value) : false;
  const currentValue = value
    ? body.type === 'CHANGE_24H_ABS_GTE'
      ? value.change24hPct
      : value.priceUsd
    : null;

  return {
    data: toAlertDto(toAlertDtoSource(created, coin.coingeckoId)),
    meta: { currentValue, conditionCurrentlyMet },
  };
}

export interface ListAlertsDeps {
  readonly repo?: AlertsRepo;
  readonly findCoin?: (coingeckoId: string) => Promise<CoinRef | null>;
}

/**
 * Fuente de datos de `GET /api/v1/me/alerts` (spec alert-api). Cuando
 * `coingeckoId` no matchea ninguna moneda, devuelve una página vacía en vez
 * de un error — un filtro que no matchea nada es, semánticamente, un
 * resultado vacío, no una entrada inválida (decisión de diseño: el filtro no
 * es un recurso direccionado, a diferencia de `GET /:id`).
 */
export async function listAlerts(
  userId: string,
  query: AlertListQuery,
  deps: ListAlertsDeps = {},
): Promise<PaginatedResult<AlertListItemDto>> {
  const repo = deps.repo ?? createAlertsRepo();
  const findCoin = deps.findCoin ?? findCoinRefByCoingeckoId;

  let coinId: Types.ObjectId | undefined;
  if (query.coingeckoId !== undefined) {
    const coin = await findCoin(query.coingeckoId);
    if (!coin) {
      return { data: [], meta: buildPaginationMeta(query.page, query.limit, 0) };
    }
    coinId = coin.id;
  }

  const { docs, total } = await repo.listByUser(
    new Types.ObjectId(userId),
    { status: query.status, coinId },
    query.page,
    query.limit,
  );

  const data: AlertListItemDto[] = docs.map((row) =>
    toAlertListItemDto(row satisfies AlertListItemDtoSource),
  );

  return { data, meta: buildPaginationMeta(query.page, query.limit, total) };
}

export interface GetAlertDeps {
  readonly repo?: AlertsRepo;
  readonly findCoinById?: (coinId: Types.ObjectId) => Promise<CoinRef | null>;
}

/**
 * Fuente de datos de `GET /api/v1/me/alerts/:id` (spec alert-api). Consulta
 * siempre `{ _id, userId }` juntos, nunca `{ _id }` seguido de un chequeo de
 * ownership aparte — así una alerta de otro usuario da exactamente el mismo
 * 404 que una inexistente, nunca un 403 que revele que el id existe.
 */
export async function getAlertById(
  userId: string,
  id: string,
  deps: GetAlertDeps = {},
): Promise<AlertDto> {
  const repo = deps.repo ?? createAlertsRepo();
  const findCoinById = deps.findCoinById ?? findCoinRefById;

  const alert = await repo.findByIdAndUser(new Types.ObjectId(id), new Types.ObjectId(userId));
  if (!alert) {
    throw new NotFoundError('Alerta no encontrada');
  }

  const coin = await findCoinById(alert.coinId);
  if (!coin) {
    // No debería pasar nunca (las monedas se desactivan, no se borran) —
    // defensivo, para no propagar un TypeError sin traducir si pasara.
    throw new InternalError('No se pudo resolver la moneda de la alerta');
  }

  return toAlertDto(toAlertDtoSource(alert, coin.coingeckoId));
}

export interface UpdateAlertDeps {
  readonly repo?: AlertsRepo;
  readonly findCoinById?: (coinId: Types.ObjectId) => Promise<CoinRef | null>;
  readonly cfg?: Pick<Config, 'ALERTS_MAX_ACTIVE'>;
}

/**
 * Edición de una alerta (spec alert-api, `PATCH /api/v1/me/alerts/:id`).
 * Algoritmo fijo, en este orden:
 * 1. Carga la alerta actual por `{ _id, userId }` -> 404 si no existe.
 * 2. Arma `$set` solo con las claves presentes en el body.
 * 3. Resuelve la transición de `status`, en prioridad:
 *    a. `enabled === false` -> siempre `disabled`, gana sobre cualquier otra cosa.
 *    b. `enabled === true` -> solo aplica si el status ACTUAL es
 *       `disabled`/`completed` (si ya está `armed`/`triggered` es un no-op
 *       de status); cuando aplica, chequea el cap antes de tocar nada más.
 *    c. En cualquier otro caso (sin `enabled`, o `enabled: true` que fue
 *       no-op) -> si cambia `threshold` y el status ACTUAL es `triggered`,
 *       rearma a `armed`.
 * 4. Siempre `$inc: { version: 1 }`.
 * 5. Aplica con `findOneAndUpdate({ _id, userId }, ...)` — el mismo filtro
 *    del paso 1 es alcance de ownership, no concurrencia optimista.
 */
export async function updateAlert(
  userId: string,
  id: string,
  body: PatchAlertBody,
  deps: UpdateAlertDeps = {},
): Promise<AlertDto> {
  const repo = deps.repo ?? createAlertsRepo();
  const findCoinById = deps.findCoinById ?? findCoinRefById;
  const cfg = deps.cfg ?? config;

  const userObjectId = new Types.ObjectId(userId);
  const alertObjectId = new Types.ObjectId(id);

  const current = await repo.findByIdAndUser(alertObjectId, userObjectId);
  if (!current) {
    throw new NotFoundError('Alerta no encontrada');
  }

  // `type` es inmutable y no viaja en el body de PATCH, así que el rango
  // válido de `threshold` se revalida acá contra el `type` ya guardado:
  // `findOneAndUpdate` no corre el validador del schema por defecto, y sin
  // este chequeo una alerta CHANGE_24H_ABS_GTE podría terminar con un
  // threshold de miles de puntos porcentuales.
  if (body.threshold !== undefined && !isThresholdInRange(current.type, body.threshold)) {
    throw new ValidationError('threshold fuera de rango para el tipo de alerta', {
      details: [{ path: 'body.threshold', message: 'threshold fuera de rango para el tipo de alerta' }],
    });
  }

  const set: { -readonly [K in keyof AlertPatchSet]?: AlertPatchSet[K] } = {};
  if (body.threshold !== undefined) set.threshold = body.threshold;
  if (body.cooldownMinutes !== undefined) set.cooldownMinutes = body.cooldownMinutes;
  if (body.rearmPct !== undefined) set.rearmPct = body.rearmPct;
  if (body.note !== undefined) set.note = body.note;
  if (body.mode !== undefined) set.mode = body.mode;

  // (3a) `enabled: false` siempre gana.
  let enabledApplied = false;
  if (body.enabled === false) {
    set.status = 'disabled';
  } else if (body.enabled === true) {
    // (3b) Solo aplica si el status ACTUAL es disabled/completed; re-habilitar
    // algo ya armed/triggered es un no-op de status.
    if (current.status === 'disabled' || current.status === 'completed') {
      const activeCount = await repo.countActiveAlerts(userObjectId);
      if (activeCount >= cfg.ALERTS_MAX_ACTIVE) {
        throw new UnprocessableError('Alcanzaste el límite de alertas activas', {
          details: { reason: 'LIMIT_REACHED' },
        });
      }
      set.status = 'armed';
      enabledApplied = true;
    }
  }

  // (3c) Sin `enabled` en el body, o `enabled: true` que resultó no-op:
  // cambiar `threshold` sobre una alerta `triggered` la rearma.
  if (body.enabled !== false && !enabledApplied) {
    if (body.threshold !== undefined && current.status === 'triggered') {
      set.status = 'armed';
    }
  }

  const updated = await repo.updateByIdAndUser(alertObjectId, userObjectId, set);
  if (!updated) {
    throw new NotFoundError('Alerta no encontrada');
  }

  const coin = await findCoinById(updated.coinId);
  if (!coin) {
    throw new InternalError('No se pudo resolver la moneda de la alerta');
  }

  return toAlertDto(toAlertDtoSource(updated, coin.coingeckoId));
}

export interface DeleteAlertDeps {
  readonly repo?: AlertsRepo;
  readonly cancelNotifications?: (alertId: Types.ObjectId) => Promise<void>;
}

/**
 * Baja de una alerta (spec alert-api, `DELETE /api/v1/me/alerts/:id`).
 * Siempre 204: ni una alerta inexistente ni una de otro usuario producen un
 * error (mismo criterio de idempotencia que `removeWatchlistItem`). Cuando
 * sí existía y era del caller, borra el documento y después mueve sus
 * notificaciones `pending` a `cancelled` (nunca toca una `sending`, ya
 * reclamada por un job de envío) vía
 * `cancelPendingNotificationsForAlert` del módulo de notifications.
 */
export async function deleteAlert(
  userId: string,
  id: string,
  deps: DeleteAlertDeps = {},
): Promise<void> {
  const repo = deps.repo ?? createAlertsRepo();
  const cancelNotifications = deps.cancelNotifications ?? cancelPendingNotificationsForAlert;

  const alertObjectId = new Types.ObjectId(id);
  const userObjectId = new Types.ObjectId(userId);

  const deleted = await repo.deleteByIdAndUser(alertObjectId, userObjectId);
  if (!deleted) {
    return;
  }

  await cancelNotifications(alertObjectId);
}

/**
 * Elimina todas las alertas de un usuario (spec account-deletion-cascade).
 * La llama `usersService.deleteAccount(userId)`, después de borrar el
 * historial de notificaciones del usuario y antes de borrar sus
 * `watchlist_items` — este módulo nunca sabe nada de `users`, solo borra sus
 * propios documentos cuando se lo piden explícitamente (mismo patrón que
 * `deleteAllWatchlistItemsForUser`). Idempotente: un `deleteMany` sobre una
 * colección ya vacía para ese `userId` no falla, solo reporta `0` eliminadas.
 */
export async function deleteAllAlertsForUser(
  userId: string,
  repo: AlertsRepo = createAlertsRepo(),
): Promise<number> {
  return repo.deleteAllByUser(new Types.ObjectId(userId));
}

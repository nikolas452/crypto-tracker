import mongoose, { Types, type ClientSession } from 'mongoose';
import type { Logger } from 'pino';
import { config } from '../config/env.js';
import { decide, type AlertDecisionInput, type AlertValue } from '../modules/alerts/alerts.decide.js';
import { AlertModel, type AlertType } from '../modules/alerts/alerts.model.js';
import { NotificationModel } from '../modules/notifications/notifications.model.js';
import { UserModel } from '../modules/users/users.model.js';

/**
 * La forma mínima que necesita este módulo de un documento de `AlertModel`.
 * `handleTrigger()` es genérica sobre esto (en lugar de anotar `alert` con
 * el `AlertDocument` exportado por `alerts.model.ts`) porque ese export
 * asume las opciones de schema por defecto de `HydratedDocument`, que no
 * reflejan `versionKey: false` (declarado en el schema real) — anotar con
 * ese tipo nominal rechaza el documento real, estructuralmente distinto,
 * que de verdad entrega `AlertModel.find(...).cursor()`. La inferencia
 * genérica evita ese desajuste sin perder chequeo de tipos.
 */
interface AlertLike {
  readonly _id: Types.ObjectId;
  readonly userId: Types.ObjectId;
  readonly coinId: Types.ObjectId;
  readonly type: AlertType;
  readonly mode: 'once' | 'recurring';
  readonly threshold: number;
  readonly version: number;
  readonly note?: string | null;
}

/**
 * Paso de evaluación de alertas del job `poll-prices` (spec
 * alert-evaluation). Vive en su propio archivo, separado de
 * `src/jobs/pollPrices.ts`, porque es la parte más pesada de todo el job
 * (transacciones, optimistic concurrency, dedupe idempotente, rollback) y
 * mantenerla ahí adentro haría crecer `run()` sin límite. Usa los modelos de
 * Mongoose directamente (`AlertModel`/`NotificationModel`/`UserModel`) en
 * lugar de un repositorio inyectado más — este paso es inherentemente
 * transaccional, y la única pieza que de verdad necesita ser inyectable para
 * testear (el insert de la notificación, para forzar un fallo no-duplicado
 * en el rollback de la transacción) ya lo es vía `deps.insertNotification`.
 */

/** El valor de mercado de una moneda en ESTA corrida (spec alert-evaluation: nunca uno stale de otra corrida). */
export type CoinValueEntry = AlertValue;

/** Los datos de una moneda que necesita el `payload` congelado de una notificación. */
export interface CoinInfoEntry {
  readonly coingeckoId: string;
  readonly name: string;
  readonly symbol: string;
}

export interface AlertEvaluationStats {
  alertsEvaluated: number;
  alertsTriggered: number;
  alertsRearmed: number;
  alertsInCooldown: number;
  triggerConflicts: number;
}

function emptyStats(): AlertEvaluationStats {
  return {
    alertsEvaluated: 0,
    alertsTriggered: 0,
    alertsRearmed: 0,
    alertsInCooldown: 0,
    triggerConflicts: 0,
  };
}

export interface EvaluateAlertsInput {
  /** Solo las monedas que recibieron un snapshot NUEVO en esta corrida (`docsToInsert` de `pollPrices.ts`). */
  readonly coinValueMap: ReadonlyMap<string, CoinValueEntry>;
  readonly coinInfoMap: ReadonlyMap<string, CoinInfoEntry>;
  /** El mismo reloj (`startedAt`) para toda la corrida — nunca un `clock.now()` distinto por alerta. */
  readonly now: Date;
  readonly logger: Logger;
}

/** El `payload` congelado de una notificación (mismo shape que `notificationPayloadSchema`). */
export interface NotificationPayloadInput {
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

export interface InsertNotificationInput {
  readonly userId: Types.ObjectId;
  readonly alertId: Types.ObjectId;
  readonly to: string;
  readonly dedupeKey: string;
  readonly payload: NotificationPayloadInput;
  readonly nextAttemptAt: Date;
}

/** Inyectable para tests: por defecto, un `NotificationModel.create([...], { session })` real. */
export type InsertNotificationFn = (
  input: InsertNotificationInput,
  session: ClientSession,
) => Promise<void>;

export interface EvaluateAlertsDeps {
  readonly insertNotification?: InsertNotificationFn;
  /**
   * Solo para tests (task 6.12 / E5-7): se invoca justo antes del
   * `findOneAndUpdate` optimista de un TRIGGER, con la alerta tal como la
   * leyó el cursor. Existe porque una corrida real de `evaluateAlerts()` no
   * expone ningún punto donde un test pueda interponer una escritura
   * concurrente exactamente en la ventana entre la lectura del cursor y esta
   * escritura — este hook abre esa ventana de forma determinística para
   * simular esa carrera (por ejemplo, bumpeando `version` desde afuera de la
   * transacción). Nunca se pasa en producción.
   */
  readonly onBeforeTriggerWrite?: (alert: AlertLike) => Promise<void>;
}

async function defaultInsertNotification(
  input: InsertNotificationInput,
  session: ClientSession,
): Promise<void> {
  await NotificationModel.create(
    [
      {
        userId: input.userId,
        alertId: input.alertId,
        channel: 'email',
        to: input.to,
        status: 'pending',
        dedupeKey: input.dedupeKey,
        payload: input.payload,
        attempts: 0,
        maxAttempts: config.NOTIFY_MAX_ATTEMPTS,
        nextAttemptAt: input.nextAttemptAt,
      },
    ],
    { session },
  );
}

/**
 * `true` cuando `caught` es el error nativo de clave duplicada de MongoDB
 * (E11000) — mismo chequeo de `.code` que `users.service.ts` /
 * `watchlist.service.ts`, más una revisión de `writeErrors[0].code` porque
 * acá el insert pasa por `Model.create([doc], { session })` (la forma
 * idiomática de Mongoose para crear con `session`), que internamente usa
 * `insertMany` y puede envolver el E11000 en un `MongoBulkWriteError` en
 * lugar de exponerlo directo en `.code` según la versión del driver.
 */
function isDuplicateKeyError(caught: unknown): boolean {
  if (typeof caught !== 'object' || caught === null) {
    return false;
  }
  const err = caught as { code?: unknown; writeErrors?: Array<{ code?: unknown }> };
  if (err.code === 11000) {
    return true;
  }
  return Array.isArray(err.writeErrors) && err.writeErrors.some((writeError) => writeError.code === 11000);
}

/**
 * Sentinelas de control de flujo, nunca expuestas fuera de este módulo: se
 * lanzan DENTRO del callback de `session.withTransaction()` para forzar su
 * abort automático, y se atrapan justo afuera para tratar ese abort como una
 * rama normal del algoritmo (nunca como un fallo que deba escalar al
 * degradado `ALERT_EVALUATION_FAILED` de `pollPrices.ts`). Cualquier OTRO
 * error lanzado dentro del callback (por ejemplo, el insert de notificación
 * fallando por una razón que no sea clave duplicada) no se atrapa acá a
 * propósito: debe propagar tal cual, para que `withTransaction` haga el
 * rollback completo y el caller de `evaluateAlerts()` lo trate como el
 * fallo inesperado que `pollPrices.ts` degrada a `partial`.
 */
class TriggerConflictSentinel extends Error {}
class SkipMissingUserSentinel extends Error {}
/**
 * DESVIACIÓN DELIBERADA de la redacción literal de la spec ("catch it INSIDE
 * the transaction callback... let the transaction commit"): se verificó
 * empíricamente contra un replica set real (`MongoMemoryReplSet`) que un
 * error de escritura dentro de una transacción multi-documento (incluido un
 * E11000) deja esa transacción en un estado que MongoDB ya no puede
 * comprometer — `commitTransaction()` sigue fallando, y como ese fallo viene
 * etiquetado `TransientTransactionError`, `session.withTransaction()` lo
 * reintenta el callback COMPLETO indefinidamente (loop infinito real,
 * confirmado con un script aislado). Atrapar el E11000 y simplemente
 * `return` para "dejar que siga committeando" NUNCA termina de commitear:
 * cuelga el job para siempre. La alternativa segura y la que este código
 * implementa: tratar el E11000 como motivo de abort explícito (misma
 * mecánica de sentinela que un conflicto de versión), de modo que la
 * transacción completa — incluido el flip de la alerta — haga rollback
 * limpio en un solo intento, en vez de quedar en un estado no-committeable
 * que `withTransaction` reintenta para siempre.
 */
class DuplicateNotificationSentinel extends Error {}

/**
 * Maneja la decisión TRIGGER de una alerta (spec alert-evaluation, pasos
 * 4a-4e): flip de estado con optimistic concurrency + carga del usuario +
 * insert de la notificación, todo dentro de una única transacción.
 */
async function handleTrigger<TAlert extends AlertLike>(
  alert: TAlert,
  value: CoinValueEntry,
  coinInfo: CoinInfoEntry | undefined,
  input: EvaluateAlertsInput,
  stats: AlertEvaluationStats,
  insertNotification: InsertNotificationFn,
  onBeforeTriggerWrite?: (alert: TAlert) => Promise<void>,
): Promise<void> {
  const { now, logger } = input;
  const alertId = alert._id.toString();

  const triggeringValue = alert.type === 'CHANGE_24H_ABS_GTE' ? value.change24hPct : value.priceUsd;
  // `decide()` solo devuelve TRIGGER para CHANGE_24H_ABS_GTE cuando
  // change24hPct no es null (isTriggerConditionMet lo garantiza), así que
  // esto nunca debería pasar — pero se guarda igual para no persistir un
  // `lastTriggeredValue: null` silencioso si algún día esa garantía cambia.
  if (triggeringValue === null) {
    logger.warn({ alertId }, 'poll-prices: TRIGGER decision with a null triggering value; skipping');
    return;
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const nextStatus = alert.mode === 'once' ? 'completed' : 'triggered';

      if (onBeforeTriggerWrite) {
        await onBeforeTriggerWrite(alert);
      }

      const updated = await AlertModel.findOneAndUpdate(
        { _id: alert._id, version: alert.version, status: 'armed' },
        {
          $set: {
            status: nextStatus,
            lastTriggeredAt: now,
            lastTriggeredValue: triggeringValue,
            lastEvaluatedAt: now,
          },
          $inc: { version: 1, triggerCount: 1 },
        },
        { returnDocument: 'after', session },
      ).exec();

      if (updated === null) {
        // Conflicto de versión: otro writer cambió la alerta entre la
        // lectura del cursor y esta escritura. No es un error — rama normal
        // del algoritmo (paso 4b): nada se escribe, se cuenta y se sigue.
        stats.triggerConflicts += 1;
        throw new TriggerConflictSentinel();
      }

      const user = await UserModel.findById(alert.userId).session(session).exec();
      const userEmail = user?.email ?? null;
      if (!user || user.emailVerified !== true || !userEmail) {
        logger.warn(
          { alertId, userId: alert.userId.toString() },
          'poll-prices: alert triggered but its user is missing, has no verified email, or has ' +
            'no email on file; rolling back so the alert stays armed',
        );
        throw new SkipMissingUserSentinel();
      }

      const dedupeKey = `${alertId}:${updated.triggerCount}`;

      try {
        await insertNotification(
          {
            userId: alert.userId,
            alertId: alert._id,
            to: userEmail,
            dedupeKey,
            payload: {
              coingeckoId: coinInfo?.coingeckoId ?? '',
              coinName: coinInfo?.name ?? '',
              symbol: coinInfo?.symbol ?? '',
              alertType: alert.type,
              threshold: alert.threshold,
              value: triggeringValue,
              priceUsd: value.priceUsd,
              change24hPct: value.change24hPct,
              triggeredAt: now,
              note: alert.note ?? null,
            },
            nextAttemptAt: now,
          },
          session,
        );
      } catch (caught) {
        if (isDuplicateKeyError(caught)) {
          // Este disparo exacto (alertId + triggerCount) ya había producido
          // una notificación en otro intento. Ver el comentario de
          // `DuplicateNotificationSentinel`: no se puede simplemente atrapar
          // y seguir committeando (cuelga el job), así que se aborta la
          // transacción completa — la alerta queda tal como estaba antes de
          // este intento, sin una segunda notificación duplicada.
          logger.warn(
            { alertId, dedupeKey },
            'poll-prices: duplicate notification dedupeKey; aborting this attempt (already recorded elsewhere)',
          );
          throw new DuplicateNotificationSentinel();
        }
        // Cualquier otro fallo de insert: propaga tal cual (comentario de
        // cabecera de las sentinelas) para que la transacción completa
        // (incluido el flip de la alerta) haga rollback.
        throw caught;
      }
    });

    stats.alertsTriggered += 1;
  } catch (caught) {
    if (
      caught instanceof TriggerConflictSentinel ||
      caught instanceof SkipMissingUserSentinel ||
      caught instanceof DuplicateNotificationSentinel
    ) {
      return;
    }
    throw caught;
  } finally {
    await session.endSession();
  }
}

/**
 * Evalúa todas las alertas `armed`/`triggered` de las monedas que recibieron
 * un snapshot nuevo en esta corrida (spec alert-evaluation). Itera con un
 * cursor de Mongoose — nunca carga el conjunto completo en un array.
 *
 * Cualquier excepción que escape de acá (un error del cursor, o un fallo de
 * insert no-duplicado dentro de un TRIGGER) es intencional: el caller
 * (`pollPrices.ts`) la atrapa y degrada la corrida completa a `partial` con
 * `ALERT_EVALUATION_FAILED`, preservando los snapshots ya insertados.
 */
export async function evaluateAlerts(
  input: EvaluateAlertsInput,
  deps: EvaluateAlertsDeps = {},
): Promise<{ stats: AlertEvaluationStats }> {
  const insertNotification = deps.insertNotification ?? defaultInsertNotification;
  const stats = emptyStats();

  const coinIds = [...input.coinValueMap.keys()].map((id) => new Types.ObjectId(id));
  if (coinIds.length === 0) {
    return { stats };
  }

  const cursor = AlertModel.find({
    coinId: { $in: coinIds },
    status: { $in: ['armed', 'triggered'] },
  }).cursor();

  for await (const alert of cursor) {
    stats.alertsEvaluated += 1;

    const value = input.coinValueMap.get(alert.coinId.toString());
    if (!value) {
      // Defensivo: no debería pasar, el filtro `$in` del cursor ya acota a
      // las monedas presentes en coinValueMap.
      continue;
    }

    const decisionInput: AlertDecisionInput = {
      type: alert.type,
      status: alert.status,
      threshold: alert.threshold,
      rearmPct: alert.rearmPct,
      cooldownMinutes: alert.cooldownMinutes,
      lastTriggeredAt: alert.lastTriggeredAt ?? null,
    };

    const decision = decide(decisionInput, value, input.now);

    switch (decision) {
      case 'TRIGGER': {
        const coinInfo = input.coinInfoMap.get(alert.coinId.toString());
        await handleTrigger(
          alert,
          value,
          coinInfo,
          input,
          stats,
          insertNotification,
          deps.onBeforeTriggerWrite,
        );
        break;
      }

      case 'REARM': {
        const result = await AlertModel.updateOne(
          { _id: alert._id, version: alert.version, status: 'triggered' },
          { $set: { status: 'armed', lastEvaluatedAt: input.now }, $inc: { version: 1 } },
        ).exec();
        if (result.modifiedCount > 0) {
          stats.alertsRearmed += 1;
        }
        break;
      }

      case 'COOLDOWN':
        // Sin escritura, ni siquiera `lastEvaluatedAt` (spec
        // alert-evaluation / comentario de `alerts.model.ts`).
        stats.alertsInCooldown += 1;
        break;

      case 'NOOP':
        break;
    }
  }

  return { stats };
}

import type { Agenda, JobWithId } from 'agenda';
import type { Db } from 'mongodb';
import type { Logger } from 'pino';
import type { Clock } from '../lib/clock.js';
import { JobFailedError } from './adapters.js';
import { AGENDA_JOBS_COLLECTION, JOB_NAMES } from './agenda.js';

/**
 * Política de reintentos de `poll-prices` (spec job-retry-policy),
 * implementada como un listener `fail:poll-prices` en lugar de una opción
 * nativa de Agenda: la 6.2.6 instalada no documenta reintentos automáticos.
 * `send-notifications` y `maintenance` deliberadamente NO tienen retry — el
 * primero porque su reclamo atómico por notificación ya es seguro de
 * reintentar en su propio próximo tick, y el segundo porque un housekeeping
 * diario que falló hoy simplemente corre de nuevo mañana; agregarles un
 * listener sería una complejidad sin ningún beneficio de correctitud.
 */

const MINUTE_MS = 60_000;
const RETRY_DELAY_MS = 2 * MINUTE_MS;
const IMMINENT_THRESHOLD_MS = 3 * MINUTE_MS;

/** Códigos de fallo transitorios: vale la pena reintentarlos porque es plausible que el segundo intento tenga éxito. */
export const TRANSIENT_ERROR_CODES = [
  'COINGECKO_UNAVAILABLE',
  'COINGECKO_RATE_LIMITED',
  'ALERT_EVALUATION_FAILED',
] as const;

/**
 * Clasificador puro (spec: "Retry on transient failures only" / "No retry
 * for non-transient failures"). `COINGECKO_AUTH` e `INTERNAL` — y cualquier
 * código fuera de la lista — nunca se reintentan: una falla de autenticación
 * va a volver a fallar exactamente igual, y reintentarla solo gasta un run.
 */
export function isTransientErrorCode(code: string | undefined): boolean {
  return code !== undefined && (TRANSIENT_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * `true` cuando falta menos de 3 minutos para `nextRunAt` (spec: "No retry
 * when the next scheduled run is imminent") — un reintento que cae justo
 * antes de la corrida regular sería pura duplicación.
 */
export function isRetryImminent(nextRunAt: Date | null, now: Date): boolean {
  if (nextRunAt === null) {
    return false;
  }
  return nextRunAt.getTime() - now.getTime() < IMMINENT_THRESHOLD_MS;
}

interface PollPricesJobData {
  readonly trigger?: string;
  readonly attempt?: number;
}

async function getRecurringNextRunAt(db: Db): Promise<Date | null> {
  const doc = await db
    .collection(AGENDA_JOBS_COLLECTION)
    .findOne(
      { name: JOB_NAMES.POLL_PRICES, type: 'single' },
      { projection: { nextRunAt: 1 } },
    );
  return (doc?.nextRunAt as Date | undefined) ?? null;
}

export interface RegisterRetryPolicyDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly maxRetries: number;
}

/**
 * Registra el listener `fail:poll-prices` que implementa la política de
 * reintentos completa: clasifica el código de error, respeta el tope de
 * `maxRetries`, consulta el `nextRunAt` del documento recurrente para la
 * regla de "corrida inminente", y agenda el reintento con
 * `agenda.schedule(Date, ...)` — un `Date` explícito en lugar de un string
 * como `'2 minutes'` para no depender de cómo Agenda interprete ese string
 * (ver la nota sobre `human-interval` en los tests del scheduler).
 */
export function registerRetryPolicy(agenda: Agenda, deps: RegisterRetryPolicyDeps): void {
  const { db, clock, logger, maxRetries } = deps;

  agenda.on(`fail:${JOB_NAMES.POLL_PRICES}`, (error: Error, job: JobWithId) => {
    void (async () => {
      const code = error instanceof JobFailedError ? error.code : undefined;

      if (!isTransientErrorCode(code)) {
        logger.info(
          { jobName: JOB_NAMES.POLL_PRICES, code },
          'poll-prices: non-transient failure; no retry scheduled',
        );
        return;
      }

      const data = job.attrs.data as PollPricesJobData | undefined;
      const currentAttempt = data?.attempt ?? 1;

      if (currentAttempt >= maxRetries + 1) {
        logger.warn(
          { jobName: JOB_NAMES.POLL_PRICES, code, currentAttempt, maxRetries },
          'poll-prices: retry budget exhausted; no further retry scheduled',
        );
        return;
      }

      const now = clock.now();
      const nextRunAt = await getRecurringNextRunAt(db);

      if (isRetryImminent(nextRunAt, now)) {
        logger.info(
          { jobName: JOB_NAMES.POLL_PRICES, nextRunAt },
          'poll-prices: next recurring run is imminent; no retry scheduled',
        );
        return;
      }

      const attempt = currentAttempt + 1;
      const runAt = new Date(now.getTime() + RETRY_DELAY_MS);

      await agenda.schedule(runAt, JOB_NAMES.POLL_PRICES, {
        trigger: 'retry',
        attempt,
        parentJobId: job.attrs._id.toString(),
      });

      logger.warn(
        { jobName: JOB_NAMES.POLL_PRICES, code, attempt, runAt },
        'poll-prices: transient failure; retry scheduled',
      );
    })();
  });
}

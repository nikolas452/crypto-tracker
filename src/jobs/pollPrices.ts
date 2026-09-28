import { Types } from 'mongoose';
import type { Logger } from 'pino';
import type { Clock } from '../lib/clock.js';
import type { CoinsRepo } from '../modules/coins/coins.service.js';
import type { NewSnapshotInput, SnapshotsRepo } from '../modules/snapshots/snapshots.service.js';
import {
  EMPTY_JOB_RUN_STATS,
  type JobRunError,
  type JobRunsRepo,
  type JobRunStats,
} from '../modules/job-runs/job-runs.service.js';
import type { JobSkipReason, JobStatus, JobTrigger } from '../modules/job-runs/job-runs.model.js';
import type { CoinGeckoClient } from '../integrations/coingecko/coingecko.types.js';
import { CoinGeckoError } from '../integrations/coingecko/coingecko.errors.js';
import {
  evaluateAlerts,
  type AlertEvaluationStats,
  type CoinInfoEntry,
  type CoinValueEntry,
  type EvaluateAlertsDeps,
  type EvaluateAlertsInput,
} from './alertEvaluation.js';

export const JOB_NAME = 'poll-prices';

export interface CreatePollPricesJobDeps {
  readonly coinsRepo: CoinsRepo;
  readonly snapshotsRepo: SnapshotsRepo;
  readonly jobRunsRepo: JobRunsRepo;
  readonly coingecko: Pick<CoinGeckoClient, 'getSimplePrices'>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly workerId: string;
  /**
   * Punto de extensión para el job `send-notifications` (tarea 6.10,
   * ahora sí conectado desde `worker.ts`: pasa ahí el disparo real del job
   * `send-notifications` a través de su propia guarda de solapamiento,
   * fire-and-forget — ver el comentario de `sendGuard` en `worker.ts`).
   * `pollPrices.ts` sigue sin saber nada de `send-notifications` más allá
   * de esta función: llama al hook a ciegas y nunca lo espera ni deja que
   * afecte el estado/timing de la corrida actual. Por defecto un no-op
   * (los tests unitarios de este archivo, que no levantan un worker
   * completo, nunca lo pasan).
   */
  readonly triggerSendNotifications?: () => void;
  /** Inyectable para tests: overridea el insert de notificación del paso de evaluación de alertas. */
  readonly alertEvaluationDeps?: EvaluateAlertsDeps;
  /**
   * Inyectable para tests: por defecto, la implementación real de
   * `evaluateAlerts()` (`src/jobs/alertEvaluation.ts`), que usa
   * `AlertModel`/`NotificationModel`/`UserModel` directamente y por lo tanto
   * necesita una conexión Mongoose activa. Los tests de integración de
   * `alertEvaluation.test.ts` la dejan sin overridear (corren contra un Mongo
   * real); los unitarios de `pollPrices.test.ts`, que no levantan Mongo,
   * la overridean con un fake — mismo criterio de inyección que
   * `coinsRepo`/`snapshotsRepo`/`coingecko`.
   */
  readonly evaluateAlerts?: (
    input: EvaluateAlertsInput,
    evalDeps?: EvaluateAlertsDeps,
  ) => Promise<{ stats: AlertEvaluationStats }>;
}

export interface JobRunResult {
  readonly runId: Types.ObjectId;
  readonly status: JobStatus;
  readonly skipReason?: JobSkipReason;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly durationMs: number;
  readonly stats: JobRunStats;
  readonly error: JobRunError | null;
}

export interface PollPricesJob {
  run(trigger: JobTrigger): Promise<JobRunResult>;
}

function toJobRunError(caught: unknown): JobRunError {
  if (caught instanceof CoinGeckoError) {
    return { code: caught.internalCode, message: caught.message };
  }
  if (caught instanceof Error) {
    return { code: 'INTERNAL', message: caught.message };
  }
  return { code: 'INTERNAL', message: 'Unknown error' };
}

/**
 * Factory del job `poll-prices` (RF-1.4). La función `run()` devuelta NO
 * tiene conocimiento de ningún scheduler, guarda de solapamiento o cron —
 * `worker.ts` es el único módulo que sabe de eso. `run()` nunca lanza una
 * excepción: cualquier excepción se captura, cierra la corrida como
 * `failed`, y se loguea con su stack acá (el documento `JobRun` en sí nunca
 * recibe un stack ni un secreto).
 */
export function createPollPricesJob(deps: CreatePollPricesJobDeps): PollPricesJob {
  const { coinsRepo, snapshotsRepo, jobRunsRepo, coingecko, clock, logger, workerId } = deps;
  const triggerSendNotifications = deps.triggerSendNotifications ?? (() => {});
  const evaluateAlertsFn = deps.evaluateAlerts ?? evaluateAlerts;

  return {
    async run(trigger) {
      const startedAt = clock.now();

      let runId: Types.ObjectId;
      try {
        runId = await jobRunsRepo.createRunning({
          jobName: JOB_NAME,
          trigger,
          startedAt,
          workerId,
        });
      } catch (caught) {
        // Ni siquiera se pudo abrir un documento JobRun (por ejemplo, Mongo
        // inalcanzable). No hay nada que cerrar, pero `run()` igual nunca
        // debe lanzar una excepción.
        logger.error(
          { err: caught, jobName: JOB_NAME, trigger },
          'poll-prices: failed to create the JobRun document',
        );
        const finishedAt = clock.now();
        return {
          runId: new Types.ObjectId(),
          status: 'failed',
          startedAt,
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          stats: { ...EMPTY_JOB_RUN_STATS },
          error: toJobRunError(caught),
        };
      }

      logger.info(
        { runId: runId.toString(), jobName: JOB_NAME, trigger },
        'poll-prices run started',
      );

      async function closeRun(
        status: Exclude<JobStatus, 'running'>,
        stats: JobRunStats,
        error: JobRunError | null,
        skipReason?: JobSkipReason,
      ): Promise<JobRunResult> {
        const finishedAt = clock.now();
        const durationMs = finishedAt.getTime() - startedAt.getTime();

        try {
          await jobRunsRepo.closeRun(runId, {
            status,
            finishedAt,
            durationMs,
            stats,
            error,
            skipReason,
          });
        } catch (persistError) {
          // Caso límite de RF-1.4: si no se le puede escribir nada a Mongo,
          // el documento queda en "running" para que la recuperación de
          // corridas obsoletas de RF-1.6 lo reconcilie en el próximo
          // arranque — pero `run()` igual nunca lanza una excepción.
          logger.error(
            { runId: runId.toString(), err: persistError },
            'poll-prices: failed to persist the run closure; it will be recovered as stale on next startup',
          );
        }

        logger.info(
          { runId: runId.toString(), jobName: JOB_NAME, trigger, status, durationMs, stats },
          'poll-prices run finished',
        );

        return { runId, status, skipReason, startedAt, finishedAt, durationMs, stats, error };
      }

      try {
        const activeCoins = await coinsRepo.findActive();

        if (activeCoins.length === 0) {
          return await closeRun('skipped', { ...EMPTY_JOB_RUN_STATS }, null, 'no_active_coins');
        }

        const coingeckoIds = activeCoins.map((coin) => coin.coingeckoId);
        const { prices, attempts } = await coingecko.getSimplePrices(coingeckoIds);
        const lastUpdatedByCoingeckoId = await snapshotsRepo.getLastSourceUpdatedAt(coingeckoIds);

        const missingCoins: string[] = [];
        const docsToInsert: NewSnapshotInput[] = [];
        let skippedUnchanged = 0;

        for (const coin of activeCoins) {
          const price = prices.get(coin.coingeckoId);
          if (!price) {
            missingCoins.push(coin.coingeckoId);
            continue;
          }

          const lastSourceUpdatedAt = lastUpdatedByCoingeckoId.get(coin.coingeckoId) ?? null;
          const newSourceUpdatedAt = price.sourceUpdatedAt;
          const bothKnown = lastSourceUpdatedAt !== null && newSourceUpdatedAt !== null;
          const unchanged =
            bothKnown && lastSourceUpdatedAt.getTime() === newSourceUpdatedAt.getTime();

          if (unchanged) {
            skippedUnchanged += 1;
            continue;
          }

          docsToInsert.push({
            timestamp: startedAt,
            coinId: coin.id,
            coingeckoId: coin.coingeckoId,
            priceUsd: price.priceUsd,
            marketCapUsd: price.marketCapUsd,
            volume24hUsd: price.volume24hUsd,
            change24hPct: price.change24hPct,
            sourceUpdatedAt: price.sourceUpdatedAt,
          });
        }

        const snapshotsInserted = await snapshotsRepo.insertMany(docsToInsert);

        if (missingCoins.length > 0) {
          logger.warn(
            { runId: runId.toString(), missingCoins },
            'poll-prices: some requested coins were not returned by CoinGecko',
          );
        }

        // Actualiza coins.latest para cada moneda que obtuvo un snapshot
        // nuevo en esta corrida (spec price-polling-job). Un bulkWrite
        // fallido degrada la corrida a `partial` en lugar de hacerla
        // fallar: los snapshots de arriba ya son durables, y `latest` es un
        // caché que la próxima corrida reconstruye.
        let latestUpdated = 0;
        let latestUpdateError: JobRunError | null = null;

        if (docsToInsert.length > 0) {
          try {
            const refreshResult = await coinsRepo.refreshLatest(
              docsToInsert.map((doc) => ({
                coinId: doc.coinId,
                priceUsd: doc.priceUsd,
                marketCapUsd: doc.marketCapUsd,
                volume24hUsd: doc.volume24hUsd,
                change24hPct: doc.change24hPct,
                capturedAt: doc.timestamp,
                sourceUpdatedAt: doc.sourceUpdatedAt,
              })),
            );
            latestUpdated = refreshResult.modifiedCount;
          } catch (caught) {
            logger.error(
              { runId: runId.toString(), err: caught },
              'poll-prices: failed to refresh coins.latest; snapshots already inserted are kept',
            );
            latestUpdateError = {
              code: 'LATEST_UPDATE_FAILED',
              message: 'Failed to refresh coins.latest after inserting snapshots',
            };
          }
        }

        // Evaluación de alertas (spec alert-evaluation): solo sobre las
        // monedas que recibieron un snapshot NUEVO en esta corrida
        // (docsToInsert), nunca sobre todo activeCoins. Un fallo acá nunca
        // hace fallar la corrida entera: degrada a `partial` con
        // `ALERT_EVALUATION_FAILED`, preservando los snapshots y el refresh
        // de `latest` ya hechos arriba (mismo patrón "upgrade only, never
        // downgrade" que latestUpdateError).
        let alertStats = {
          alertsEvaluated: 0,
          alertsTriggered: 0,
          alertsRearmed: 0,
          alertsInCooldown: 0,
          triggerConflicts: 0,
        };
        let alertEvaluationError: JobRunError | null = null;

        if (docsToInsert.length > 0) {
          const coinValueMap = new Map<string, CoinValueEntry>(
            docsToInsert.map((doc) => [
              doc.coinId.toString(),
              { priceUsd: doc.priceUsd, change24hPct: doc.change24hPct },
            ]),
          );
          const coinInfoMap = new Map<string, CoinInfoEntry>(
            activeCoins.map((coin) => [
              coin.id.toString(),
              { coingeckoId: coin.coingeckoId, name: coin.name, symbol: coin.symbol },
            ]),
          );

          try {
            const evaluationResult = await evaluateAlertsFn(
              { coinValueMap, coinInfoMap, now: startedAt, logger },
              deps.alertEvaluationDeps,
            );
            alertStats = evaluationResult.stats;
          } catch (caught) {
            logger.error(
              { runId: runId.toString(), err: caught },
              'poll-prices: alert evaluation failed; snapshots and the coins.latest refresh already done are kept',
            );
            alertEvaluationError = {
              code: 'ALERT_EVALUATION_FAILED',
              message: 'Alert evaluation failed unexpectedly',
            };
          }
        }

        const stats: JobRunStats = {
          ...EMPTY_JOB_RUN_STATS,
          coinsRequested: activeCoins.length,
          coinsReturned: prices.size,
          snapshotsInserted,
          skippedUnchanged,
          missingCoins,
          upstreamAttempts: attempts,
          latestUpdated,
          ...alertStats,
        };

        const allMissing = missingCoins.length === activeCoins.length;
        let status: Exclude<JobStatus, 'running'> =
          missingCoins.length === 0 ? 'success' : allMissing ? 'failed' : 'partial';
        let error: JobRunError | null = allMissing
          ? {
              code: 'COINGECKO_NO_COINS_RETURNED',
              message: 'CoinGecko returned none of the requested coins',
            }
          : null;

        if (latestUpdateError && status !== 'failed') {
          status = 'partial';
          error = latestUpdateError;
        }

        if (alertEvaluationError && status !== 'failed') {
          status = 'partial';
          error = alertEvaluationError;
        }

        // Punto de extensión de la tarea 6.10, conectado desde `worker.ts`:
        // fire-and-forget, nunca esperado, nunca puede afectar el
        // status/timing de esta corrida — ver el comentario de
        // `triggerSendNotifications` en `CreatePollPricesJobDeps`.
        if (status !== 'failed' && stats.alertsTriggered > 0) {
          try {
            triggerSendNotifications();
          } catch (caught) {
            logger.error(
              { runId: runId.toString(), err: caught },
              'poll-prices: triggerSendNotifications hook threw',
            );
          }
        }

        return await closeRun(status, stats, error);
      } catch (caught) {
        logger.error(
          { runId: runId.toString(), err: caught },
          'poll-prices run failed with an unexpected error',
        );
        return await closeRun('failed', { ...EMPTY_JOB_RUN_STATS }, toJobRunError(caught));
      }
    },
  };
}

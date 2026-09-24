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

export const JOB_NAME = 'poll-prices';

export interface CreatePollPricesJobDeps {
  readonly coinsRepo: CoinsRepo;
  readonly snapshotsRepo: SnapshotsRepo;
  readonly jobRunsRepo: JobRunsRepo;
  readonly coingecko: Pick<CoinGeckoClient, 'getSimplePrices'>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly workerId: string;
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

        const stats: JobRunStats = {
          coinsRequested: activeCoins.length,
          coinsReturned: prices.size,
          snapshotsInserted,
          skippedUnchanged,
          missingCoins,
          upstreamAttempts: attempts,
          latestUpdated,
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

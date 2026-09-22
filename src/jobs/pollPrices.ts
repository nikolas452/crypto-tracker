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
 * Factory for the `poll-prices` job (RF-1.4). The returned `run()` function
 * has NO knowledge of any scheduler, overlap guard or cron — `worker.ts` is
 * the only module that knows about those. `run()` never throws: any
 * exception is caught, closes the run as `failed`, and is logged with its
 * stack here (the `JobRun` document itself never gets a stack or a secret).
 */
export function createPollPricesJob(deps: CreatePollPricesJobDeps): PollPricesJob {
  const { coinsRepo, snapshotsRepo, jobRunsRepo, coingecko, clock, logger, workerId } = deps;

  return {
    async run(trigger) {
      const startedAt = clock.now();

      let runId: Types.ObjectId;
      try {
        runId = await jobRunsRepo.createRunning({ jobName: JOB_NAME, trigger, startedAt, workerId });
      } catch (caught) {
        // Can't even open a JobRun document (e.g. Mongo unreachable). There's
        // nothing to close, but `run()` must still never throw.
        logger.error({ err: caught, jobName: JOB_NAME, trigger }, 'poll-prices: failed to create the JobRun document');
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

      logger.info({ runId: runId.toString(), jobName: JOB_NAME, trigger }, 'poll-prices run started');

      async function closeRun(
        status: Exclude<JobStatus, 'running'>,
        stats: JobRunStats,
        error: JobRunError | null,
        skipReason?: JobSkipReason,
      ): Promise<JobRunResult> {
        const finishedAt = clock.now();
        const durationMs = finishedAt.getTime() - startedAt.getTime();

        try {
          await jobRunsRepo.closeRun(runId, { status, finishedAt, durationMs, stats, error, skipReason });
        } catch (persistError) {
          // RF-1.4 edge case: if Mongo can't be written to at all, the
          // document is left "running" for RF-1.6's stale-run recovery to
          // reconcile on the next startup — but `run()` still never throws.
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
          const unchanged = bothKnown && lastSourceUpdatedAt.getTime() === newSourceUpdatedAt.getTime();

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

        const stats: JobRunStats = {
          coinsRequested: activeCoins.length,
          coinsReturned: prices.size,
          snapshotsInserted,
          skippedUnchanged,
          missingCoins,
          upstreamAttempts: attempts,
        };

        const allMissing = missingCoins.length === activeCoins.length;
        const status = missingCoins.length === 0 ? 'success' : allMissing ? 'failed' : 'partial';
        const error: JobRunError | null = allMissing
          ? { code: 'COINGECKO_NO_COINS_RETURNED', message: 'CoinGecko returned none of the requested coins' }
          : null;

        return await closeRun(status, stats, error);
      } catch (caught) {
        logger.error({ runId: runId.toString(), err: caught }, 'poll-prices run failed with an unexpected error');
        return await closeRun('failed', { ...EMPTY_JOB_RUN_STATS }, toJobRunError(caught));
      }
    },
  };
}

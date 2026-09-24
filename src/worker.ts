import { schedule, validate, type ScheduledTask } from 'node-cron';
import { assertCoinGeckoApiKey, config } from './config/env.js';
import { logger } from './lib/logger.js';
import { connectDb, disconnectDb } from './db/connect.js';
import { ensureCollections } from './db/ensureCollections.js';
import { systemClock } from './lib/clock.js';
import { createWorkerId } from './lib/workerId.js';
import { createOverlapGuard } from './lib/overlapGuard.js';
import { createCoinGeckoClient } from './integrations/coingecko/coingecko.client.js';
import { createCoinsRepo } from './modules/coins/coins.service.js';
import { createSnapshotsRepo } from './modules/snapshots/snapshots.service.js';
import { createJobRunsRepo } from './modules/job-runs/job-runs.service.js';
import { createPollPricesJob, JOB_NAME } from './jobs/pollPrices.js';
import type { JobTrigger } from './modules/job-runs/job-runs.model.js';

const MINUTE_MS = 60_000;

function delay(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * Punto de entrada del proceso del worker: sin servidor HTTP. Secuencia de
 * arranque y apagado de RF-1.6/RF-1.7. `src/jobs/pollPrices.ts` no tiene
 * idea de que nada de esto (cron, guarda de solapamiento, recuperación de
 * corridas obsoletas) existe — este es el único módulo que sí sabe.
 */
async function main(): Promise<void> {
  assertCoinGeckoApiKey(config, logger);

  await connectDb(config.MONGODB_URI, config.MONGODB_DB_NAME, logger, {
    isProduction: config.NODE_ENV === 'production',
  });
  await ensureCollections(logger);

  const workerId = createWorkerId();
  const jobRunsRepo = createJobRunsRepo();

  // RF-1.6 paso 3: la recuperación de corridas obsoletas corre una vez, antes de programar nada.
  const now = systemClock.now();
  const staleThreshold = new Date(now.getTime() - config.STALE_RUN_THRESHOLD_MIN * MINUTE_MS);
  const recoveredCount = await jobRunsRepo.recoverStaleRuns(staleThreshold, now);
  if (recoveredCount > 0) {
    logger.warn(
      { recoveredCount, staleRunThresholdMin: config.STALE_RUN_THRESHOLD_MIN },
      'Recovered JobRun(s) left running by a previous worker process',
    );
  }

  if (!validate(config.POLL_PRICES_CRON)) {
    logger.fatal(
      { cron: config.POLL_PRICES_CRON },
      'Invalid POLL_PRICES_CRON expression; refusing to start.',
    );
    process.exit(1);
    return;
  }

  const coingecko = createCoinGeckoClient({
    baseUrl: config.COINGECKO_BASE_URL,
    apiKey: config.COINGECKO_API_KEY,
    timeoutMs: config.COINGECKO_TIMEOUT_MS,
    maxRetries: config.COINGECKO_MAX_RETRIES,
    maxIdsPerCall: config.COINGECKO_MAX_IDS_PER_CALL,
    logger,
  });
  const coinsRepo = createCoinsRepo();
  const snapshotsRepo = createSnapshotsRepo();

  const job = createPollPricesJob({
    coinsRepo,
    snapshotsRepo,
    jobRunsRepo,
    coingecko,
    clock: systemClock,
    logger,
    workerId,
  });

  // RF-1.5: guarda de solapamiento en memoria. Vive acá, no en el job.
  const guard = createOverlapGuard<JobTrigger, unknown>({
    run: (trigger) => job.run(trigger),
    onOverlap: async (trigger) => {
      logger.warn(
        { jobName: JOB_NAME, trigger },
        'poll-prices: overlap detected; skipping this tick',
      );
      const overlapAt = systemClock.now();
      await jobRunsRepo.createSkipped({
        jobName: JOB_NAME,
        trigger,
        skipReason: 'overlap',
        at: overlapAt,
        workerId,
      });
    },
  });

  const activeCoinsCount = (await coinsRepo.findActive()).length;

  const task: ScheduledTask = schedule(
    config.POLL_PRICES_CRON,
    () => {
      void guard.runGuarded('schedule');
    },
    { timezone: 'UTC', name: JOB_NAME },
  );

  logger.info({ workerId, cron: config.POLL_PRICES_CRON, activeCoinsCount }, 'Worker started');

  if (config.POLL_PRICES_RUN_ON_START) {
    void guard.runGuarded('startup');
  }

  // --- RF-1.7: apagado ordenado ---
  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    logger.info({ signal }, 'Worker shutdown initiated');

    await task.stop();

    if (guard.isRunning() && guard.currentRun()) {
      const { promise: timeoutPromise, cancel } = delay(config.WORKER_SHUTDOWN_TIMEOUT_MS);
      await Promise.race([guard.currentRun(), timeoutPromise]);
      cancel();
    }

    if (guard.isRunning()) {
      logger.error(
        { timeoutMs: config.WORKER_SHUTDOWN_TIMEOUT_MS },
        'Worker shutdown timed out waiting for an in-progress run; exiting without touching its JobRun document',
      );
      process.exit(1);
      return;
    }

    await disconnectDb();
    logger.info('Worker shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection in worker');
  });

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception in worker');
  });
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Fatal error during worker startup');
  process.exit(1);
});

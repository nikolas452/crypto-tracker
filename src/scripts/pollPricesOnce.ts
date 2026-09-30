import { fileURLToPath } from 'node:url';
import { assertCoinGeckoApiKey, config } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { connectDb, disconnectDb } from '../db/connect.js';
import { ensureCollections } from '../db/ensureCollections.js';
import { systemClock } from '../lib/clock.js';
import { createWorkerId } from '../lib/workerId.js';
import { acquire, release } from '../lib/lease-lock.js';
import { createCoinGeckoClient } from '../integrations/coingecko/coingecko.client.js';
import { createCoinsRepo } from '../modules/coins/coins.service.js';
import { createSnapshotsRepo } from '../modules/snapshots/snapshots.service.js';
import { createJobRunsRepo } from '../modules/job-runs/job-runs.service.js';
import { createPollPricesJob, JOB_NAME, type JobRunResult } from '../jobs/pollPrices.js';

/**
 * `npm run job:poll-prices` (RF-1.8): ejecuta el job `poll-prices` exactamente
 * una vez con `trigger: "manual"`, imprime el resultado y termina.
 *
 * Desde la fase 6 adquiere el mismo lease (`src/lib/lease-lock.ts`) que el
 * adaptador de Agenda (`src/scheduler/adapters.ts`) antes de correr: si el
 * worker ya tiene `poll-prices` en curso, este script queda `skipped` con
 * `skipReason: "locked"` en lugar de competir por los mismos datos de
 * CoinGecko — resolviendo la limitación documentada en la etapa 1 (un run
 * manual podía solapar con el del worker).
 */
export function exitCodeFor(status: JobRunResult['status']): 0 | 1 {
  return status === 'failed' ? 1 : 0;
}

function printResult(result: JobRunResult): void {
  console.log(
    `job:poll-prices result: status=${result.status}${result.skipReason ? ` skipReason=${result.skipReason}` : ''} durationMs=${result.durationMs}`,
  );
  console.log(`stats: ${JSON.stringify(result.stats)}`);
  if (result.error) {
    console.log(`error: ${result.error.code} - ${result.error.message}`);
  }
}

async function main(): Promise<void> {
  assertCoinGeckoApiKey(config, logger);

  await connectDb(config.MONGODB_URI, config.MONGODB_DB_NAME, logger, {
    isProduction: config.NODE_ENV === 'production',
    maxPoolSize: config.MONGODB_MAX_POOL_SIZE,
  });
  await ensureCollections(logger);

  const coingecko = createCoinGeckoClient({
    baseUrl: config.COINGECKO_BASE_URL,
    apiKey: config.COINGECKO_API_KEY,
    timeoutMs: config.COINGECKO_TIMEOUT_MS,
    maxRetries: config.COINGECKO_MAX_RETRIES,
    maxIdsPerCall: config.COINGECKO_MAX_IDS_PER_CALL,
    logger,
  });

  const jobRunsRepo = createJobRunsRepo();
  const workerId = createWorkerId();
  const owner = `${workerId}:manual-script`;

  const acquired = await acquire(JOB_NAME, owner, config.POLL_LOCK_TTL_MS, systemClock.now());

  if (!acquired) {
    const at = systemClock.now();
    await jobRunsRepo.createSkipped({
      jobName: JOB_NAME,
      trigger: 'manual',
      skipReason: 'locked',
      at,
      workerId,
    });
    console.log('job:poll-prices result: status=skipped skipReason=locked (lease held by another run)');
    await disconnectDb();
    process.exitCode = 0;
    return;
  }

  try {
    const job = createPollPricesJob({
      coinsRepo: createCoinsRepo(),
      snapshotsRepo: createSnapshotsRepo(),
      jobRunsRepo,
      coingecko,
      clock: systemClock,
      logger,
      workerId,
    });

    const result = await job.run('manual');
    printResult(result);

    process.exitCode = exitCodeFor(result.status);
  } finally {
    await release(JOB_NAME, owner);
    await disconnectDb();
  }
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  main().catch((err: unknown) => {
    logger.fatal({ err }, 'job:poll-prices failed');
    process.exitCode = 1;
  });
}

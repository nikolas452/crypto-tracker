import { fileURLToPath } from 'node:url';
import { assertCoinGeckoApiKey, config } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { connectDb, disconnectDb } from '../db/connect.js';
import { ensureCollections } from '../db/ensureCollections.js';
import { systemClock } from '../lib/clock.js';
import { createWorkerId } from '../lib/workerId.js';
import { createCoinGeckoClient } from '../integrations/coingecko/coingecko.client.js';
import { createCoinsRepo } from '../modules/coins/coins.service.js';
import { createSnapshotsRepo } from '../modules/snapshots/snapshots.service.js';
import { createJobRunsRepo } from '../modules/job-runs/job-runs.service.js';
import { createPollPricesJob, type JobRunResult } from '../jobs/pollPrices.js';

/**
 * `npm run job:poll-prices` (RF-1.8): ejecuta el job `poll-prices` exactamente
 * una vez con `trigger: "manual"`, imprime el resultado y termina.
 *
 * NO se coordina con la guarda de solapamiento en memoria del worker — ese
 * flag vive solo dentro de la memoria del proceso del worker. Si este script
 * corre mientras el worker está a mitad de un tick, ambos pueden ejecutarse
 * concurrentemente; la propia deduplicación del job (por `sourceUpdatedAt`,
 * una agregación por corrida) es lo que evita datos de snapshot duplicados
 * en ese caso, no un lock compartido. La coordinación real entre procesos
 * queda diferida a la etapa 6 (locking basado en Agenda).
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

  const job = createPollPricesJob({
    coinsRepo: createCoinsRepo(),
    snapshotsRepo: createSnapshotsRepo(),
    jobRunsRepo: createJobRunsRepo(),
    coingecko,
    clock: systemClock,
    logger,
    workerId: createWorkerId(),
  });

  const result = await job.run('manual');
  printResult(result);

  await disconnectDb();

  process.exitCode = exitCodeFor(result.status);
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  main().catch((err: unknown) => {
    logger.fatal({ err }, 'job:poll-prices failed');
    process.exitCode = 1;
  });
}

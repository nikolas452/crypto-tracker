import { fileURLToPath } from 'node:url';
import { assertCoinGeckoApiKey, config } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { connectDb, disconnectDb } from '../db/connect.js';
import { ensureCollections } from '../db/ensureCollections.js';
import { createCoinGeckoClient } from '../integrations/coingecko/coingecko.client.js';
import { findCoinIdByCoingeckoId } from '../modules/coins/coins.service.js';
import {
  createSnapshotsRepo,
  getSnapshotTimestamps,
} from '../modules/snapshots/snapshots.service.js';
import type { NewSnapshotInput } from '../modules/snapshots/snapshots.service.js';
import type { BackfillHistorySummary, RunBackfillHistoryDeps } from './support/types.js';
import {
  UPSTREAM_CALLS_PER_RUN,
  confirm,
  parseBackfillArgs,
  printBackfillHistorySummary,
} from './support/utils.js';

/**
 * Script `backfill:history` (11.4/11.5): importa un rango histórico de
 * `market_chart` de CoinGecko para una moneda, insertando solo los puntos
 * cuyo timestamp de upstream todavía no está almacenado.
 */

/**
 * Lógica pura de importación (11.4/11.5 / spec data-maintenance-scripts): un
 * punto cuyo timestamp exacto de upstream ya existe para esta moneda se
 * OMITE, nunca se borra y reemplaza — borrarlo descartaría un punto
 * genuinamente obtenido por polling a favor de uno importado de menor
 * resolución (design.md). El `timestamp` y `sourceUpdatedAt` de cada
 * snapshot insertado se setean al propio timestamp de upstream de ese
 * punto, nunca a "ahora".
 */
export async function runBackfillHistory(
  deps: RunBackfillHistoryDeps,
): Promise<BackfillHistorySummary> {
  const { coingeckoId, coinId, points, getExistingTimestamps, insertSnapshots } = deps;

  if (points.length === 0) {
    return { imported: 0, skipped: 0 };
  }

  const timestampsMs = points.map((point) => point.timestamp.getTime());
  const from = new Date(Math.min(...timestampsMs));
  const to = new Date(Math.max(...timestampsMs));

  const existing = await getExistingTimestamps(coingeckoId, from, to);

  const docs: NewSnapshotInput[] = [];
  let skipped = 0;

  for (const point of points) {
    if (existing.has(point.timestamp.getTime())) {
      skipped += 1;
      continue;
    }
    docs.push({
      timestamp: point.timestamp,
      coinId,
      coingeckoId,
      priceUsd: point.priceUsd,
      marketCapUsd: point.marketCapUsd,
      volume24hUsd: point.volume24hUsd,
      change24hPct: null,
      sourceUpdatedAt: point.timestamp,
    });
  }

  const imported = await insertSnapshots(docs);

  return { imported, skipped };
}

async function main(): Promise<void> {
  assertCoinGeckoApiKey(config, logger);

  const { coingeckoId, days, skipConfirm } = parseBackfillArgs(process.argv.slice(2));

  console.log(
    `backfill:history will fetch market_chart for "${coingeckoId}" (days=${days}), consuming ${UPSTREAM_CALLS_PER_RUN} CoinGecko API call from the monthly quota.`,
  );

  if (!skipConfirm && !(await confirm('Proceed?'))) {
    console.log('Aborted: not confirmed.');
    process.exitCode = 1;
    return;
  }

  await connectDb(config.MONGODB_URI, config.MONGODB_DB_NAME, logger, {
    isProduction: config.NODE_ENV === 'production',
  });
  await ensureCollections(logger);

  const coinId = await findCoinIdByCoingeckoId(coingeckoId);
  if (!coinId) {
    logger.fatal({ coingeckoId }, 'backfill:history: unknown coin (run seed:coins first)');
    await disconnectDb();
    process.exitCode = 1;
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

  const points = await coingecko.getMarketChart(coingeckoId, days);
  const snapshotsRepo = createSnapshotsRepo();

  const summary = await runBackfillHistory({
    coingeckoId,
    coinId,
    points,
    getExistingTimestamps: getSnapshotTimestamps,
    insertSnapshots: (docs) => snapshotsRepo.insertMany(docs),
  });
  printBackfillHistorySummary(summary);

  await disconnectDb();

  process.exitCode = 0;
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  main().catch((err: unknown) => {
    logger.fatal({ err }, 'backfill:history failed');
    process.exitCode = 1;
  });
}

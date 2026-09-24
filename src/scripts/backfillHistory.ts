import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import type { Types } from 'mongoose';
import { assertCoinGeckoApiKey, config } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { connectDb, disconnectDb } from '../db/connect.js';
import { ensureCollections } from '../db/ensureCollections.js';
import { createCoinGeckoClient } from '../integrations/coingecko/coingecko.client.js';
import type { MarketChartPoint } from '../integrations/coingecko/coingecko.types.js';
import { COINGECKO_ID_PATTERN } from '../modules/coins/coins.model.js';
import { findCoinIdByCoingeckoId } from '../modules/coins/coins.service.js';
import {
  createSnapshotsRepo,
  getSnapshotTimestamps,
} from '../modules/snapshots/snapshots.service.js';
import type { NewSnapshotInput } from '../modules/snapshots/snapshots.service.js';

/**
 * Script `backfill:history` (11.4/11.5): importa un rango histórico de
 * `market_chart` de CoinGecko para una moneda, insertando solo los puntos
 * cuyo timestamp de upstream todavía no está almacenado.
 */

/**
 * `backfill:history` consume exactamente una llamada a CoinGecko por
 * invocación: `/coins/{id}/market_chart` nunca se fracciona (a diferencia de
 * `/simple/price` o `/coins/markets`, que se agrupan por `maxIdsPerCall`),
 * porque solo acepta un único id de moneda.
 */
export const UPSTREAM_CALLS_PER_RUN = 1;

export interface BackfillArgs {
  readonly coingeckoId: string;
  readonly days: number;
  readonly skipConfirm: boolean;
}

/** Parsea `<coingeckoId> --days <n> [--yes|--force]`. Lanza con un mensaje de uso ante una entrada inválida. */
export function parseArgs(argv: readonly string[]): BackfillArgs {
  const positional: string[] = [];
  let daysArg: string | undefined;
  let skipConfirm = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--days') {
      i += 1;
      daysArg = argv[i];
    } else if (arg === '--yes' || arg === '--force') {
      skipConfirm = true;
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }

  const coingeckoId = positional[0]?.trim().toLowerCase();
  const days = daysArg !== undefined ? Number(daysArg) : NaN;

  if (!coingeckoId || !COINGECKO_ID_PATTERN.test(coingeckoId)) {
    throw new Error('Usage: npm run backfill:history -- <coingeckoId> --days <n> [--yes|--force]');
  }
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error(
      '--days must be a positive integer. Usage: npm run backfill:history -- <coingeckoId> --days <n> [--yes|--force]',
    );
  }

  return { coingeckoId, days, skipConfirm };
}

async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${message} [y/N] `);
    return ['y', 'yes'].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

export interface BackfillHistorySummary {
  readonly imported: number;
  readonly skipped: number;
}

export interface RunBackfillHistoryDeps {
  readonly coingeckoId: string;
  readonly coinId: Types.ObjectId;
  readonly points: readonly MarketChartPoint[];
  /** Inyectado para que los tests unitarios nunca toquen una base de datos real. */
  readonly getExistingTimestamps: (
    coingeckoId: string,
    from: Date,
    to: Date,
  ) => Promise<Set<number>>;
  readonly insertSnapshots: (docs: readonly NewSnapshotInput[]) => Promise<number>;
}

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

function printSummary(summary: BackfillHistorySummary): void {
  console.log(`backfill:history summary: imported=${summary.imported} skipped=${summary.skipped}`);
}

async function main(): Promise<void> {
  assertCoinGeckoApiKey(config, logger);

  const { coingeckoId, days, skipConfirm } = parseArgs(process.argv.slice(2));

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
  printSummary(summary);

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

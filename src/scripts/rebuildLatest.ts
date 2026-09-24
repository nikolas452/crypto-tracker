import { fileURLToPath } from 'node:url';
import { config } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { connectDb, disconnectDb } from '../db/connect.js';
import { ensureCollections } from '../db/ensureCollections.js';
import {
  createCoinsRepo,
  findAllCoinIds,
  type LatestRefreshInput,
} from '../modules/coins/coins.service.js';
import { getLatestSnapshotsByCoin } from '../modules/snapshots/snapshots.service.js';

export interface RebuildLatestSummary {
  /** Cantidad de monedas cuyo `latest` fue efectivamente sobrescrito. */
  readonly updated: number;
  /** Monedas sin ningún documento de `price_snapshots` — se reportan, no se consideran un fallo. */
  readonly noSnapshots: readonly string[];
}

/**
 * `npm run coins:rebuild-latest` (11.1 / spec data-maintenance-scripts): para
 * cada moneda, sin importar `isActive`, recalcula `latest` a partir del
 * documento de `price_snapshots` más reciente de esa moneda. Reutiliza la
 * guarda de antigüedad ya existente de `CoinsRepo.refreshLatest` (`latest`
 * es `null` o estrictamente anterior al nuevo `capturedAt`) para el write en
 * sí, así que volver a correrlo sin snapshots nuevos no escribe nada y
 * reporta `updated: 0` — la misma garantía de idempotencia de la que ya
 * depende el job poll-prices, no una regla reinventada acá.
 */
export async function runRebuildLatest(): Promise<RebuildLatestSummary> {
  const coins = await findAllCoinIds();
  if (coins.length === 0) {
    return { updated: 0, noSnapshots: [] };
  }

  const latestByCoingeckoId = await getLatestSnapshotsByCoin(coins.map((coin) => coin.coingeckoId));

  const noSnapshots: string[] = [];
  const updates: LatestRefreshInput[] = [];

  for (const coin of coins) {
    const latest = latestByCoingeckoId.get(coin.coingeckoId);
    if (!latest) {
      noSnapshots.push(coin.coingeckoId);
      continue;
    }

    updates.push({
      coinId: coin.id,
      priceUsd: latest.priceUsd,
      marketCapUsd: latest.marketCapUsd,
      volume24hUsd: latest.volume24hUsd,
      change24hPct: latest.change24hPct,
      capturedAt: latest.capturedAt,
      sourceUpdatedAt: latest.sourceUpdatedAt,
    });
  }

  const result = await createCoinsRepo().refreshLatest(updates);

  return { updated: result.modifiedCount, noSnapshots };
}

function printSummary(summary: RebuildLatestSummary): void {
  console.log(
    `coins:rebuild-latest summary: updated=${summary.updated} noSnapshots=${summary.noSnapshots.length}`,
  );
  if (summary.noSnapshots.length > 0) {
    console.log(`Coins with no snapshots: ${summary.noSnapshots.join(', ')}`);
  }
}

async function main(): Promise<void> {
  await connectDb(config.MONGODB_URI, config.MONGODB_DB_NAME, logger, {
    isProduction: config.NODE_ENV === 'production',
  });
  await ensureCollections(logger);

  const summary = await runRebuildLatest();
  printSummary(summary);

  await disconnectDb();

  process.exitCode = 0;
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  main().catch((err: unknown) => {
    logger.fatal({ err }, 'coins:rebuild-latest failed');
    process.exitCode = 1;
  });
}

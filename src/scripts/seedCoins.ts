import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import { assertCoinGeckoApiKey, config } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { connectDb, disconnectDb } from '../db/connect.js';
import { ensureCollections } from '../db/ensureCollections.js';
import { createCoinGeckoClient } from '../integrations/coingecko/coingecko.client.js';
import type { CoinGeckoClient } from '../integrations/coingecko/coingecko.types.js';
import { createCoinsRepo, type CoinsRepo } from '../modules/coins/coins.service.js';

/** RF-1.3's default coin list, used when `seed:coins` runs with no argument. */
export const DEFAULT_COIN_IDS: readonly string[] = [
  'bitcoin',
  'ethereum',
  'solana',
  'cardano',
  'ripple',
  'dogecoin',
  'polkadot',
  'chainlink',
  'litecoin',
  'avalanche-2',
];

/** Trims, lowercases and de-duplicates ids, preserving first-seen order. */
export function normalizeIds(rawIds: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const raw of rawIds) {
    const normalized = raw.trim().toLowerCase();
    if (normalized.length > 0) {
      seen.add(normalized);
    }
  }
  return [...seen];
}

export interface SeedCoinsDeps {
  readonly coingecko: Pick<CoinGeckoClient, 'getMarkets'>;
  readonly coinsRepo: CoinsRepo;
  readonly logger: Logger;
}

export interface SeedSummary {
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly invalid: readonly string[];
}

/**
 * Pure seed logic (RF-1.3): normalizes ids, fetches markets, upserts each
 * returned coin, and reports ids CoinGecko didn't return as invalid. Kept
 * separate from the CLI entrypoint below so it can be unit/integration
 * tested with fake/real dependencies without spawning a process.
 */
export async function runSeedCoins(rawIds: readonly string[], deps: SeedCoinsDeps): Promise<SeedSummary> {
  const ids = normalizeIds(rawIds);
  const markets = await deps.coingecko.getMarkets([...ids]);
  const returnedIds = new Set(markets.map((market) => market.coingeckoId));

  const created: string[] = [];
  const updated: string[] = [];

  for (const market of markets) {
    const result = await deps.coinsRepo.upsertFromMarket({
      coingeckoId: market.coingeckoId,
      symbol: market.symbol,
      name: market.name,
    });
    (result.created ? created : updated).push(result.coingeckoId);
  }

  const invalid = ids.filter((id) => !returnedIds.has(id));
  if (invalid.length > 0) {
    deps.logger.warn({ invalid }, 'seed:coins: some ids were not returned by CoinGecko');
  }

  return { created, updated, invalid };
}

function printSummary(summary: SeedSummary): void {
  console.log(
    `seed:coins summary: created=${summary.created.length} updated=${summary.updated.length} invalid=${summary.invalid.length}`,
  );
  if (summary.invalid.length > 0) {
    console.log(`Invalid ids (not returned by CoinGecko): ${summary.invalid.join(', ')}`);
  }
}

async function main(): Promise<void> {
  assertCoinGeckoApiKey(config, logger);

  await connectDb(config.MONGODB_URI, config.MONGODB_DB_NAME, logger, {
    isProduction: config.NODE_ENV === 'production',
  });
  await ensureCollections(logger);

  const arg = process.argv[2];
  const ids = arg ? arg.split(',') : DEFAULT_COIN_IDS;

  const coingecko = createCoinGeckoClient({
    baseUrl: config.COINGECKO_BASE_URL,
    apiKey: config.COINGECKO_API_KEY,
    timeoutMs: config.COINGECKO_TIMEOUT_MS,
    maxRetries: config.COINGECKO_MAX_RETRIES,
    maxIdsPerCall: config.COINGECKO_MAX_IDS_PER_CALL,
    logger,
  });
  const coinsRepo = createCoinsRepo();

  const summary = await runSeedCoins(ids, { coingecko, coinsRepo, logger });
  printSummary(summary);

  await disconnectDb();

  const validCount = summary.created.length + summary.updated.length;
  process.exitCode = validCount > 0 ? 0 : 1;
}

const isMainModule = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  main().catch((err: unknown) => {
    logger.fatal({ err }, 'seed:coins failed');
    process.exitCode = 1;
  });
}

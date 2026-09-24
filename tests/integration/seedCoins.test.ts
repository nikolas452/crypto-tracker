import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { runSeedCoins, normalizeIds, DEFAULT_COIN_IDS } from '../../src/scripts/seedCoins.js';
import { createCoinsRepo } from '../../src/modules/coins/coins.service.js';
import { CoinModel } from '../../src/modules/coins/coins.model.js';
import type { MarketCoin } from '../../src/integrations/coingecko/coingecko.types.js';
import { clearDatabase, startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';

function createFakeLogger(): Logger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    fatal: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  } as unknown as Logger;
}

function fakeMarketsFor(ids: readonly string[]): MarketCoin[] {
  return ids.map((id) => ({
    coingeckoId: id,
    symbol: id.slice(0, 3),
    name: id,
    priceUsd: 100,
  }));
}

/** Tests de integración del script `seed:coins` de `src/scripts/seedCoins.ts`. */

describe('seed:coins (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 120000);

  afterEach(async () => {
    await clearDatabase();
  });

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  it('normalizes ids: trims, lowercases and de-duplicates', () => {
    expect(normalizeIds([' Bitcoin ', 'BITCOIN', 'ethereum', ''])).toEqual(['bitcoin', 'ethereum']);
  });

  // E1-1: DB vacía, la lista por defecto se crea entera, y una segunda corrida reporta updates (idempotente).
  it('E1-1: seeds the 10 default coins, then a second run reports updates without duplicates', async () => {
    const logger = createFakeLogger();
    const coinsRepo = createCoinsRepo();
    const coingecko = { getMarkets: vi.fn(async (ids: string[]) => fakeMarketsFor(ids)) };

    const firstRun = await runSeedCoins(DEFAULT_COIN_IDS, { coingecko, coinsRepo, logger });
    expect(firstRun.created).toHaveLength(10);
    expect(firstRun.invalid).toHaveLength(0);

    const count = await CoinModel.countDocuments();
    expect(count).toBe(10);

    const secondRun = await runSeedCoins(DEFAULT_COIN_IDS, { coingecko, coinsRepo, logger });
    expect(secondRun.updated).toHaveLength(10);
    expect(secondRun.created).toHaveLength(0);

    const countAfterSecondRun = await CoinModel.countDocuments();
    expect(countAfterSecondRun).toBe(10);
  });

  // E1-2: lista de ids mixta, válidos e inválidos.
  it('E1-2: reports an id CoinGecko does not return as invalid, without inserting it', async () => {
    const logger = createFakeLogger();
    const coinsRepo = createCoinsRepo();
    const coingecko = {
      getMarkets: vi.fn(async (ids: string[]) =>
        fakeMarketsFor(ids.filter((id) => id !== 'no-existe-xyz')),
      ),
    };

    const summary = await runSeedCoins(['bitcoin', 'no-existe-xyz'], {
      coingecko,
      coinsRepo,
      logger,
    });

    expect(summary.created).toEqual(['bitcoin']);
    expect(summary.invalid).toEqual(['no-existe-xyz']);

    const invalidDoc = await CoinModel.findOne({ coingeckoId: 'no-existe-xyz' });
    expect(invalidDoc).toBeNull();
  });

  it('exits with failure semantics when every id is invalid (summary reports zero valid coins)', async () => {
    const logger = createFakeLogger();
    const coinsRepo = createCoinsRepo();
    const coingecko = { getMarkets: vi.fn(async () => []) };

    const summary = await runSeedCoins(['no-existe-xyz'], { coingecko, coinsRepo, logger });

    expect(summary.created).toHaveLength(0);
    expect(summary.updated).toHaveLength(0);
    expect(summary.invalid).toEqual(['no-existe-xyz']);
  });
});

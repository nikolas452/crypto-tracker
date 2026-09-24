import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { ensureCollections } from '../../src/db/ensureCollections.js';
import { CoinModel } from '../../src/modules/coins/coins.model.js';
import { createCoinsRepo } from '../../src/modules/coins/coins.service.js';
import { clearDatabase, startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';

const silentLogger = pino({ level: 'silent' });

// 2.4: coin-catalog — derivación de nameLower, latest por defecto en null y
// los cuatro índices de lectura de api-rest.
describe('coin-catalog: latest / nameLower / indexes (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 120000);

  afterEach(async () => {
    await clearDatabase();
  });

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  it('derives nameLower on save', async () => {
    const coin = await CoinModel.create({ coingeckoId: 'bitcoin', symbol: 'btc', name: 'Bitcoin' });
    expect(coin.nameLower).toBe('bitcoin');
  });

  it('re-derives nameLower when name changes on a later save', async () => {
    const coin = await CoinModel.create({ coingeckoId: 'bitcoin', symbol: 'btc', name: 'Bitcoin' });
    coin.name = 'Bitcoin Renamed';
    await coin.save();
    expect(coin.nameLower).toBe('bitcoin renamed');
  });

  it('derives nameLower on the seed script upsert', async () => {
    const coinsRepo = createCoinsRepo();
    await coinsRepo.upsertFromMarket({ coingeckoId: 'ethereum', symbol: 'ETH', name: 'Ethereum' });

    const doc = await CoinModel.findOne({ coingeckoId: 'ethereum' });
    expect(doc?.nameLower).toBe('ethereum');
  });

  it('a coin that has never been polled has a null latest', async () => {
    const coin = await CoinModel.create({ coingeckoId: 'bitcoin', symbol: 'btc', name: 'Bitcoin' });
    expect(coin.latest).toBeNull();
  });

  it('creates the four api-rest read indexes', async () => {
    await ensureCollections(silentLogger);

    const indexes = await CoinModel.collection.indexes();
    const hasIndex = (key: Record<string, 1 | -1>) =>
      indexes.some((index) => JSON.stringify(index.key) === JSON.stringify(key));

    expect(hasIndex({ isActive: 1, 'latest.marketCapUsd': -1 })).toBe(true);
    expect(hasIndex({ isActive: 1, nameLower: 1 })).toBe(true);
    expect(hasIndex({ isActive: 1, symbol: 1 })).toBe(true);
    expect(hasIndex({ isActive: 1, 'latest.change24hPct': -1 })).toBe(true);
  });
});

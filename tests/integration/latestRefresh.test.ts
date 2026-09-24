import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { ensureCollections } from '../../src/db/ensureCollections.js';
import { CoinModel } from '../../src/modules/coins/coins.model.js';
import { createCoinsRepo } from '../../src/modules/coins/coins.service.js';
import { createSnapshotsRepo } from '../../src/modules/snapshots/snapshots.service.js';
import { createJobRunsRepo } from '../../src/modules/job-runs/job-runs.service.js';
import { createPollPricesJob } from '../../src/jobs/pollPrices.js';
import { createFixedClock } from '../../src/lib/clock.js';
import { clearDatabase, startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';
import type { SimplePrice } from '../../src/integrations/coingecko/coingecko.types.js';

const silentLogger = pino({ level: 'silent' });

/** Tests de integración del refresh de `coins.latest` durante `createPollPricesJob`. */

describe('coins.latest refresh (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
    await ensureCollections(silentLogger);
  }, 120000);

  afterEach(async () => {
    await clearDatabase();
  });

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  // E2-5: tras una corrida, el latest de cada coin coincide con su snapshot más reciente.
  it('E2-5: after a run, every coin latest matches its most recent snapshot', async () => {
    await CoinModel.create({ coingeckoId: 'bitcoin', symbol: 'btc', name: 'Bitcoin' });
    await CoinModel.create({ coingeckoId: 'ethereum', symbol: 'eth', name: 'Ethereum' });

    const runAt = new Date('2026-01-01T00:00:00.000Z');
    const prices = new Map<string, SimplePrice>([
      [
        'bitcoin',
        {
          priceUsd: 50000,
          marketCapUsd: 900_000_000_000,
          volume24hUsd: 20_000_000_000,
          change24hPct: 1.5,
          sourceUpdatedAt: runAt,
        },
      ],
      [
        'ethereum',
        {
          priceUsd: 3000,
          marketCapUsd: 400_000_000_000,
          volume24hUsd: 10_000_000_000,
          change24hPct: -0.5,
          sourceUpdatedAt: runAt,
        },
      ],
    ]);

    const job = createPollPricesJob({
      coinsRepo: createCoinsRepo(),
      snapshotsRepo: createSnapshotsRepo(),
      jobRunsRepo: createJobRunsRepo(),
      coingecko: { getSimplePrices: async () => ({ prices, attempts: 1 }) },
      clock: createFixedClock(runAt),
      logger: silentLogger,
      workerId: 'test-worker',
    });

    const result = await job.run('manual');

    expect(result.status).toBe('success');
    expect(result.stats.latestUpdated).toBe(2);

    const bitcoin = await CoinModel.findOne({ coingeckoId: 'bitcoin' });
    expect(bitcoin?.latest).toMatchObject({
      priceUsd: 50000,
      marketCapUsd: 900_000_000_000,
      volume24hUsd: 20_000_000_000,
      change24hPct: 1.5,
    });
    expect(bitcoin?.latest?.capturedAt.getTime()).toBe(runAt.getTime());

    const ethereum = await CoinModel.findOne({ coingeckoId: 'ethereum' });
    expect(ethereum?.latest).toMatchObject({ priceUsd: 3000 });
    expect(ethereum?.latest?.capturedAt.getTime()).toBe(runAt.getTime());
  });

  // E2-6: aplicar el refresh dos veces con valores de capturedAt en orden
  // inverso (el más nuevo llega primero, el más viejo/lento llega después)
  // debe dejar los valores más nuevos en su lugar.
  it('E2-6: a late-arriving older refresh does not overwrite newer values', async () => {
    const coin = await CoinModel.create({ coingeckoId: 'bitcoin', symbol: 'btc', name: 'Bitcoin' });
    const coinsRepo = createCoinsRepo();

    const olderCapturedAt = new Date('2026-01-01T00:00:00.000Z');
    const newerCapturedAt = new Date('2026-01-01T00:10:00.000Z');

    // El refresh de la corrida más nueva se completa primero...
    const newerResult = await coinsRepo.refreshLatest([
      {
        coinId: coin._id,
        priceUsd: 51000,
        marketCapUsd: null,
        volume24hUsd: null,
        change24hPct: null,
        capturedAt: newerCapturedAt,
        sourceUpdatedAt: newerCapturedAt,
      },
    ]);
    expect(newerResult.modifiedCount).toBe(1);

    // ...luego el refresh de la corrida más vieja (más lenta) llega tarde y no debe ganar.
    const olderResult = await coinsRepo.refreshLatest([
      {
        coinId: coin._id,
        priceUsd: 49000,
        marketCapUsd: null,
        volume24hUsd: null,
        change24hPct: null,
        capturedAt: olderCapturedAt,
        sourceUpdatedAt: olderCapturedAt,
      },
    ]);
    expect(olderResult.modifiedCount).toBe(0);

    const reloaded = await CoinModel.findById(coin._id);
    expect(reloaded?.latest?.priceUsd).toBe(51000);
    expect(reloaded?.latest?.capturedAt.getTime()).toBe(newerCapturedAt.getTime());
  });
});

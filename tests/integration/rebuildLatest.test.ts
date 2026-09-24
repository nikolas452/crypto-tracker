import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import type { Types } from 'mongoose';
import { runRebuildLatest } from '../../src/scripts/rebuildLatest.js';
import { CoinModel } from '../../src/modules/coins/coins.model.js';
import { PriceSnapshotModel } from '../../src/modules/snapshots/snapshots.model.js';
import { ensureCollections } from '../../src/db/ensureCollections.js';
import { clearDatabase, startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';

const silentLogger = pino({ level: 'silent' });

async function insertSnapshot(
  coinId: Types.ObjectId,
  coingeckoId: string,
  timestamp: Date,
  priceUsd: number,
) {
  return PriceSnapshotModel.create({
    timestamp,
    meta: { coinId, coingeckoId },
    priceUsd,
    marketCapUsd: null,
    volume24hUsd: null,
    change24hPct: null,
    sourceUpdatedAt: timestamp,
  });
}

/** Tests de integración del script `coins:rebuild-latest` de `src/scripts/rebuildLatest.ts`. */

describe('coins:rebuild-latest (integration)', () => {
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

  // escenario 11.2 (1): latest se reconstruye a partir del snapshot más nuevo.
  it('populates latest from the newest snapshot and reports it as updated', async () => {
    const bitcoin = await CoinModel.create({
      coingeckoId: 'bitcoin',
      symbol: 'btc',
      name: 'Bitcoin',
    });

    await insertSnapshot(bitcoin._id, 'bitcoin', new Date('2026-01-01T00:00:00.000Z'), 49000);
    await insertSnapshot(bitcoin._id, 'bitcoin', new Date('2026-01-01T00:10:00.000Z'), 50000);

    const summary = await runRebuildLatest();

    expect(summary.updated).toBe(1);
    expect(summary.noSnapshots).toEqual([]);

    const reloaded = await CoinModel.findById(bitcoin._id);
    expect(reloaded?.latest?.priceUsd).toBe(50000);
    expect(reloaded?.latest?.capturedAt.getTime()).toBe(
      new Date('2026-01-01T00:10:00.000Z').getTime(),
    );
  });

  // escenario 11.2 (2): correr el script dos veces no cambia nada la segunda vez.
  it('is a no-op on a second run with no new snapshots', async () => {
    const bitcoin = await CoinModel.create({
      coingeckoId: 'bitcoin',
      symbol: 'btc',
      name: 'Bitcoin',
    });
    await insertSnapshot(bitcoin._id, 'bitcoin', new Date('2026-01-01T00:00:00.000Z'), 50000);

    const firstRun = await runRebuildLatest();
    expect(firstRun.updated).toBe(1);

    const afterFirstRun = await CoinModel.findById(bitcoin._id);

    const secondRun = await runRebuildLatest();
    expect(secondRun.updated).toBe(0);

    const afterSecondRun = await CoinModel.findById(bitcoin._id);
    expect(afterSecondRun?.latest?.priceUsd).toBe(afterFirstRun?.latest?.priceUsd);
    expect(afterSecondRun?.latest?.capturedAt.getTime()).toBe(
      afterFirstRun?.latest?.capturedAt.getTime(),
    );
  });

  // escenario 11.2 (3): una coin sin snapshots se reporta, no falla.
  it('reports a coin with zero snapshots in noSnapshots instead of failing', async () => {
    const bitcoin = await CoinModel.create({
      coingeckoId: 'bitcoin',
      symbol: 'btc',
      name: 'Bitcoin',
    });
    const neverPolled = await CoinModel.create({
      coingeckoId: 'neverpolled',
      symbol: 'nvp',
      name: 'Never Polled',
    });

    await insertSnapshot(bitcoin._id, 'bitcoin', new Date('2026-01-01T00:00:00.000Z'), 50000);

    const summary = await runRebuildLatest();

    expect(summary.updated).toBe(1);
    expect(summary.noSnapshots).toEqual(['neverpolled']);

    const reloaded = await CoinModel.findById(neverPolled._id);
    expect(reloaded?.latest).toBeNull();
  });

  it('includes inactive coins, not just active ones', async () => {
    const delisted = await CoinModel.create({
      coingeckoId: 'delisted',
      symbol: 'del',
      name: 'Delisted',
      isActive: false,
    });
    await insertSnapshot(delisted._id, 'delisted', new Date('2026-01-01T00:00:00.000Z'), 1);

    const summary = await runRebuildLatest();

    expect(summary.updated).toBe(1);
    const reloaded = await CoinModel.findById(delisted._id);
    expect(reloaded?.latest?.priceUsd).toBe(1);
  });
});

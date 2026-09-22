import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import pino from 'pino';
import { ensureCollections } from '../../src/db/ensureCollections.js';
import { CoinModel } from '../../src/modules/coins/coins.model.js';
import { JobRunModel } from '../../src/modules/job-runs/job-runs.model.js';
import { clearDatabase, startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';
import { config } from '../../src/config/env.js';

const silentLogger = pino({ level: 'silent' });

describe('ensureCollections (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 120000);

  afterEach(async () => {
    await clearDatabase();
  });

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  // E1-3: first-ever startup creates price_snapshots as a time-series collection.
  it('E1-3: creates price_snapshots as a time-series collection when it does not exist', async () => {
    const db = mongoose.connection.db;
    if (!db) throw new Error('no db connection');
    await db.dropCollection('price_snapshots').catch(() => undefined);

    await ensureCollections(silentLogger);

    const collections = (await db
      .listCollections({ name: 'price_snapshots' })
      .toArray()) as unknown as Array<{
      options?: { timeseries?: { timeField?: string; metaField?: string } };
    }>;
    expect(collections).toHaveLength(1);
    const options = collections[0]?.options as {
      timeseries?: { timeField?: string; metaField?: string };
    };
    expect(options.timeseries?.timeField).toBe('timestamp');
    expect(options.timeseries?.metaField).toBe('meta');
  });

  it('creates the { "meta.coingeckoId": 1, timestamp: -1 } secondary index', async () => {
    const db = mongoose.connection.db;
    if (!db) throw new Error('no db connection');
    await db.dropCollection('price_snapshots').catch(() => undefined);

    await ensureCollections(silentLogger);

    const indexes = await db.collection('price_snapshots').indexes();
    const hasSecondaryIndex = indexes.some(
      (index) => index.key['meta.coingeckoId'] === 1 && index.key.timestamp === -1,
    );
    expect(hasSecondaryIndex).toBe(true);
  });

  // E1-4: an existing normal collection with the same name fails fast.
  it('E1-4: exits with code 1 when price_snapshots exists as a normal collection', async () => {
    const db = mongoose.connection.db;
    if (!db) throw new Error('no db connection');
    await db.dropCollection('price_snapshots').catch(() => undefined);
    await db.createCollection('price_snapshots');

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const fatalSpy = vi.fn();
    const fatalLogger = { ...silentLogger, fatal: fatalSpy } as unknown as typeof silentLogger;

    await ensureCollections(fatalLogger);

    expect(fatalSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('applies a changed SNAPSHOT_RETENTION_DAYS via collMod without recreating the collection', async () => {
    const db = mongoose.connection.db;
    if (!db) throw new Error('no db connection');
    await db.dropCollection('price_snapshots').catch(() => undefined);

    await ensureCollections(silentLogger, { ...config, SNAPSHOT_RETENTION_DAYS: 10 });
    await ensureCollections(silentLogger, { ...config, SNAPSHOT_RETENTION_DAYS: 20 });

    const collections = (await db
      .listCollections({ name: 'price_snapshots' })
      .toArray()) as unknown as Array<{ options?: { expireAfterSeconds?: number } }>;
    expect(collections[0]?.options?.expireAfterSeconds).toBe(20 * 86400);
  });

  it('ensures coin uniqueness and job_runs TTL index with the configured retention', async () => {
    await ensureCollections(silentLogger);

    const coinIndexes = await CoinModel.collection.indexes();
    const uniqueCoingeckoIdIndex = coinIndexes.find((index) => index.key.coingeckoId === 1);
    expect(uniqueCoingeckoIdIndex?.unique).toBe(true);

    const jobRunIndexes = await JobRunModel.collection.indexes();
    const ttlIndex = jobRunIndexes.find(
      (index) => index.key.startedAt === 1 && index.expireAfterSeconds !== undefined,
    );
    expect(ttlIndex?.expireAfterSeconds).toBe(config.JOB_RUNS_RETENTION_DAYS * 86400);
  });
});

describe('coin uniqueness (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 120000);

  afterEach(async () => {
    await clearDatabase();
  });

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  it('rejects a duplicate coingeckoId at the database level', async () => {
    await ensureCollections(silentLogger);

    await CoinModel.create({ coingeckoId: 'bitcoin', symbol: 'btc', name: 'Bitcoin' });

    await expect(
      CoinModel.create({ coingeckoId: 'bitcoin', symbol: 'btc', name: 'Bitcoin (dup)' }),
    ).rejects.toThrow();
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import pino from 'pino';
import { CoinModel } from '../../src/modules/coins/coins.model.js';
import { JobRunModel } from '../../src/modules/job-runs/job-runs.model.js';
import { verifyReplicaSet } from '../../src/lib/verifyReplicaSet.js';
import { clearDatabase, startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';

const silentLogger = pino({ level: 'silent' });

/**
 * Tests de integración de la spec transactional-mongo: confirma que el
 * replica set de un solo nodo levantado por `tests/helpers/mongoMemory.ts`
 * soporta transacciones de verdad (a diferencia de la `MongoMemoryServer`
 * standalone que usaba antes) y que `verifyReplicaSet` (src/lib/verifyReplicaSet.ts)
 * reconoce esa conexión como válida.
 */

describe('transactional-mongo (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 120000);

  afterEach(async () => {
    await clearDatabase();
  });

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  it('commits a withTransaction across two collections against the in-memory replica set', async () => {
    const session = await mongoose.connection.startSession();

    try {
      await session.withTransaction(async () => {
        await CoinModel.create(
          [{ coingeckoId: 'bitcoin', symbol: 'btc', name: 'Bitcoin' }],
          { session },
        );
        await JobRunModel.create(
          [
            {
              jobName: 'poll-prices',
              trigger: 'manual',
              status: 'success',
              startedAt: new Date('2026-01-01T00:00:00.000Z'),
              finishedAt: new Date('2026-01-01T00:00:01.000Z'),
              workerId: 'test-worker',
              stats: {
                coinsRequested: 1,
                coinsReturned: 1,
                snapshotsInserted: 0,
                skippedUnchanged: 0,
                missingCoins: [],
                upstreamAttempts: 1,
              },
            },
          ],
          { session },
        );
      });
    } finally {
      await session.endSession();
    }

    // Leído fuera de la sesión/transacción: si `withTransaction` no hubiera
    // comprometido los cambios (como pasaba contra una instancia standalone),
    // estos documentos no existirían.
    const coin = await CoinModel.findOne({ coingeckoId: 'bitcoin' });
    expect(coin).not.toBeNull();

    const jobRun = await JobRunModel.findOne({ jobName: 'poll-prices', trigger: 'manual' });
    expect(jobRun).not.toBeNull();
  });

  it('does not roll back only some writes when withTransaction commits', async () => {
    const session = await mongoose.connection.startSession();

    try {
      await session.withTransaction(async () => {
        await CoinModel.create([{ coingeckoId: 'ethereum', symbol: 'eth', name: 'Ethereum' }], {
          session,
        });
        await CoinModel.create([{ coingeckoId: 'solana', symbol: 'sol', name: 'Solana' }], {
          session,
        });
      });
    } finally {
      await session.endSession();
    }

    const count = await CoinModel.countDocuments({
      coingeckoId: { $in: ['ethereum', 'solana'] },
    });
    expect(count).toBe(2);
  });

  it('verifyReplicaSet does not exit when the connection is a replica set member', async () => {
    // No debería llamar a logger.fatal ni a process.exit contra el replica
    // set en memoria levantado por startInMemoryMongo().
    await expect(verifyReplicaSet(silentLogger)).resolves.toBeUndefined();
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import mongoose from 'mongoose';
import { ObjectId, type Db } from 'mongodb';
import type { JobWithId } from 'agenda';
import { ensureCollections } from '../../src/db/ensureCollections.js';
import { CoinModel } from '../../src/modules/coins/coins.model.js';
import { createCoinsRepo } from '../../src/modules/coins/coins.service.js';
import { createSnapshotsRepo } from '../../src/modules/snapshots/snapshots.service.js';
import { createJobRunsRepo } from '../../src/modules/job-runs/job-runs.service.js';
import { createPollPricesJob } from '../../src/jobs/pollPrices.js';
import { CoinGeckoError } from '../../src/integrations/coingecko/coingecko.errors.js';
import { systemClock } from '../../src/lib/clock.js';
import { createPollPricesAdapter, JobFailedError } from '../../src/scheduler/adapters.js';
import { createAgenda, JOB_NAMES } from '../../src/scheduler/agenda.js';
import { registerRetryPolicy } from '../../src/scheduler/retryPolicy.js';
import { clearDatabase, startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';
import { waitForJob } from '../helpers/agendaTestHelpers.js';

const silentLogger = pino({ level: 'silent' });

/**
 * Tests de integración de la política de reintentos (spec job-retry-policy)
 * contra Agenda y Mongo reales: E6-7 (fallo transitorio -> exactamente un
 * reintento a los 2 minutos, ninguno más allá del tope) y E6-8 (fallo no
 * transitorio -> ningún reintento).
 */

function getDb(): Db {
  const db = mongoose.connection.db;
  if (!db) throw new Error('no db connection');
  return db;
}

async function seedActiveCoin(): Promise<void> {
  await CoinModel.create({ coingeckoId: 'bitcoin', symbol: 'btc', name: 'Bitcoin' });
}

/** Espera hasta que `predicate()` sea `true` o venza `timeoutMs`, chequeando cada 50ms. */
async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('waitUntil: condition never became true within the timeout');
}

function buildFailingAgenda(errorCode: 'COINGECKO_UNAVAILABLE' | 'COINGECKO_AUTH') {
  const db = getDb();
  const agenda = createAgenda({ db, role: 'worker' });
  agenda.processEvery(200);

  const job = createPollPricesJob({
    coinsRepo: createCoinsRepo(),
    snapshotsRepo: createSnapshotsRepo(),
    jobRunsRepo: createJobRunsRepo(),
    coingecko: {
      getSimplePrices: async () => {
        throw new CoinGeckoError(errorCode, `simulated ${errorCode}`);
      },
    },
    clock: systemClock,
    logger: silentLogger,
    workerId: 'w1',
  });

  const adapter = createPollPricesAdapter({
    job,
    jobRunsRepo: createJobRunsRepo(),
    clock: systemClock,
    workerId: 'w1',
    leaseTtlMs: 300000,
    logger: silentLogger,
  });

  agenda.define(JOB_NAMES.POLL_PRICES, adapter, {
    concurrency: 1,
    lockLimit: 1,
    lockLifetime: 300000,
  });

  registerRetryPolicy(agenda, { db, clock: systemClock, logger: silentLogger, maxRetries: 1 });

  return agenda;
}

describe('poll-prices retry policy (integration)', () => {
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

  it('E6-7: a transient failure schedules exactly one retry, none beyond the budget', async () => {
    await seedActiveCoin();
    const agenda = buildFailingAgenda('COINGECKO_UNAVAILABLE');
    await agenda.start();

    try {
      const originalJob = await agenda.now(JOB_NAMES.POLL_PRICES);
      const originalJobId = originalJob.attrs._id;
      if (!originalJobId) throw new Error('expected agenda.now() to assign an id');
      await waitForJob(agenda, JOB_NAMES.POLL_PRICES, 10000);

      // El listener de retry corre desacoplado del evento `fail`; espera a
      // que el documento de reintento aparezca en vez de asumir sincronía.
      await waitUntil(async () => {
        const count = await getDb()
          .collection('agenda_jobs')
          .countDocuments({ name: JOB_NAMES.POLL_PRICES, 'data.attempt': 2 });
        return count === 1;
      });

      const originalDoc = await getDb()
        .collection('agenda_jobs')
        .findOne({ _id: new ObjectId(originalJobId.toString()) });
      expect(originalDoc?.failCount).toBeGreaterThanOrEqual(1);

      const retryDoc = await getDb()
        .collection('agenda_jobs')
        .findOne({ name: JOB_NAMES.POLL_PRICES, 'data.attempt': 2 });
      expect(retryDoc?.data?.trigger).toBe('retry');
      expect(retryDoc?.nextRunAt).toBeInstanceOf(Date);
      const delayMs = (retryDoc?.nextRunAt as Date).getTime() - Date.now();
      expect(delayMs).toBeGreaterThan(1.5 * 60_000);
      expect(delayMs).toBeLessThan(2.5 * 60_000);

      // Simula que el reintento (attempt: 2) también falla: no debe haber un
      // tercer intento, porque POLL_MAX_JOB_RETRIES=1 solo permite uno.
      const fakeRetryJob = {
        attrs: { _id: retryDoc?._id, data: { trigger: 'retry', attempt: 2 } },
      } as unknown as JobWithId;
      agenda.emit('fail:poll-prices', new JobFailedError('COINGECKO_UNAVAILABLE', 'still down'), fakeRetryJob);

      await new Promise((resolve) => setTimeout(resolve, 500));
      const thirdCount = await getDb()
        .collection('agenda_jobs')
        .countDocuments({ name: JOB_NAMES.POLL_PRICES, 'data.attempt': 3 });
      expect(thirdCount).toBe(0);
    } finally {
      await agenda.stop();
    }
  });

  it('E6-8: a non-transient failure (COINGECKO_AUTH) schedules no retry', async () => {
    await seedActiveCoin();
    const agenda = buildFailingAgenda('COINGECKO_AUTH');
    await agenda.start();

    try {
      await agenda.now(JOB_NAMES.POLL_PRICES);
      await waitForJob(agenda, JOB_NAMES.POLL_PRICES, 10000);

      // Da tiempo a que el listener (si fuera a programar algo) lo hiciera.
      await new Promise((resolve) => setTimeout(resolve, 500));

      const retryCount = await getDb()
        .collection('agenda_jobs')
        .countDocuments({ name: JOB_NAMES.POLL_PRICES, 'data.trigger': 'retry' });
      expect(retryCount).toBe(0);
    } finally {
      await agenda.stop();
    }
  });
});

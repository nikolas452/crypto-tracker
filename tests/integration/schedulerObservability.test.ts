import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { Db } from 'mongodb';
import type { Logger } from 'pino';
import { ensureCollections } from '../../src/db/ensureCollections.js';
import { CoinModel } from '../../src/modules/coins/coins.model.js';
import { createCoinsRepo } from '../../src/modules/coins/coins.service.js';
import { createSnapshotsRepo } from '../../src/modules/snapshots/snapshots.service.js';
import { createJobRunsRepo } from '../../src/modules/job-runs/job-runs.service.js';
import { createPollPricesJob } from '../../src/jobs/pollPrices.js';
import { CoinGeckoError } from '../../src/integrations/coingecko/coingecko.errors.js';
import { systemClock } from '../../src/lib/clock.js';
import { createPollPricesAdapter } from '../../src/scheduler/adapters.js';
import { createAgenda, JOB_NAMES } from '../../src/scheduler/agenda.js';
import { registerObservability } from '../../src/scheduler/observability.js';
import { clearDatabase, startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';
import { waitForJob } from '../helpers/agendaTestHelpers.js';

/**
 * Tests de integración de `src/scheduler/observability.ts` (spec
 * scheduler-observability): niveles/campos de los listeners de ciclo de
 * vida, ausencia de stack en `failReason`, y el resumen periódico de
 * contadores.
 */

function createFakeLogger(): Logger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  } as unknown as Logger;
}

function getDb(): Db {
  const db = mongoose.connection.db;
  if (!db) throw new Error('no db connection');
  return db;
}

async function seedActiveCoin(): Promise<void> {
  await CoinModel.create({ coingeckoId: 'bitcoin', symbol: 'btc', name: 'Bitcoin' });
}

function buildAgenda(succeed: boolean) {
  const db = getDb();
  const agenda = createAgenda({ db, role: 'worker' });
  agenda.processEvery(200);

  const job = createPollPricesJob({
    coinsRepo: createCoinsRepo(),
    snapshotsRepo: createSnapshotsRepo(),
    jobRunsRepo: createJobRunsRepo(),
    coingecko: {
      getSimplePrices: async () => {
        if (succeed) {
          return {
            prices: new Map([
              [
                'bitcoin',
                {
                  priceUsd: 1,
                  marketCapUsd: null,
                  volume24hUsd: null,
                  change24hPct: null,
                  sourceUpdatedAt: null,
                },
              ],
            ]),
            attempts: 1,
          };
        }
        throw new CoinGeckoError('COINGECKO_AUTH', 'bad key');
      },
    },
    clock: systemClock,
    logger: createFakeLogger(),
    workerId: 'w1',
  });

  const adapter = createPollPricesAdapter({
    job,
    jobRunsRepo: createJobRunsRepo(),
    clock: systemClock,
    workerId: 'w1',
    leaseTtlMs: 300000,
    logger: createFakeLogger(),
  });

  agenda.define(JOB_NAMES.POLL_PRICES, adapter, {
    concurrency: 1,
    lockLimit: 1,
    lockLifetime: 300000,
  });

  return agenda;
}

describe('scheduler observability (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
    await ensureCollections(createFakeLogger());
  }, 120000);

  afterEach(async () => {
    await clearDatabase();
  });

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  it('logs start/success at debug with jobName and agendaJobId', async () => {
    await seedActiveCoin();
    const agenda = buildAgenda(true);
    const logger = createFakeLogger();
    const handle = registerObservability(agenda, { logger });

    await agenda.start();
    try {
      await agenda.now(JOB_NAMES.POLL_PRICES);
      await waitForJob(agenda, JOB_NAMES.POLL_PRICES, 10000);
    } finally {
      handle.stop();
      await agenda.stop();
    }

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ jobName: JOB_NAMES.POLL_PRICES }),
      expect.stringContaining('started'),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ jobName: JOB_NAMES.POLL_PRICES }),
      expect.stringContaining('succeeded'),
    );
    expect(handle.getCounters()[JOB_NAMES.POLL_PRICES]).toMatchObject({
      started: 1,
      succeeded: 1,
      failed: 0,
    });
  });

  it('logs fail at error with jobName, agendaJobId, code and stack; failReason carries no stack', async () => {
    await seedActiveCoin();
    const agenda = buildAgenda(false);
    const logger = createFakeLogger();
    const handle = registerObservability(agenda, { logger });

    await agenda.start();
    try {
      await agenda.now(JOB_NAMES.POLL_PRICES);
      // Espera específicamente `complete`, no `fail`: `fail` se emite ANTES
      // de que Agenda persista `failReason` en `saveJobState()` (dentro del
      // `finally` de `Job.run()`), así que esperar solo `fail` sería una
      // carrera con esa escritura.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for complete')), 5000);
        agenda.on(`complete:${JOB_NAMES.POLL_PRICES}`, () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } finally {
      handle.stop();
      await agenda.stop();
    }

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: JOB_NAMES.POLL_PRICES,
        code: 'COINGECKO_AUTH',
        stack: expect.stringContaining('at '),
      }),
      expect.stringContaining('failed'),
    );
    expect(handle.getCounters()[JOB_NAMES.POLL_PRICES]).toMatchObject({ failed: 1 });

    const doc = await getDb().collection('agenda_jobs').findOne({ name: JOB_NAMES.POLL_PRICES });
    expect(doc?.failReason).toBe('bad key');
    expect(doc?.failReason).not.toMatch(/\n\s*at /);
  });

  it('emits a periodic counter summary at info', async () => {
    await seedActiveCoin();
    const agenda = buildAgenda(true);
    const logger = createFakeLogger();
    const handle = registerObservability(agenda, { logger, summaryIntervalMs: 50 });

    await agenda.start();
    try {
      await agenda.now(JOB_NAMES.POLL_PRICES);
      await waitForJob(agenda, JOB_NAMES.POLL_PRICES, 10000);
      await new Promise((resolve) => setTimeout(resolve, 150));
    } finally {
      handle.stop();
      await agenda.stop();
    }

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        counters: expect.objectContaining({
          [JOB_NAMES.POLL_PRICES]: expect.objectContaining({ started: 1, succeeded: 1 }),
        }),
      }),
      expect.stringContaining('summary'),
    );
  });
});

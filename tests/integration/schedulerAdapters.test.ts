import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import mongoose from 'mongoose';
import type { Job } from 'agenda';
import { Types } from 'mongoose';
import { ensureCollections } from '../../src/db/ensureCollections.js';
import { CoinModel } from '../../src/modules/coins/coins.model.js';
import { createCoinsRepo } from '../../src/modules/coins/coins.service.js';
import { createSnapshotsRepo } from '../../src/modules/snapshots/snapshots.service.js';
import { createJobRunsRepo } from '../../src/modules/job-runs/job-runs.service.js';
import { createPollPricesJob } from '../../src/jobs/pollPrices.js';
import { createFixedClock, systemClock } from '../../src/lib/clock.js';
import { acquire, release } from '../../src/lib/lease-lock.js';
import { createPollPricesAdapter } from '../../src/scheduler/adapters.js';
import { createAgenda, JOB_NAMES } from '../../src/scheduler/agenda.js';
import { clearDatabase, startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';
import { waitForJobCount } from '../helpers/agendaTestHelpers.js';
import type { SimplePrice } from '../../src/integrations/coingecko/coingecko.types.js';

const silentLogger = pino({ level: 'silent' });

/**
 * Tests de integración del adaptador de `poll-prices` (specs
 * agenda-job-adapters / lease-lock) contra Mongo real: E6-4 (lease tomado ->
 * skipped sin llamar a CoinGecko), E6-5 (lease vencido -> corrida normal) y
 * E6-6 simplificado (dos instancias de Agenda disparando `now()` producen
 * exactamente un `success`).
 */

function fakeAgendaJob(id: string): Job {
  return { attrs: { _id: id, data: undefined } } as unknown as Job;
}

async function seedActiveCoin(): Promise<void> {
  await CoinModel.create({ coingeckoId: 'bitcoin', symbol: 'btc', name: 'Bitcoin' });
}

function fakePrices(runAt: Date): Map<string, SimplePrice> {
  return new Map([
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
  ]);
}

describe('poll-prices adapter (integration)', () => {
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

  it('E6-4: a held lease skips the run without calling CoinGecko', async () => {
    await seedActiveCoin();
    const runAt = new Date('2026-01-01T00:00:00.000Z');
    await acquire(JOB_NAMES.POLL_PRICES, 'other-owner', 300000, runAt);

    let called = false;
    const job = createPollPricesJob({
      coinsRepo: createCoinsRepo(),
      snapshotsRepo: createSnapshotsRepo(),
      jobRunsRepo: createJobRunsRepo(),
      coingecko: {
        getSimplePrices: async () => {
          called = true;
          return { prices: fakePrices(runAt), attempts: 1 };
        },
      },
      clock: createFixedClock(runAt),
      logger: silentLogger,
      workerId: 'w1',
    });

    const adapter = createPollPricesAdapter({
      job,
      jobRunsRepo: createJobRunsRepo(),
      clock: createFixedClock(runAt),
      workerId: 'w1',
      leaseTtlMs: 300000,
      logger: silentLogger,
    });

    await adapter(fakeAgendaJob(new Types.ObjectId().toString()));

    expect(called).toBe(false);
    const runs = await mongoose.connection.db
      ?.collection('job_runs')
      .find({ jobName: JOB_NAMES.POLL_PRICES })
      .toArray();
    expect(runs).toHaveLength(1);
    expect(runs?.[0]?.status).toBe('skipped');
    expect(runs?.[0]?.skipReason).toBe('locked');
  });

  it('E6-5: an expired lease allows a normal run', async () => {
    await seedActiveCoin();
    const lockedAt = new Date('2026-01-01T00:00:00.000Z');
    await acquire(JOB_NAMES.POLL_PRICES, 'other-owner', 1000, lockedAt);

    const runAt = new Date(lockedAt.getTime() + 5000);
    let called = false;
    const job = createPollPricesJob({
      coinsRepo: createCoinsRepo(),
      snapshotsRepo: createSnapshotsRepo(),
      jobRunsRepo: createJobRunsRepo(),
      coingecko: {
        getSimplePrices: async () => {
          called = true;
          return { prices: fakePrices(runAt), attempts: 1 };
        },
      },
      clock: createFixedClock(runAt),
      logger: silentLogger,
      workerId: 'w1',
    });

    const adapter = createPollPricesAdapter({
      job,
      jobRunsRepo: createJobRunsRepo(),
      clock: createFixedClock(runAt),
      workerId: 'w1',
      leaseTtlMs: 300000,
      logger: silentLogger,
    });

    await adapter(fakeAgendaJob(new Types.ObjectId().toString()));

    expect(called).toBe(true);
    const runs = await mongoose.connection.db
      ?.collection('job_runs')
      .find({ jobName: JOB_NAMES.POLL_PRICES })
      .toArray();
    expect(runs).toHaveLength(1);
    expect(runs?.[0]?.status).toBe('success');
  });

  it('E6-6 (simplified): two Agenda instances triggering now() concurrently yield exactly one success', async () => {
    await seedActiveCoin();
    const runAt = new Date('2026-01-01T00:00:00.000Z');
    let callCount = 0;

    // El lease solo excluye mientras la corrida está en curso: si el job
    // ganador termina y libera antes de que el otro intente adquirir, el
    // segundo lo toma legítimamente. Para que el solapamiento no dependa del
    // timing, el ganador retiene el lease hasta que ambos adaptadores hayan
    // intentado adquirirlo.
    let acquireAttempts = 0;
    let markBothTried!: () => void;
    const bothTried = new Promise<void>((resolve) => {
      markBothTried = resolve;
    });
    const gatedLease = {
      acquire: async (...args: Parameters<typeof acquire>) => {
        const acquired = await acquire(...args);
        acquireAttempts += 1;
        if (acquireAttempts >= 2) markBothTried();
        return acquired;
      },
      release,
    };

    function buildAdapter(workerId: string) {
      const job = createPollPricesJob({
        coinsRepo: createCoinsRepo(),
        snapshotsRepo: createSnapshotsRepo(),
        jobRunsRepo: createJobRunsRepo(),
        coingecko: {
          getSimplePrices: async () => {
            callCount += 1;
            // El tope evita un cuelgue si una sola instancia tomara ambos jobs.
            await Promise.race([bothTried, new Promise((resolve) => setTimeout(resolve, 5000))]);
            return { prices: fakePrices(runAt), attempts: 1 };
          },
        },
        clock: systemClock,
        logger: silentLogger,
        workerId,
      });

      return createPollPricesAdapter({
        job,
        jobRunsRepo: createJobRunsRepo(),
        clock: systemClock,
        workerId,
        leaseTtlMs: 300000,
        logger: silentLogger,
        lease: gatedLease,
      });
    }

    const db = mongoose.connection.db;
    if (!db) throw new Error('no db connection');

    const agendaA = createAgenda({ db, role: 'worker' });
    const agendaB = createAgenda({ db, role: 'worker' });
    // Un número crudo de milisegundos evita la ambigüedad de `human-interval`
    // con la unidad "milliseconds" (ver la nota en schedulerDefinitions.test.ts).
    agendaA.processEvery(200);
    agendaB.processEvery(200);
    await Promise.all([agendaA.ready, agendaB.ready]);

    agendaA.define(JOB_NAMES.POLL_PRICES, buildAdapter('worker-a'), {
      concurrency: 1,
      lockLimit: 1,
      lockLifetime: 300000,
    });
    agendaB.define(JOB_NAMES.POLL_PRICES, buildAdapter('worker-b'), {
      concurrency: 1,
      lockLimit: 1,
      lockLifetime: 300000,
    });

    await Promise.all([agendaA.start(), agendaB.start()]);

    try {
      await Promise.all([
        agendaA.now(JOB_NAMES.POLL_PRICES),
        agendaB.now(JOB_NAMES.POLL_PRICES),
        // Cada `now()` crea un job propio y cualquiera de las dos instancias
        // puede tomarlos: se espera a que terminen 2 corridas en total, no una
        // por instancia.
        waitForJobCount([agendaA, agendaB], JOB_NAMES.POLL_PRICES, 2, 10000),
      ]);
    } finally {
      await Promise.all([agendaA.stop(), agendaB.stop()]);
    }

    expect(callCount).toBe(1);
    const successes = await db
      .collection('job_runs')
      .find({ jobName: JOB_NAMES.POLL_PRICES, status: 'success' })
      .toArray();
    expect(successes).toHaveLength(1);
    const skipped = await db
      .collection('job_runs')
      .find({ jobName: JOB_NAMES.POLL_PRICES, status: 'skipped', skipReason: 'locked' })
      .toArray();
    expect(skipped).toHaveLength(1);
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import mongoose from 'mongoose';
import type { Db } from 'mongodb';
import { ensureCollections } from '../../src/db/ensureCollections.js';
import { CoinModel } from '../../src/modules/coins/coins.model.js';
import { createCoinsRepo } from '../../src/modules/coins/coins.service.js';
import { createSnapshotsRepo } from '../../src/modules/snapshots/snapshots.service.js';
import { createJobRunsRepo } from '../../src/modules/job-runs/job-runs.service.js';
import { createPollPricesJob } from '../../src/jobs/pollPrices.js';
import { systemClock } from '../../src/lib/clock.js';
import { createPollPricesAdapter } from '../../src/scheduler/adapters.js';
import { createAgenda, JOB_NAMES } from '../../src/scheduler/agenda.js';
import { clearDatabase, startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';

const silentLogger = pino({ level: 'silent' });

/**
 * Tests de integración de la secuencia de apagado que usa `src/worker.ts`
 * (spec worker-process: "Ordered worker shutdown" / E6-12): `agenda.drain()`
 * espera un run en curso hasta el timeout; si termina antes, la corrida
 * queda `success` y `drain()` reporta `timedOut: false`. Si excede el
 * timeout, `drain()` reporta `timedOut: true` y `agenda.stop()` libera su
 * lock para que otro worker lo retome.
 *
 * Esto ejercita exactamente el mecanismo que `shutdown()` invoca en
 * `worker.ts` (mismo `agenda.drain(timeoutMs)` seguido de `agenda.stop()`
 * ante un timeout); la verificación con una señal SIGTERM real contra el
 * proceso completo del worker queda para la verificación manual (spec
 * worker-process no exige un test que dispare señales de SO, y en Windows
 * `process.kill(pid, 'SIGTERM')` no invoca el handler de apagado ordenado).
 */

function getDb(): Db {
  const db = mongoose.connection.db;
  if (!db) throw new Error('no db connection');
  return db;
}

async function seedActiveCoin(): Promise<void> {
  await CoinModel.create({ coingeckoId: 'bitcoin', symbol: 'btc', name: 'Bitcoin' });
}

/** Espera a que el job efectivamente empiece a correr (evento `start:<name>`), en lugar de un `sleep` fijo que podría ganarle a `processEvery`. */
function waitForStart(agenda: ReturnType<typeof buildSlowAgenda>, name: string): Promise<void> {
  return new Promise((resolve) => {
    agenda.once(`start:${name}`, () => resolve());
  });
}

function buildSlowAgenda(delayMs: number) {
  const db = getDb();
  const agenda = createAgenda({ db, role: 'worker' });
  agenda.processEvery(200);

  const job = createPollPricesJob({
    coinsRepo: createCoinsRepo(),
    snapshotsRepo: createSnapshotsRepo(),
    jobRunsRepo: createJobRunsRepo(),
    coingecko: {
      getSimplePrices: async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
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

  return agenda;
}

describe('worker shutdown sequence (integration)', () => {
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

  it('E6-12: drain() waits for an in-progress run to finish, leaving its JobRun at success', async () => {
    await seedActiveCoin();
    const agenda = buildSlowAgenda(300);
    await agenda.start();

    const startPromise = waitForStart(agenda, JOB_NAMES.POLL_PRICES);
    await agenda.now(JOB_NAMES.POLL_PRICES);
    await startPromise;

    const result = await agenda.drain(5000);

    expect(result.timedOut).toBe(false);
    expect(result.completed).toBe(1);

    const runs = await getDb().collection('job_runs').find({ jobName: JOB_NAMES.POLL_PRICES }).toArray();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('success');
  });

  it('a drain timeout reports the remaining count; the lock outlives stop() and clears via lockLifetime', async () => {
    await seedActiveCoin();
    const agenda = buildSlowAgenda(2000);
    await agenda.start();

    const startPromise = waitForStart(agenda, JOB_NAMES.POLL_PRICES);
    await agenda.now(JOB_NAMES.POLL_PRICES);
    await startPromise;

    const result = await agenda.drain(200);
    expect(result.timedOut).toBe(true);
    expect(result.running).toBeGreaterThanOrEqual(1);

    await agenda.stop();

    // Hallazgo real contra la 6.2.6 instalada (documentado en el README,
    // tarea 11.2): `stop()` SOLO libera jobs que estaban encolados
    // localmente pero no habían arrancado todavía — uno que ya está
    // corriendo conserva su lock de Mongo hasta que termina o vence su
    // `lockLifetime` (ver JobProcessor.stop(): "Running jobs keep their
    // database locks until they complete or the lock expires"). La
    // redacción de la spec ("agenda.stop() releases their locks") describe
    // la intención de diseño, no el comportamiento literal de esta versión;
    // la recuperación real de un job todavía en curso siempre depende de
    // `lockLifetime`, se haya llamado a `stop()` o no — el mismo mecanismo
    // que ya cubre a un worker matado en seco (`kill -9`).
    const doc = await getDb().collection('agenda_jobs').findOne({ name: JOB_NAMES.POLL_PRICES });
    expect(doc?.lockedAt).not.toBeNull();
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose, { Types } from 'mongoose';
import pino, { type Logger } from 'pino';
import { ensureCollections } from '../../src/db/ensureCollections.js';
import { createJobRunsRepo } from '../../src/modules/job-runs/job-runs.service.js';
import { JobRunModel } from '../../src/modules/job-runs/job-runs.model.js';
import { NotificationModel } from '../../src/modules/notifications/notifications.model.js';
import { createMaintenanceJob, JOB_NAME } from '../../src/jobs/maintenance.js';
import { JOB_NAME as POLL_PRICES_JOB_NAME } from '../../src/jobs/pollPrices.js';
import { createFixedClock } from '../../src/lib/clock.js';
import { AGENDA_JOBS_COLLECTION } from '../../src/scheduler/agenda.js';
import { clearDatabase, startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';
import type { Db } from 'mongodb';

/**
 * Tests de integración del job `maintenance` (spec maintenance-job): registro
 * de su propia corrida, recuperación de `job_runs` obsoletos, poda de
 * documentos puntuales de `agenda_jobs` (E6-13) y los dos reportes en `warn`.
 */

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

function getDb(): Db {
  const db = mongoose.connection.db;
  if (!db) throw new Error('no db connection');
  return db;
}

const silentLogger = pino({ level: 'silent' });

describe('maintenance job (integration)', () => {
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

  it('records its own JobRun as success', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const job = createMaintenanceJob({
      jobRunsRepo: createJobRunsRepo(),
      db: getDb(),
      clock: createFixedClock(now),
      logger: createFakeLogger(),
      workerId: 'w1',
    });

    const result = await job.run('agenda');

    expect(result.status).toBe('success');
    const doc = await JobRunModel.findById(result.runId).lean();
    expect(doc?.jobName).toBe(JOB_NAME);
    expect(doc?.status).toBe('success');
  });

  it('recovers a stale running JobRun', async () => {
    const now = new Date('2026-01-01T01:00:00.000Z');
    const staleStart = new Date(now.getTime() - 60 * 60_000); // 60 min antes, > STALE_RUN_THRESHOLD_MIN default (15)
    const stale = await JobRunModel.create({
      jobName: 'poll-prices',
      trigger: 'agenda',
      status: 'running',
      startedAt: staleStart,
      workerId: 'dead-worker',
      stats: {},
    });

    const job = createMaintenanceJob({
      jobRunsRepo: createJobRunsRepo(),
      db: getDb(),
      clock: createFixedClock(now),
      logger: createFakeLogger(),
      workerId: 'w1',
    });

    await job.run('agenda');

    const doc = await JobRunModel.findById(stale._id).lean();
    expect(doc?.status).toBe('failed');
    expect(doc?.error?.code).toBe('STALE');
  });

  it('E6-13: one-off jobs finished 10 days ago are removed, recurring jobs are kept', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const tenDaysAgo = new Date(now.getTime() - 10 * 86_400_000);

    await getDb()
      .collection(AGENDA_JOBS_COLLECTION)
      .insertMany([
        {
          name: 'poll-prices',
          type: 'normal',
          lastFinishedAt: tenDaysAgo,
          nextRunAt: null,
          data: null,
        },
        {
          name: 'poll-prices',
          type: 'single',
          lastFinishedAt: tenDaysAgo,
          nextRunAt: new Date(now.getTime() + 60_000),
          data: null,
        },
      ]);

    const job = createMaintenanceJob({
      jobRunsRepo: createJobRunsRepo(),
      db: getDb(),
      clock: createFixedClock(now),
      logger: createFakeLogger(),
      workerId: 'w1',
    });

    await job.run('agenda');

    const remaining = await getDb().collection(AGENDA_JOBS_COLLECTION).find({}).toArray();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.type).toBe('single');
  });

  it('warns about notifications failed in the last 24 hours', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    await NotificationModel.create({
      userId: new Types.ObjectId(),
      alertId: new Types.ObjectId(),
      to: 'a@example.com',
      status: 'failed',
      dedupeKey: `${new Types.ObjectId().toString()}:1`,
      payload: {
        coingeckoId: 'bitcoin',
        coinName: 'Bitcoin',
        symbol: 'btc',
        alertType: 'PRICE_ABOVE',
        threshold: 1,
        value: 2,
        priceUsd: 2,
        triggeredAt: now,
      },
    });

    const logger = createFakeLogger();
    const job = createMaintenanceJob({
      jobRunsRepo: createJobRunsRepo(),
      db: getDb(),
      clock: createFixedClock(now),
      logger,
      workerId: 'w1',
    });

    await job.run('agenda');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ failedCount: 1 }),
      expect.stringContaining('notifications failed'),
    );
  });

  it('warns when poll-prices is stale', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    // Nunca hubo una corrida success/partial de poll-prices -> stale por definición.
    const logger = createFakeLogger();
    const job = createMaintenanceJob({
      jobRunsRepo: createJobRunsRepo(),
      db: getDb(),
      clock: createFixedClock(now),
      logger,
      workerId: 'w1',
    });

    await job.run('agenda');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobName: POLL_PRICES_JOB_NAME }),
      expect.stringContaining('stale'),
    );
  });
});

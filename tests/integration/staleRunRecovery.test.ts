import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createJobRunsRepo } from '../../src/modules/job-runs/job-runs.service.js';
import { JobRunModel } from '../../src/modules/job-runs/job-runs.model.js';
import { clearDatabase, startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';

describe('stale-run recovery (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 120000);

  afterEach(async () => {
    await clearDatabase();
  });

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  // E1-11: a JobRun stuck in "running" for 20 minutes is recovered as failed/STALE
  // when the worker starts with the default 15-minute threshold.
  it('E1-11: marks a JobRun running for 20 minutes as failed/STALE', async () => {
    const now = new Date('2026-01-01T00:20:00.000Z');
    const twentyMinutesAgo = new Date(now.getTime() - 20 * 60_000);
    const staleThreshold = new Date(now.getTime() - 15 * 60_000);

    const stuckRun = await JobRunModel.create({
      jobName: 'poll-prices',
      trigger: 'schedule',
      status: 'running',
      startedAt: twentyMinutesAgo,
      workerId: 'dead-worker-123',
      stats: {
        coinsRequested: 0,
        coinsReturned: 0,
        snapshotsInserted: 0,
        skippedUnchanged: 0,
        missingCoins: [],
        upstreamAttempts: 0,
      },
    });

    const jobRunsRepo = createJobRunsRepo();
    const recoveredCount = await jobRunsRepo.recoverStaleRuns(staleThreshold, now);

    expect(recoveredCount).toBe(1);

    const reloaded = await JobRunModel.findById(stuckRun._id);
    expect(reloaded?.status).toBe('failed');
    expect(reloaded?.error?.code).toBe('STALE');
    expect(reloaded?.finishedAt?.getTime()).toBe(now.getTime());
  });

  it('does not touch a running JobRun that started within the threshold', async () => {
    const now = new Date('2026-01-01T00:20:00.000Z');
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60_000);
    const staleThreshold = new Date(now.getTime() - 15 * 60_000);

    const freshRun = await JobRunModel.create({
      jobName: 'poll-prices',
      trigger: 'schedule',
      status: 'running',
      startedAt: fiveMinutesAgo,
      workerId: 'live-worker-1',
      stats: {
        coinsRequested: 0,
        coinsReturned: 0,
        snapshotsInserted: 0,
        skippedUnchanged: 0,
        missingCoins: [],
        upstreamAttempts: 0,
      },
    });

    const jobRunsRepo = createJobRunsRepo();
    const recoveredCount = await jobRunsRepo.recoverStaleRuns(staleThreshold, now);

    expect(recoveredCount).toBe(0);

    const reloaded = await JobRunModel.findById(freshRun._id);
    expect(reloaded?.status).toBe('running');
  });

  it('does not touch a JobRun that already finished', async () => {
    const now = new Date('2026-01-01T00:20:00.000Z');
    const twentyMinutesAgo = new Date(now.getTime() - 20 * 60_000);
    const staleThreshold = new Date(now.getTime() - 15 * 60_000);

    const finishedRun = await JobRunModel.create({
      jobName: 'poll-prices',
      trigger: 'schedule',
      status: 'success',
      startedAt: twentyMinutesAgo,
      finishedAt: twentyMinutesAgo,
      workerId: 'worker-1',
      stats: {
        coinsRequested: 0,
        coinsReturned: 0,
        snapshotsInserted: 0,
        skippedUnchanged: 0,
        missingCoins: [],
        upstreamAttempts: 0,
      },
    });

    const jobRunsRepo = createJobRunsRepo();
    await jobRunsRepo.recoverStaleRuns(staleThreshold, now);

    const reloaded = await JobRunModel.findById(finishedRun._id);
    expect(reloaded?.status).toBe('success');
  });
});

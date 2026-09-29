import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'agenda';
import { Types } from 'mongoose';
import pino from 'pino';
import {
  createPollPricesAdapter,
  createSendNotificationsAdapter,
  JobFailedError,
  type RunnableJob,
} from '../../src/scheduler/adapters.js';
import { createFixedClock } from '../../src/lib/clock.js';
import type { JobRunResult } from '../../src/jobs/pollPrices.js';
import { EMPTY_JOB_RUN_STATS } from '../../src/modules/job-runs/job-runs.service.js';

/**
 * Tests unitarios de los adaptadores de `src/scheduler/adapters.ts` (spec
 * agenda-job-adapters): derivación de `trigger`, que solo un resultado
 * `failed` lanza, la integración con el lease de `poll-prices`, y que
 * `send-notifications` nunca falla por un envío individual.
 */

const silentLogger = pino({ level: 'silent' });

function fakeAgendaJob(data?: Record<string, unknown>): Job {
  return { attrs: { _id: new Types.ObjectId().toString(), data } } as unknown as Job;
}

function makeResult(
  status: JobRunResult['status'],
  overrides: Partial<JobRunResult> = {},
): JobRunResult {
  return {
    runId: new Types.ObjectId(),
    status,
    startedAt: new Date(),
    finishedAt: new Date(),
    durationMs: 10,
    stats: { ...EMPTY_JOB_RUN_STATS },
    error: null,
    ...overrides,
  };
}

function fakeClock() {
  return createFixedClock(new Date('2026-01-01T00:00:00.000Z'));
}

describe('createPollPricesAdapter', () => {
  it('derives trigger "agenda" when data.trigger is absent', async () => {
    const runSpy = vi.fn().mockResolvedValue(makeResult('success'));
    const adapter = createPollPricesAdapter({
      job: { run: runSpy },
      jobRunsRepo: { createSkipped: vi.fn(), attachAgendaMetadata: vi.fn() },
      clock: fakeClock(),
      workerId: 'w',
      leaseTtlMs: 1000,
      logger: silentLogger,
      lease: { acquire: vi.fn().mockResolvedValue(true), release: vi.fn() },
    });

    await adapter(fakeAgendaJob());

    expect(runSpy).toHaveBeenCalledWith('agenda');
  });

  it('keeps an explicit data.trigger (e.g. "api")', async () => {
    const runSpy = vi.fn().mockResolvedValue(makeResult('success'));
    const adapter = createPollPricesAdapter({
      job: { run: runSpy },
      jobRunsRepo: { createSkipped: vi.fn(), attachAgendaMetadata: vi.fn() },
      clock: fakeClock(),
      workerId: 'w',
      leaseTtlMs: 1000,
      logger: silentLogger,
      lease: { acquire: vi.fn().mockResolvedValue(true), release: vi.fn() },
    });

    await adapter(fakeAgendaJob({ trigger: 'api' }));

    expect(runSpy).toHaveBeenCalledWith('api');
  });

  it.each(['skipped', 'partial'] as const)(
    'does not throw for a %s result',
    async (status) => {
      const adapter = createPollPricesAdapter({
        job: { run: vi.fn().mockResolvedValue(makeResult(status)) },
        jobRunsRepo: { createSkipped: vi.fn(), attachAgendaMetadata: vi.fn() },
        clock: fakeClock(),
        workerId: 'w',
        leaseTtlMs: 1000,
        logger: silentLogger,
        lease: { acquire: vi.fn().mockResolvedValue(true), release: vi.fn() },
      });

      await expect(adapter(fakeAgendaJob())).resolves.toBeUndefined();
    },
  );

  it('throws JobFailedError for a failed result, after attaching Agenda metadata', async () => {
    const attachSpy = vi.fn();
    const result = makeResult('failed', {
      error: { code: 'COINGECKO_AUTH', message: 'bad key' },
    });
    const adapter = createPollPricesAdapter({
      job: { run: vi.fn().mockResolvedValue(result) },
      jobRunsRepo: { createSkipped: vi.fn(), attachAgendaMetadata: attachSpy },
      clock: fakeClock(),
      workerId: 'w',
      leaseTtlMs: 1000,
      logger: silentLogger,
      lease: { acquire: vi.fn().mockResolvedValue(true), release: vi.fn() },
    });

    await expect(adapter(fakeAgendaJob())).rejects.toThrow(JobFailedError);
    expect(attachSpy).toHaveBeenCalledWith(result.runId, expect.objectContaining({ attempt: 1 }));
  });

  it('skips the job entirely and records a locked JobRun when the lease is held', async () => {
    const runSpy: RunnableJob['run'] = vi.fn();
    const createSkippedSpy = vi.fn().mockResolvedValue(new Types.ObjectId());
    const adapter = createPollPricesAdapter({
      job: { run: runSpy },
      jobRunsRepo: { createSkipped: createSkippedSpy, attachAgendaMetadata: vi.fn() },
      clock: fakeClock(),
      workerId: 'w',
      leaseTtlMs: 1000,
      logger: silentLogger,
      lease: { acquire: vi.fn().mockResolvedValue(false), release: vi.fn() },
    });

    await adapter(fakeAgendaJob());

    expect(runSpy).not.toHaveBeenCalled();
    expect(createSkippedSpy).toHaveBeenCalledWith(
      expect.objectContaining({ skipReason: 'locked', jobName: 'poll-prices' }),
    );
  });

  it('releases the lease even when the job throws', async () => {
    const releaseSpy = vi.fn();
    const adapter = createPollPricesAdapter({
      job: { run: vi.fn().mockRejectedValue(new Error('boom')) },
      jobRunsRepo: { createSkipped: vi.fn(), attachAgendaMetadata: vi.fn() },
      clock: fakeClock(),
      workerId: 'w',
      leaseTtlMs: 1000,
      logger: silentLogger,
      lease: { acquire: vi.fn().mockResolvedValue(true), release: releaseSpy },
    });

    await expect(adapter(fakeAgendaJob())).rejects.toThrow('boom');
    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });
});

describe('createSendNotificationsAdapter', () => {
  it('does not throw when the job reports success, regardless of per-notification outcomes', async () => {
    const adapter = createSendNotificationsAdapter({
      job: { run: vi.fn().mockResolvedValue(makeResult('success')) },
      jobRunsRepo: { attachAgendaMetadata: vi.fn() },
    });

    await expect(adapter(fakeAgendaJob())).resolves.toBeUndefined();
  });

  it('throws JobFailedError only for a failed (infrastructure) result', async () => {
    const result = makeResult('failed', { error: { code: 'INTERNAL', message: 'db down' } });
    const adapter = createSendNotificationsAdapter({
      job: { run: vi.fn().mockResolvedValue(result) },
      jobRunsRepo: { attachAgendaMetadata: vi.fn() },
    });

    await expect(adapter(fakeAgendaJob())).rejects.toThrow(JobFailedError);
  });
});

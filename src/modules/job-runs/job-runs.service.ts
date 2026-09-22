import type { Types } from 'mongoose';
import {
  JobRunModel,
  type JobSkipReason,
  type JobStatus,
  type JobTrigger,
} from './job-runs.model.js';

export interface JobRunStats {
  coinsRequested: number;
  coinsReturned: number;
  snapshotsInserted: number;
  skippedUnchanged: number;
  missingCoins: string[];
  upstreamAttempts: number;
}

export const EMPTY_JOB_RUN_STATS: Readonly<JobRunStats> = Object.freeze({
  coinsRequested: 0,
  coinsReturned: 0,
  snapshotsInserted: 0,
  skippedUnchanged: 0,
  missingCoins: [],
  upstreamAttempts: 0,
});

export interface JobRunError {
  readonly code: string;
  readonly message: string;
}

export interface CreateRunningInput {
  readonly jobName: string;
  readonly trigger: JobTrigger;
  readonly startedAt: Date;
  readonly workerId: string;
}

export interface CloseRunInput {
  readonly status: Exclude<JobStatus, 'running'>;
  readonly finishedAt: Date;
  readonly durationMs: number;
  readonly stats: JobRunStats;
  readonly error: JobRunError | null;
  readonly skipReason?: JobSkipReason;
}

export interface CreateSkippedInput {
  readonly jobName: string;
  readonly trigger: JobTrigger;
  readonly skipReason: JobSkipReason;
  readonly at: Date;
  readonly workerId: string;
}

/**
 * Repository contract for `job_runs`. Injected into the polling job (create
 * + close) and used directly by `worker.ts` for the overlap guard's skipped
 * runs and stale-run recovery, neither of which the job itself knows about.
 */
export interface JobRunsRepo {
  createRunning(input: CreateRunningInput): Promise<Types.ObjectId>;
  closeRun(id: Types.ObjectId, patch: CloseRunInput): Promise<void>;
  createSkipped(input: CreateSkippedInput): Promise<Types.ObjectId>;
  /**
   * Marks every stale `running` run (`startedAt < olderThan`) as
   * `failed`/`STALE`, stamping `finishedAt` with `now`. Both instants are
   * passed in (rather than read from the system clock here) so callers can
   * drive this deterministically from an injected `clock`.
   */
  recoverStaleRuns(olderThan: Date, now: Date): Promise<number>;
}

export function createJobRunsRepo(): JobRunsRepo {
  return {
    async createRunning(input) {
      const doc = await JobRunModel.create({
        jobName: input.jobName,
        trigger: input.trigger,
        status: 'running',
        startedAt: input.startedAt,
        workerId: input.workerId,
        stats: { ...EMPTY_JOB_RUN_STATS },
      });
      return doc._id;
    },

    async closeRun(id, patch) {
      await JobRunModel.updateOne(
        { _id: id },
        {
          $set: {
            status: patch.status,
            finishedAt: patch.finishedAt,
            durationMs: patch.durationMs,
            stats: patch.stats,
            error: patch.error,
            ...(patch.skipReason !== undefined ? { skipReason: patch.skipReason } : {}),
          },
        },
      ).exec();
    },

    async createSkipped(input) {
      const doc = await JobRunModel.create({
        jobName: input.jobName,
        trigger: input.trigger,
        status: 'skipped',
        skipReason: input.skipReason,
        startedAt: input.at,
        finishedAt: input.at,
        durationMs: 0,
        stats: { ...EMPTY_JOB_RUN_STATS },
        workerId: input.workerId,
      });
      return doc._id;
    },

    async recoverStaleRuns(olderThan, now) {
      const result = await JobRunModel.updateMany(
        { status: 'running', startedAt: { $lt: olderThan } },
        {
          $set: {
            status: 'failed',
            finishedAt: now,
            error: {
              code: 'STALE',
              message: 'Recovered at worker startup: run exceeded the stale-run threshold.',
            },
          },
        },
      ).exec();
      return result.modifiedCount;
    },
  };
}

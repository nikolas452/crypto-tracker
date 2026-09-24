import type { Types } from 'mongoose';
import type { JobSkipReason, JobStatus, JobTrigger } from './job-runs.model.js';

/**
 * DTOs de salida del módulo de job-runs y el builder que los arma a partir
 * de un documento de `job_runs`.
 */

export interface JobRunStatsDto {
  readonly coinsRequested: number;
  readonly coinsReturned: number;
  readonly snapshotsInserted: number;
  readonly skippedUnchanged: number;
  readonly missingCoins: string[];
  readonly upstreamAttempts: number;
  readonly latestUpdated: number;
}

export interface JobRunErrorDto {
  readonly code: string;
  readonly message: string;
}

export interface JobRunDto {
  readonly id: string;
  readonly jobName: string;
  readonly trigger: JobTrigger;
  readonly status: JobStatus;
  readonly skipReason: JobSkipReason | null;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly durationMs: number | null;
  readonly stats: JobRunStatsDto;
  readonly error: JobRunErrorDto | null;
  readonly workerId: string;
}

/** El subconjunto de un documento `job_runs` del que leen estos builders de DTO. */
export interface JobRunDtoSource {
  readonly _id: Types.ObjectId;
  readonly jobName: string;
  readonly trigger: JobTrigger;
  readonly status: JobStatus;
  readonly skipReason: JobSkipReason | null;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly durationMs: number | null;
  readonly stats: JobRunStatsDto;
  readonly error: JobRunErrorDto | null;
  readonly workerId: string;
}

/**
 * Builder de DTO explícito campo por campo (design.md: "los DTOs de salida
 * son explícitos, no transforms de `toJSON`"). `_id` se mapea a `id` — la
 * spec admin-job-runs-api pide "el documento completo, sin `__v`", y `id`
 * es justamente lo que direcciona `GET /api/v1/admin/job-runs/:id`. `__v`
 * nunca está presente para empezar: el schema de `job_runs` define
 * `versionKey: false`.
 */
export function toJobRunDto(run: JobRunDtoSource): JobRunDto {
  return {
    id: run._id.toString(),
    jobName: run.jobName,
    trigger: run.trigger,
    status: run.status,
    skipReason: run.skipReason,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    stats: run.stats,
    error: run.error,
    workerId: run.workerId,
  };
}

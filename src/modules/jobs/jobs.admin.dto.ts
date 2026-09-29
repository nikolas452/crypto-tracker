import type { JobStatus } from '../job-runs/job-runs.model.js';

/**
 * DTOs de salida de `GET /api/v1/admin/jobs` (spec admin-jobs-api).
 */

export interface LastJobRunSummaryDto {
  readonly status: JobStatus;
  readonly finishedAt: Date | null;
}

export interface RecurringJobDto {
  readonly name: string;
  readonly schedule: string | null;
  readonly nextRunAt: Date | null;
  readonly lastRunAt: Date | null;
  readonly lastFinishedAt: Date | null;
  readonly failCount: number;
  readonly failReason: string | null;
  readonly failedAt: Date | null;
  readonly lockedAt: Date | null;
  readonly disabled: boolean;
  readonly lastJobRun: LastJobRunSummaryDto | null;
}

export interface OneOffJobDto {
  readonly agendaJobId: string;
  readonly name: string;
  readonly nextRunAt: Date | null;
  readonly lastRunAt: Date | null;
  readonly lastFinishedAt: Date | null;
  readonly failCount: number;
  readonly failReason: string | null;
  readonly data: unknown;
}

export interface AdminJobsListDto {
  readonly recurring: readonly RecurringJobDto[];
  readonly oneOff?: readonly OneOffJobDto[];
}

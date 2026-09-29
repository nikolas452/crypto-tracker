import type { Logger } from 'pino';
import type { Db } from 'mongodb';
import { Types } from 'mongoose';
import { config } from '../config/env.js';
import type { Clock } from '../lib/clock.js';
import {
  EMPTY_JOB_RUN_STATS,
  getLastSuccessfulRun,
  type JobRunError,
  type JobRunsRepo,
} from '../modules/job-runs/job-runs.service.js';
import type { JobStatus, JobTrigger } from '../modules/job-runs/job-runs.model.js';
import { isPollPricesStale } from '../modules/status/status.service.js';
import { countFailedSince } from '../modules/notifications/notifications.service.js';
import { pruneOneOffAgendaJobs } from '../scheduler/definitions.js';
import { JOB_NAME as POLL_PRICES_JOB_NAME, type JobRunResult } from './pollPrices.js';

/**
 * Job diario `maintenance` (spec maintenance-job): cuatro pasos
 * independientes de housekeeping que se ejecutan uno tras otro sin
 * interrumpirse entre sí — recuperación de `job_runs` obsoletos, poda de
 * documentos puntuales de `agenda_jobs`, y dos reportes en `warn`
 * (notificaciones fallidas recientes y polling obsoleto). Nunca reintenta
 * (ver `src/scheduler/definitions.ts` / design.md) y siempre cierra su
 * propia corrida como `success`: un paso que falla se loguea y no afecta el
 * resultado del job, porque son cuatro responsabilidades sin relación entre
 * sí — acoplarlas sería arbitrario.
 */

export const JOB_NAME = 'maintenance';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export interface CreateMaintenanceJobDeps {
  readonly jobRunsRepo: JobRunsRepo;
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly workerId: string;
}

export interface MaintenanceJob {
  run(trigger: JobTrigger): Promise<JobRunResult>;
}

/** Ejecuta `step` sin dejar que una excepción interrumpa los pasos siguientes (spec: "independent steps"). */
async function runStep(logger: Logger, name: string, step: () => Promise<void>): Promise<void> {
  try {
    await step();
  } catch (caught) {
    logger.error({ err: caught, step: name }, `maintenance: step "${name}" failed; continuing`);
  }
}

function toJobRunError(caught: unknown): JobRunError {
  if (caught instanceof Error) {
    return { code: 'INTERNAL', message: caught.message };
  }
  return { code: 'INTERNAL', message: 'Unknown error' };
}

export function createMaintenanceJob(deps: CreateMaintenanceJobDeps): MaintenanceJob {
  const { jobRunsRepo, db, clock, logger, workerId } = deps;

  return {
    async run(trigger) {
      const startedAt = clock.now();

      let runId: Types.ObjectId;
      try {
        runId = await jobRunsRepo.createRunning({ jobName: JOB_NAME, trigger, startedAt, workerId });
      } catch (caught) {
        logger.error(
          { err: caught, jobName: JOB_NAME, trigger },
          'maintenance: failed to create the JobRun document',
        );
        const finishedAt = clock.now();
        return {
          runId: new Types.ObjectId(),
          status: 'failed',
          startedAt,
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          stats: { ...EMPTY_JOB_RUN_STATS },
          error: toJobRunError(caught),
        };
      }

      logger.info({ runId: runId.toString(), jobName: JOB_NAME, trigger }, 'maintenance run started');

      await runStep(logger, 'recoverStaleRuns', async () => {
        const staleThreshold = new Date(
          startedAt.getTime() - config.STALE_RUN_THRESHOLD_MIN * MINUTE_MS,
        );
        const recovered = await jobRunsRepo.recoverStaleRuns(staleThreshold, startedAt);
        if (recovered > 0) {
          logger.warn({ recovered }, 'maintenance: recovered stale running JobRun(s)');
        }
      });

      await runStep(logger, 'pruneOneOffAgendaJobs', async () => {
        const pruned = await pruneOneOffAgendaJobs(
          db,
          config.AGENDA_ONE_OFF_RETENTION_DAYS,
          startedAt,
        );
        if (pruned > 0) {
          logger.info({ pruned }, 'maintenance: pruned finished one-off Agenda job documents');
        }
      });

      await runStep(logger, 'reportFailedNotifications', async () => {
        const since = new Date(startedAt.getTime() - 24 * HOUR_MS);
        const failedCount = await countFailedSince(since);
        if (failedCount > 0) {
          logger.warn({ failedCount }, 'maintenance: notifications failed in the last 24 hours');
        }
      });

      await runStep(logger, 'reportStalePolling', async () => {
        const lastSuccess = await getLastSuccessfulRun(POLL_PRICES_JOB_NAME);
        const stale = isPollPricesStale(lastSuccess?.finishedAt ?? null, startedAt);
        if (stale) {
          logger.warn({ jobName: POLL_PRICES_JOB_NAME }, 'maintenance: poll-prices is stale');
        }
      });

      const finishedAt = clock.now();
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      const status: Exclude<JobStatus, 'running'> = 'success';
      const stats = { ...EMPTY_JOB_RUN_STATS };

      try {
        await jobRunsRepo.closeRun(runId, { status, finishedAt, durationMs, stats, error: null });
      } catch (persistError) {
        logger.error(
          { runId: runId.toString(), err: persistError },
          'maintenance: failed to persist the run closure; it will be recovered as stale on next run',
        );
      }

      logger.info(
        { runId: runId.toString(), jobName: JOB_NAME, trigger, status, durationMs },
        'maintenance run finished',
      );

      return { runId, status, startedAt, finishedAt, durationMs, stats, error: null };
    },
  };
}

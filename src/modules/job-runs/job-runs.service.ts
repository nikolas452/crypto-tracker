import type { Types } from 'mongoose';
import {
  JobRunModel,
  type JobSkipReason,
  type JobStatus,
  type JobTrigger,
} from './job-runs.model.js';
import { buildPaginationMeta, type PaginatedResult } from '../../lib/pagination.js';
import { toJobRunDto, type JobRunDto, type JobRunDtoSource } from './job-runs.dto.js';
import type { JobRunListQuery } from './job-runs.schemas.js';

/**
 * Capa de servicio del módulo de job-runs: repositorio de `job_runs` y las
 * consultas usadas por el endpoint de status y las rutas de admin.
 */

/** Vista de `GET /api/v1/status` de la corrida más reciente de un job (spec system-status-api). */
export interface LastJobRunSummary {
  readonly status: JobStatus;
  readonly startedAt: Date;
}

/** Vista de `GET /api/v1/status` de la corrida exitosa más reciente de un job. */
export interface LastSuccessfulJobRun {
  readonly finishedAt: Date | null;
}

export interface JobRunStats {
  coinsRequested: number;
  coinsReturned: number;
  snapshotsInserted: number;
  skippedUnchanged: number;
  missingCoins: string[];
  upstreamAttempts: number;
  /** Cantidad de monedas cuyo `coins.latest` fue actualizado por esta corrida. */
  latestUpdated: number;
}

export const EMPTY_JOB_RUN_STATS: Readonly<JobRunStats> = Object.freeze({
  coinsRequested: 0,
  coinsReturned: 0,
  snapshotsInserted: 0,
  skippedUnchanged: 0,
  missingCoins: [],
  upstreamAttempts: 0,
  latestUpdated: 0,
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
 * Contrato de repositorio para `job_runs`. Se inyecta en el job de polling
 * (crear + cerrar) y lo usa directamente `worker.ts` para las corridas
 * omitidas por la guarda de solapamiento y la recuperación de corridas
 * obsoletas, de las cuales el job en sí no sabe nada.
 */
export interface JobRunsRepo {
  createRunning(input: CreateRunningInput): Promise<Types.ObjectId>;
  closeRun(id: Types.ObjectId, patch: CloseRunInput): Promise<void>;
  createSkipped(input: CreateSkippedInput): Promise<Types.ObjectId>;
  /**
   * Marca toda corrida `running` obsoleta (`startedAt < olderThan`) como
   * `failed`/`STALE`, sellando `finishedAt` con `now`. Ambos instantes se
   * pasan como parámetro (en lugar de leerse del reloj del sistema acá) para
   * que los callers puedan manejar esto de forma determinística desde un
   * `clock` inyectado.
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

/**
 * Fuente de datos de `GET /api/v1/status` para `lastRunAt`/`lastRunStatus`
 * (spec system-status-api: "se obtiene del JobRun más reciente con
 * jobName: poll-prices"). `null` cuando nunca se registró ninguna corrida.
 */
export async function getLastRun(jobName: string): Promise<LastJobRunSummary | null> {
  return JobRunModel.findOne({ jobName })
    .sort({ startedAt: -1 })
    .select({ status: 1, startedAt: 1, _id: 0 })
    .lean<LastJobRunSummary | null>()
    .exec();
}

/**
 * Fuente de datos de `GET /api/v1/status` para `lastSuccessAt` (spec
 * system-status-api: "una corrida parcial cuenta como éxito para
 * liveness"). `null` cuando nunca se registró ninguna corrida
 * `success`/`partial`.
 */
export async function getLastSuccessfulRun(jobName: string): Promise<LastSuccessfulJobRun | null> {
  return JobRunModel.findOne({ jobName, status: { $in: ['success', 'partial'] } })
    .sort({ finishedAt: -1 })
    .select({ finishedAt: 1, _id: 0 })
    .lean<LastSuccessfulJobRun | null>()
    .exec();
}

/**
 * Fuente de datos de `GET /api/v1/admin/job-runs`: una consulta de datos más
 * un `countDocuments` sobre el mismo filtro, ordenado por `startedAt`
 * descendente (spec admin-job-runs-api). Recibe solo valores tipados y
 * validados — nunca el `req`/`res` de Express (patrón 5.9, reutilizado de
 * `coins.service.ts`).
 */
export async function listJobRuns(query: JobRunListQuery): Promise<PaginatedResult<JobRunDto>> {
  const filter: Record<string, unknown> = {};

  if (query.jobName !== undefined) {
    filter.jobName = query.jobName;
  }
  if (query.status !== undefined) {
    filter.status = { $in: query.status };
  }
  if (query.from !== undefined || query.to !== undefined) {
    filter.startedAt = {
      ...(query.from !== undefined ? { $gte: query.from } : {}),
      ...(query.to !== undefined ? { $lte: query.to } : {}),
    };
  }

  const skip = (query.page - 1) * query.limit;

  const [docs, total] = await Promise.all([
    JobRunModel.find(filter)
      .sort({ startedAt: -1 })
      .skip(skip)
      .limit(query.limit)
      .lean<JobRunDtoSource[]>()
      .exec(),
    JobRunModel.countDocuments(filter).exec(),
  ]);

  return {
    data: docs.map(toJobRunDto),
    meta: buildPaginationMeta(query.page, query.limit, total),
  };
}

/**
 * Fuente de datos de `GET /api/v1/admin/job-runs/:id`. `id` ya fue validado
 * como un `ObjectId` bien formado por `jobRunIdParamSchema` antes de que
 * esto se llame. Devuelve `null` para un id desconocido; la ruta mapea eso a
 * 404 `NOT_FOUND` (spec admin-job-runs-api).
 */
export async function getJobRunById(id: string): Promise<JobRunDto | null> {
  const doc = await JobRunModel.findById(id).lean<JobRunDtoSource | null>().exec();
  return doc ? toJobRunDto(doc) : null;
}

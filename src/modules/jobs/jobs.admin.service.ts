import type { Db } from 'mongodb';
import { AGENDA_JOBS_COLLECTION, JOB_NAMES } from '../../scheduler/agenda.js';
import { getRecurringJobInfo, listRecurringJobsInfo } from '../../scheduler/definitions.js';
import { JobRunModel, type JobStatus } from '../job-runs/job-runs.model.js';
import type { AdminJobsListDto, OneOffJobDto } from './jobs.admin.dto.js';

/**
 * Capa de servicio de `GET/POST /api/v1/admin/jobs*` (spec admin-jobs-api):
 * combina el estado de los tres documentos recurrentes de `agenda_jobs` con
 * el `JobRun` más reciente de cada uno, y opcionalmente los jobs puntuales
 * de las últimas 24 horas.
 */

const DAY_MS = 86_400_000;

interface RawOneOffAgendaJobDoc {
  readonly _id: unknown;
  readonly name: string;
  readonly nextRunAt?: Date | null;
  readonly lastRunAt?: Date | null;
  readonly lastFinishedAt?: Date | null;
  readonly failCount?: number | null;
  readonly failReason?: string | null;
  readonly data?: unknown;
}

async function getLastJobRunSummary(
  jobName: string,
): Promise<{ status: JobStatus; finishedAt: Date | null } | null> {
  return JobRunModel.findOne({ jobName })
    .sort({ startedAt: -1 })
    .select({ status: 1, finishedAt: 1, _id: 0 })
    .lean<{ status: JobStatus; finishedAt: Date | null } | null>()
    .exec();
}

export async function listAdminJobs(db: Db, includeOneOff: boolean): Promise<AdminJobsListDto> {
  const recurringInfos = await listRecurringJobsInfo(db);

  const recurring = await Promise.all(
    recurringInfos.map(async (info) => ({
      ...info,
      lastJobRun: await getLastJobRunSummary(info.name),
    })),
  );

  if (!includeOneOff) {
    return { recurring };
  }

  const since = new Date(Date.now() - DAY_MS);
  const oneOffDocs = (await db
    .collection(AGENDA_JOBS_COLLECTION)
    .find({
      type: { $ne: 'single' },
      $or: [{ nextRunAt: { $gte: since } }, { lastRunAt: { $gte: since } }],
    })
    .toArray()) as unknown as RawOneOffAgendaJobDoc[];

  const oneOff: OneOffJobDto[] = oneOffDocs.map((doc) => ({
    agendaJobId: String(doc._id),
    name: doc.name,
    nextRunAt: doc.nextRunAt ?? null,
    lastRunAt: doc.lastRunAt ?? null,
    lastFinishedAt: doc.lastFinishedAt ?? null,
    failCount: doc.failCount ?? 0,
    failReason: doc.failReason ?? null,
    data: doc.data ?? null,
  }));

  return { recurring, oneOff };
}

/** `true` si el job recurrente `name` está deshabilitado (spec: "Triggering a disabled job conflicts"). */
export async function isJobDisabled(db: Db, name: string): Promise<boolean> {
  const info = await getRecurringJobInfo(db, name);
  return info.disabled;
}

export const JOB_NAME_VALUES: readonly string[] = Object.values(JOB_NAMES);

const TRIGGER_RATE_LIMIT_MS = 30_000;

export interface JobTriggerRateLimiter {
  /** `true` si `name` puede dispararse ahora; si es así, registra el instante para el próximo chequeo. */
  tryTrigger(name: string, now?: number): boolean;
}

/**
 * Un trigger por job cada 30s (spec: "Trigger endpoint rate limit"), para
 * proteger la cuota de CoinGecko de disparos repetidos. Estado en memoria
 * por instancia de la API — se crea una vez en `createAdminJobsRouter` y se
 * comparte entre requests, igual que `userRateLimiter` en `app.ts`.
 */
export function createJobTriggerRateLimiter(
  windowMs: number = TRIGGER_RATE_LIMIT_MS,
): JobTriggerRateLimiter {
  const lastTriggeredAt = new Map<string, number>();

  return {
    tryTrigger(name, now = Date.now()) {
      const last = lastTriggeredAt.get(name);
      if (last !== undefined && now - last < windowMs) {
        return false;
      }
      lastTriggeredAt.set(name, now);
      return true;
    },
  };
}

import type { Job } from 'agenda';
import type { Logger } from 'pino';
import { acquire as leaseAcquire, release as leaseRelease } from '../lib/lease-lock.js';
import type { Clock } from '../lib/clock.js';
import type { JobRunsRepo } from '../modules/job-runs/job-runs.service.js';
import type { JobTrigger } from '../modules/job-runs/job-runs.model.js';
import type { JobRunResult } from '../jobs/pollPrices.js';
import { JOB_NAMES } from './agenda.js';
import type { JobHandler } from './definitions.js';

/**
 * Adaptadores delgados entre Agenda y `src/jobs/*` (spec agenda-job-adapters):
 * derivan el `trigger` desde `job.attrs.data`, delegan la lógica real al job
 * inyectado y traducen su resultado — el job en sí nunca sabe que Agenda
 * existe. Reciben sus dependencias por closure desde una fábrica, nunca las
 * importan directamente (salvo `lease-lock`, cuya implementación real es el
 * valor por defecto de un parámetro reemplazable en los tests).
 */

/** Lanzado por un adaptador para que Agenda registre un `failCount`/`failReason` (solo para un resultado `failed`; ver cada adaptador). */
export class JobFailedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'JobFailedError';
    this.code = code;
  }
}

interface AgendaJobData {
  readonly trigger?: JobTrigger;
  readonly attempt?: number;
}

/**
 * `job.attrs.data` llega tipado como `unknown` desde Agenda (el `DATA`
 * genérico de `JobHandler` es el default de la librería): estos dos helpers
 * son el único lugar que interpreta esa forma, con un cast explícito en
 * lugar de propagar un genérico hasta la firma de `JobHandler`.
 */
function dataOf(job: Job): AgendaJobData | undefined {
  return job.attrs.data as AgendaJobData | undefined;
}

/** Deriva el `trigger` de `job.attrs.data`, con `"agenda"` por defecto (spec: "Trigger derivation"). */
function deriveTrigger(job: Job): JobTrigger {
  return dataOf(job)?.trigger ?? 'agenda';
}

function jobIdOf(job: Job): string | undefined {
  return job.attrs._id?.toString();
}

export interface LeaseDeps {
  readonly acquire: typeof leaseAcquire;
  readonly release: typeof leaseRelease;
}

const defaultLease: LeaseDeps = { acquire: leaseAcquire, release: leaseRelease };

export interface RunnableJob {
  run(trigger: JobTrigger): Promise<JobRunResult>;
}

export interface PollPricesAdapterDeps {
  readonly job: RunnableJob;
  readonly jobRunsRepo: Pick<JobRunsRepo, 'createSkipped' | 'attachAgendaMetadata'>;
  readonly clock: Clock;
  readonly workerId: string;
  readonly leaseTtlMs: number;
  readonly logger: Logger;
  /** Inyectable para tests unitarios/de integración; por defecto, la implementación real de `src/lib/lease-lock.ts`. */
  readonly lease?: LeaseDeps;
}

/**
 * Adaptador de `poll-prices` (specs agenda-job-adapters / lease-lock):
 * adquiere el lease `poll-prices` antes de correr el job real, lo libera en
 * un `finally`, y solo lanza `JobFailedError` cuando el resultado es
 * `failed` — nunca para `skipped`/`partial` — DESPUÉS de que su `JobRun` ya
 * fue escrito por el job. Cuando el lease está tomado, registra su propio
 * `JobRun` `skipped`/`locked` sin siquiera llamar al job real.
 */
export function createPollPricesAdapter(deps: PollPricesAdapterDeps): JobHandler {
  const { job, jobRunsRepo, clock, workerId, leaseTtlMs, logger } = deps;
  const lease = deps.lease ?? defaultLease;

  return async (agendaJob: Job) => {
    const trigger = deriveTrigger(agendaJob);
    const attempt = dataOf(agendaJob)?.attempt ?? 1;
    const agendaJobId = jobIdOf(agendaJob);
    // El owner del lease combina el workerId con el id del documento de
    // Agenda: distingue una corrida de otra sin depender de un reloj de
    // wall-clock adicional (ver el requisito de relojes sincronizados en
    // `src/lib/lease-lock.ts`).
    const owner = `${workerId}:${agendaJobId ?? 'unknown'}`;

    const acquired = await lease.acquire(JOB_NAMES.POLL_PRICES, owner, leaseTtlMs, clock.now());

    if (!acquired) {
      logger.info(
        { jobName: JOB_NAMES.POLL_PRICES, trigger, agendaJobId },
        'poll-prices: lease held by another owner; skipping this run',
      );
      await jobRunsRepo.createSkipped({
        jobName: JOB_NAMES.POLL_PRICES,
        trigger,
        skipReason: 'locked',
        at: clock.now(),
        workerId,
        agendaJobId,
        attempt,
      });
      return;
    }

    try {
      const result = await job.run(trigger);
      await jobRunsRepo.attachAgendaMetadata(result.runId, { agendaJobId, attempt });

      if (result.status === 'failed') {
        throw new JobFailedError(
          result.error?.code ?? 'INTERNAL',
          result.error?.message ?? 'poll-prices run failed',
        );
      }
    } finally {
      await lease.release(JOB_NAMES.POLL_PRICES, owner);
    }
  };
}

export interface MaintenanceAdapterDeps {
  readonly job: RunnableJob;
  readonly jobRunsRepo: Pick<JobRunsRepo, 'attachAgendaMetadata'>;
}

/**
 * Adaptador de `maintenance` (spec agenda-job-adapters/maintenance-job): el
 * job siempre cierra su propia corrida como `success` (cada paso es
 * independiente y sus fallos solo se loguean — ver `src/jobs/maintenance.ts`),
 * así que este adaptador nunca lanza.
 */
export function createMaintenanceAdapter(deps: MaintenanceAdapterDeps): JobHandler {
  const { job, jobRunsRepo } = deps;

  return async (agendaJob: Job) => {
    const trigger = deriveTrigger(agendaJob);
    const attempt = dataOf(agendaJob)?.attempt ?? 1;
    const agendaJobId = jobIdOf(agendaJob);

    const result = await job.run(trigger);
    await jobRunsRepo.attachAgendaMetadata(result.runId, { agendaJobId, attempt });
  };
}

export interface SendNotificationsAdapterDeps {
  readonly job: RunnableJob;
  readonly jobRunsRepo: Pick<JobRunsRepo, 'attachAgendaMetadata'>;
}

/**
 * Adaptador de `send-notifications` (spec agenda-job-adapters): sin lease
 * (el reclamo atómico por notificación ya alcanza — ver
 * `src/lib/lease-lock.ts`). Solo lanza cuando el job resulta `failed`, lo
 * que en `src/jobs/sendNotifications.ts` únicamente ocurre ante un fallo de
 * infraestructura (por ejemplo, no poder abrir el `JobRun`), nunca por el
 * fallo de un envío individual — esos se reflejan en `stats` con estado
 * `success` general.
 */
export function createSendNotificationsAdapter(deps: SendNotificationsAdapterDeps): JobHandler {
  const { job, jobRunsRepo } = deps;

  return async (agendaJob: Job) => {
    const trigger = deriveTrigger(agendaJob);
    const attempt = dataOf(agendaJob)?.attempt ?? 1;
    const agendaJobId = jobIdOf(agendaJob);

    const result = await job.run(trigger);
    await jobRunsRepo.attachAgendaMetadata(result.runId, { agendaJobId, attempt });

    if (result.status === 'failed') {
      throw new JobFailedError(
        result.error?.code ?? 'INTERNAL',
        result.error?.message ?? 'send-notifications run failed',
      );
    }
  };
}

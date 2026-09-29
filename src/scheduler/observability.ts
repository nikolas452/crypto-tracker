import type { Agenda, Job } from 'agenda';
import type { Logger } from 'pino';

/**
 * Observabilidad del scheduler (spec scheduler-observability): logging de
 * ciclo de vida por job a los niveles indicados, y un resumen periódico de
 * contadores en memoria.
 *
 * El stack trace nunca llega a `failReason` (el campo que Agenda persiste en
 * `agenda_jobs`) porque esa librería lo asigna a partir de `error.message`
 * exclusivamente (nunca `error.stack`) — ver `Job.fail()`. Nuestros
 * adaptadores (`src/scheduler/adapters.ts`) construyen `JobFailedError` con
 * un `message` limpio, así que ese requisito se cumple por construcción; acá
 * el stack solo se agrega al log, nunca al documento.
 */

interface JobCounters {
  started: number;
  succeeded: number;
  failed: number;
}

interface FailedLike {
  readonly code?: string;
  readonly stack?: string;
}

export interface ObservabilityDeps {
  readonly logger: Logger;
  /** Intervalo del resumen periódico en ms. Por defecto 10 minutos; ajustable para tests. */
  readonly summaryIntervalMs?: number;
}

export interface ObservabilityHandle {
  /** Detiene el resumen periódico. Debe llamarse durante el apagado del worker para no dejar un timer colgado. */
  stop(): void;
  /** Snapshot de los contadores acumulados, expuesto para tests. */
  getCounters(): Readonly<Record<string, Readonly<JobCounters>>>;
}

function jobIdOf(job: Job): string | undefined {
  return job.attrs._id?.toString();
}

/**
 * Registra los listeners `start`/`success`/`fail` de Agenda (spec: "Job
 * lifecycle event logging") y el resumen periódico de contadores por job
 * (spec: "Periodic counter summary"). Se llama una sola vez sobre la
 * instancia `worker` del scheduler — la `producer` nunca procesa jobs, así
 * que nunca emite estos eventos.
 */
export function registerObservability(agenda: Agenda, deps: ObservabilityDeps): ObservabilityHandle {
  const { logger } = deps;
  const summaryIntervalMs = deps.summaryIntervalMs ?? 10 * 60_000;
  const counters = new Map<string, JobCounters>();

  function bump(jobName: string, key: keyof JobCounters): void {
    const current = counters.get(jobName) ?? { started: 0, succeeded: 0, failed: 0 };
    current[key] += 1;
    counters.set(jobName, current);
  }

  agenda.on('start', (job: Job) => {
    bump(job.attrs.name, 'started');
    logger.debug({ jobName: job.attrs.name, agendaJobId: jobIdOf(job) }, 'scheduler: job started');
  });

  agenda.on('success', (job: Job) => {
    bump(job.attrs.name, 'succeeded');
    logger.debug({ jobName: job.attrs.name, agendaJobId: jobIdOf(job) }, 'scheduler: job succeeded');
  });

  agenda.on('fail', (error: Error, job: Job) => {
    bump(job.attrs.name, 'failed');
    const failure = error as FailedLike;
    logger.error(
      {
        jobName: job.attrs.name,
        agendaJobId: jobIdOf(job),
        code: failure.code,
        stack: failure.stack,
      },
      'scheduler: job failed',
    );
  });

  const interval = setInterval(() => {
    logger.info(
      { counters: Object.fromEntries(counters) },
      'scheduler: periodic per-job counter summary',
    );
  }, summaryIntervalMs);
  interval.unref();

  return {
    stop() {
      clearInterval(interval);
    },
    getCounters() {
      return Object.fromEntries(counters);
    },
  };
}

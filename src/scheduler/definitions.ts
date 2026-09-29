import type { Agenda, Job } from 'agenda';
import type { Db } from 'mongodb';
import { config, type Config } from '../config/env.js';
import { AGENDA_JOBS_COLLECTION, JOB_NAMES, type JobName } from './agenda.js';

/**
 * Define los tres jobs recurrentes de Agenda (spec agenda-job-definitions)
 * con su concurrencia, límite de locks, tiempo de vida del lock y prioridad,
 * y los mantiene registrados de forma idempotente en cada arranque —
 * reiniciar el worker nunca duplica un documento recurrente ni le hace
 * perder su schedule ni su flag `disabled`.
 */

const MINUTE_MS = 60_000;

export type JobHandler = (job: Job) => Promise<void>;

export interface JobHandlers {
  readonly [JOB_NAMES.POLL_PRICES]: JobHandler;
  readonly [JOB_NAMES.SEND_NOTIFICATIONS]: JobHandler;
  readonly [JOB_NAMES.MAINTENANCE]: JobHandler;
}

/**
 * Define los tres jobs con su concurrencia/lock/prioridad (spec: "Three
 * recurring job definitions"). Los handlers son los adaptadores de
 * `src/scheduler/adapters.ts`, inyectados para que este módulo no conozca
 * ninguna dependencia concreta más allá de la forma `(job) => Promise<void>`.
 */
export function defineJobs(agenda: Agenda, handlers: JobHandlers): void {
  agenda.define(JOB_NAMES.POLL_PRICES, handlers[JOB_NAMES.POLL_PRICES], {
    concurrency: 1,
    lockLimit: 1,
    lockLifetime: 5 * MINUTE_MS,
    priority: 'high',
  });

  agenda.define(JOB_NAMES.SEND_NOTIFICATIONS, handlers[JOB_NAMES.SEND_NOTIFICATIONS], {
    concurrency: 1,
    lockLimit: 1,
    lockLifetime: 5 * MINUTE_MS,
    priority: 'high',
  });

  agenda.define(JOB_NAMES.MAINTENANCE, handlers[JOB_NAMES.MAINTENANCE], {
    concurrency: 1,
    lockLimit: 1,
    lockLifetime: 15 * MINUTE_MS,
    priority: 'low',
  });
}

const MS_PER_DAY = 86_400_000;

/**
 * Elimina los documentos NO recurrentes de `agenda_jobs` (`type !==
 * 'single'`, es decir, creados con `agenda.now()`) que terminaron hace más
 * de `retentionDays` (spec maintenance-job: "One-off job pruning step").
 * Los documentos recurrentes (`type: 'single'`) nunca se tocan acá.
 */
export async function pruneOneOffAgendaJobs(
  db: Db,
  retentionDays: number,
  now: Date,
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * MS_PER_DAY);
  const result = await db.collection(AGENDA_JOBS_COLLECTION).deleteMany({
    type: { $ne: 'single' },
    lastFinishedAt: { $ne: null, $lt: cutoff },
  });
  return result.deletedCount;
}

/**
 * Elimina cualquier documento de `agenda_jobs` cuyo nombre ya no esté
 * definido (spec: "Obsolete recurring jobs are removed"). `Agenda.purge()`
 * hace exactamente esto (`cancel({ notNames: Object.keys(definitions) })`)
 * — por eso debe llamarse DESPUÉS de {@link defineJobs}, tal como documenta
 * la propia librería.
 */
export async function removeObsoleteJobs(agenda: Agenda): Promise<number> {
  return agenda.purge();
}

interface RecurringJobSpec {
  readonly name: JobName;
  readonly cron: string;
}

function recurringJobSpecs(cfg: Config): readonly RecurringJobSpec[] {
  return [
    { name: JOB_NAMES.POLL_PRICES, cron: cfg.POLL_PRICES_CRON },
    { name: JOB_NAMES.SEND_NOTIFICATIONS, cron: cfg.SEND_NOTIFICATIONS_CRON },
    { name: JOB_NAMES.MAINTENANCE, cron: cfg.MAINTENANCE_CRON },
  ];
}

/** `true` si ya existe un documento recurrente de `name` y está deshabilitado. */
async function isCurrentlyDisabled(db: Db, name: string): Promise<boolean> {
  const existing = await db
    .collection(AGENDA_JOBS_COLLECTION)
    .findOne({ name, type: 'single' }, { projection: { disabled: 1 } });
  return existing?.disabled === true;
}

/** Subconjunto del documento recurrente de `agenda_jobs` que expone la API de admin y `GET /api/v1/status`. */
export interface RecurringJobInfo {
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
}

interface RawRecurringAgendaJobDoc {
  readonly repeatInterval?: string | null;
  readonly nextRunAt?: Date | null;
  readonly lastRunAt?: Date | null;
  readonly lastFinishedAt?: Date | null;
  readonly failCount?: number | null;
  readonly failReason?: string | null;
  readonly failedAt?: Date | null;
  readonly lockedAt?: Date | null;
  readonly disabled?: boolean | null;
}

function toRecurringJobInfo(name: string, doc: RawRecurringAgendaJobDoc | null): RecurringJobInfo {
  return {
    name,
    schedule: doc?.repeatInterval ?? null,
    nextRunAt: doc?.nextRunAt ?? null,
    lastRunAt: doc?.lastRunAt ?? null,
    lastFinishedAt: doc?.lastFinishedAt ?? null,
    failCount: doc?.failCount ?? 0,
    failReason: doc?.failReason ?? null,
    failedAt: doc?.failedAt ?? null,
    lockedAt: doc?.lockedAt ?? null,
    disabled: doc?.disabled === true,
  };
}

/**
 * Lee el estado del documento recurrente `name` directamente de
 * `agenda_jobs` (design.md: "lectura con consultas de solo lectura cuando
 * la API propia de Agenda no alcanza"). Usado por `GET /api/v1/admin/jobs`,
 * el chequeo de "job deshabilitado" del endpoint de disparo, y `GET
 * /api/v1/status` (`nextRunAt`/`disabled` de `poll-prices`).
 */
export async function getRecurringJobInfo(db: Db, name: string): Promise<RecurringJobInfo> {
  const doc = (await db
    .collection(AGENDA_JOBS_COLLECTION)
    .findOne({ name, type: 'single' })) as RawRecurringAgendaJobDoc | null;
  return toRecurringJobInfo(name, doc);
}

/** Mismo campo que {@link getRecurringJobInfo}, para los tres jobs conocidos, en el orden de `JOB_NAMES`. */
export async function listRecurringJobsInfo(db: Db): Promise<readonly RecurringJobInfo[]> {
  const names = Object.values(JOB_NAMES);
  const docs = (await db
    .collection(AGENDA_JOBS_COLLECTION)
    .find({ type: 'single', name: { $in: names } })
    .toArray()) as unknown as Array<RawRecurringAgendaJobDoc & { name: string }>;
  const byName = new Map(docs.map((doc) => [doc.name, doc]));
  return names.map((name) => toRecurringJobInfo(name, byName.get(name) ?? null));
}

/**
 * Registra los tres jobs como recurrentes llamando a `every()` en cada
 * arranque (spec: "Idempotent recurring registration"): `every()` hace un
 * upsert sobre `{ name, type: 'single' }`, así que reiniciar el worker deja
 * exactamente un documento por nombre (E6-2) y actualiza `nextRunAt` cuando
 * la expresión cron cambió (E6-3). Cada llamada pasa `timezone: 'UTC'`
 * explícitamente para que la programación no dependa de la zona horaria del
 * host.
 *
 * El backend de Mongo de Agenda persiste `disabled: null` en CADA llamada a
 * `every()` (es parte de cómo guarda el documento), lo que re-habilitaría
 * silenciosamente un job que un administrador deshabilitó a propósito. Por
 * eso acá se consulta el estado ANTES de llamar a `every()` y, si ya estaba
 * deshabilitado, se vuelve a deshabilitar después (spec: "Registration does
 * not re-enable a disabled job" / E6-9).
 *
 * Devuelve el `Job` resultante de cada `every()`: `every()` nunca rechaza
 * por una expresión cron inválida (Agenda atrapa el error de
 * `cron-parser` internamente y deja `nextRunAt: null` en el documento) — a
 * diferencia del `cron.validate()` de node-cron que este stage reemplaza.
 * El caller (`src/worker.ts`) es quien decide fallar rápido inspeccionando
 * `nextRunAt` en el resultado (spec worker-process, REMOVED "Cron
 * scheduling in UTC": "Expression validity is reported by Agenda at
 * registration time instead of by cron.validate()").
 */
export async function registerRecurringJobs(
  agenda: Agenda,
  db: Db,
  cfg: Config = config,
): Promise<ReadonlyMap<JobName, Job>> {
  const results = new Map<JobName, Job>();

  for (const { name, cron } of recurringJobSpecs(cfg)) {
    const wasDisabled = await isCurrentlyDisabled(db, name);

    const job = await agenda.every(cron, name, undefined, { timezone: 'UTC' });

    if (wasDisabled) {
      await agenda.disable({ name });
    }

    results.set(name, job);
  }

  return results;
}

import { Agenda, type Job, type RemoveJobsOptions } from 'agenda';
import { MongoBackend } from '@agendajs/mongo-backend';
import type { Db } from 'mongodb';
import { config } from '../config/env.js';

/**
 * Fábrica del scheduler (spec agenda-scheduler): construye una instancia de
 * Agenda sobre la colección `agenda_jobs`, compartiendo la conexión de
 * Mongoose existente (ver la nota de verificación de versión de driver en
 * `src/config/env.ts` — mongoose y `@agendajs/mongo-backend` resuelven el
 * mismo `mongodb@7.6.0`, así que no hace falta una segunda conexión).
 *
 * El `role` distingue cómo la usa cada proceso, pero esta fábrica en sí NO
 * define jobs ni llama a `start()` — esa decisión queda en manos de quien la
 * usa: el worker (`role: 'worker'`) es el único proceso que define los tres
 * jobs, los registra como recurrentes y arranca el procesamiento
 * (`src/worker.ts`); la API (`role: 'producer'`) solo la usa para encolar
 * trabajo con `agenda.now()`/`agenda.every()` y nunca llama a `start()`, así
 * que nunca procesa nada (spec: "Producer role never processes").
 */

export const JOB_NAMES = {
  POLL_PRICES: 'poll-prices',
  SEND_NOTIFICATIONS: 'send-notifications',
  MAINTENANCE: 'maintenance',
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

export const AGENDA_JOBS_COLLECTION = 'agenda_jobs';

export type AgendaRole = 'worker' | 'producer';

export interface CreateAgendaOptions {
  readonly db: Db;
  readonly role: AgendaRole;
}

export function createAgenda({ db, role }: CreateAgendaOptions): Agenda {
  return new Agenda({
    name: role,
    backend: new MongoBackend({ mongo: db, collection: AGENDA_JOBS_COLLECTION }),
    processEvery: config.AGENDA_PROCESS_EVERY,
    maxConcurrency: config.AGENDA_MAX_CONCURRENCY,
    defaultConcurrency: 1,
  });
}

/** El subconjunto de `Agenda` que necesita el productor de la API (spec admin-jobs-api): encolar y (des)habilitar, nunca procesar. */
export interface AgendaProducerHandle {
  now<DATA = unknown>(name: string, data: DATA): Promise<Job<DATA>>;
  disable(options: RemoveJobsOptions): Promise<number>;
  enable(options: RemoveJobsOptions): Promise<number>;
}

/**
 * Variante perezosa de `createAgenda({ role: 'producer' })`, en el mismo
 * espíritu que `createLazyCoinGeckoClient()`/`createLazyFirebaseTokenVerifier()`:
 * el default de `createApp(deps)` NUNCA debe construir una instancia real de
 * Agenda (con su propia conexión a `agenda_jobs` y creación de índices) para
 * un test que jamás toca `/admin/jobs` — construirla en cada llamada a
 * `createApp()` dejaba operaciones async colgadas contra la conexión
 * compartida de Mongo, que fallaban al cerrarse esa conexión al final del
 * archivo de test ("Cannot use a session that has ended"). `getOptions` es
 * una función (no un valor) por la misma razón: resolver `db` recién en el
 * primer uso real, nunca al construir la app.
 */
export function createLazyAgenda(getOptions: () => CreateAgendaOptions): AgendaProducerHandle {
  let real: Agenda | undefined;

  async function resolve(): Promise<Agenda> {
    if (!real) {
      real = createAgenda(getOptions());
      await real.ready;
    }
    return real;
  }

  return {
    now: async (name, data) => (await resolve()).now(name, data),
    disable: async (opts) => (await resolve()).disable(opts),
    enable: async (opts) => (await resolve()).enable(opts),
  };
}

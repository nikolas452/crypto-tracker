import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Agenda } from 'agenda';
import mongoose from 'mongoose';
import type { Db } from 'mongodb';
import { config, type Config } from '../../src/config/env.js';
import { createAgenda, JOB_NAMES } from '../../src/scheduler/agenda.js';
import {
  defineJobs,
  registerRecurringJobs,
  removeObsoleteJobs,
  type JobHandlers,
} from '../../src/scheduler/definitions.js';
import { clearDatabase, startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';
import { waitForJob } from '../helpers/agendaTestHelpers.js';

/**
 * Tests de integración de `src/scheduler/agenda.ts` y
 * `src/scheduler/definitions.ts` (specs agenda-scheduler /
 * agenda-job-definitions): E6-1, E6-2, E6-3 y E6-9. Los handlers son no-ops:
 * estos tests cubren solo el registro/idempotencia del schedule, no la
 * ejecución de los jobs (eso lo cubren los tests de los adaptadores).
 */

const noopHandlers: JobHandlers = {
  [JOB_NAMES.POLL_PRICES]: async () => {},
  [JOB_NAMES.SEND_NOTIFICATIONS]: async () => {},
  [JOB_NAMES.MAINTENANCE]: async () => {},
};

function getDb(): Db {
  const db = mongoose.connection.db;
  if (!db) throw new Error('no db connection');
  return db;
}

/** Simula un arranque completo del worker: define, purga obsoletos y registra los recurrentes. Nunca llama a start(). */
async function bootScheduler(cfg: Config = config): Promise<Agenda> {
  const agenda = createAgenda({ db: getDb(), role: 'worker' });
  await agenda.ready;
  defineJobs(agenda, noopHandlers);
  await removeObsoleteJobs(agenda);
  await registerRecurringJobs(agenda, getDb(), cfg);
  return agenda;
}

describe('scheduler definitions (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 120000);

  afterEach(async () => {
    await clearDatabase();
  });

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  it('E6-1: a fresh database gets exactly 3 recurring jobs', async () => {
    await bootScheduler();

    const docs = await getDb().collection('agenda_jobs').find({ type: 'single' }).toArray();
    expect(docs).toHaveLength(3);
    expect(docs.map((doc) => doc.name).sort()).toEqual(
      [JOB_NAMES.POLL_PRICES, JOB_NAMES.SEND_NOTIFICATIONS, JOB_NAMES.MAINTENANCE].sort(),
    );
  });

  it('E6-2: 3 restarts leave exactly 1 document per name', async () => {
    await bootScheduler();
    await bootScheduler();
    await bootScheduler();

    const docs = await getDb().collection('agenda_jobs').find({ type: 'single' }).toArray();
    expect(docs).toHaveLength(3);
  });

  it('E6-3: a changed POLL_PRICES_CRON updates the recurring schedule', async () => {
    await bootScheduler();

    await bootScheduler({ ...config, POLL_PRICES_CRON: '*/15 * * * *' });

    const doc = await getDb()
      .collection('agenda_jobs')
      .findOne({ name: JOB_NAMES.POLL_PRICES, type: 'single' });
    expect(doc?.repeatInterval).toBe('*/15 * * * *');
  });

  it('E6-9: a job disabled through the API stays disabled after a restart', async () => {
    const agenda = await bootScheduler();
    await agenda.disable({ name: JOB_NAMES.POLL_PRICES });

    await bootScheduler();

    const doc = await getDb()
      .collection('agenda_jobs')
      .findOne({ name: JOB_NAMES.POLL_PRICES, type: 'single' });
    expect(doc?.disabled).toBe(true);
  });

  it('actually runs a defined job once it is due, with a low processEvery', async () => {
    const ranNames: string[] = [];
    const handlers: JobHandlers = {
      [JOB_NAMES.POLL_PRICES]: async () => {
        ranNames.push(JOB_NAMES.POLL_PRICES);
      },
      [JOB_NAMES.SEND_NOTIFICATIONS]: async () => {},
      [JOB_NAMES.MAINTENANCE]: async () => {},
    };

    // Nota: Agenda usa `human-interval` para strings como '10 seconds', que
    // NO soporta la unidad "milliseconds" (su regex matchea la subcadena
    // "second" dentro de "milliseconds", así que '200 milliseconds' se
    // interpretaría como 200 SEGUNDOS). Un número crudo evita la ambigüedad.
    const agenda = createAgenda({ db: getDb(), role: 'worker' });
    agenda.processEvery(200);
    await agenda.ready;
    defineJobs(agenda, handlers);
    await removeObsoleteJobs(agenda);
    await agenda.every('1 second', JOB_NAMES.POLL_PRICES, undefined, { timezone: 'UTC' });

    await agenda.start();
    try {
      await waitForJob(agenda, JOB_NAMES.POLL_PRICES, 10000);
    } finally {
      await agenda.stop();
    }

    expect(ranNames).toContain(JOB_NAMES.POLL_PRICES);
  });
});

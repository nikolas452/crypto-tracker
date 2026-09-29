import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import mongoose from 'mongoose';
import { ObjectId, type Db } from 'mongodb';
import { createApp } from '../../src/app.js';
import { UserModel } from '../../src/modules/users/users.model.js';
import { createCoinsRepo } from '../../src/modules/coins/coins.service.js';
import { createSnapshotsRepo } from '../../src/modules/snapshots/snapshots.service.js';
import { createJobRunsRepo } from '../../src/modules/job-runs/job-runs.service.js';
import { createPollPricesJob } from '../../src/jobs/pollPrices.js';
import { systemClock } from '../../src/lib/clock.js';
import { createFakeTokenVerifier } from '../../src/integrations/firebase/fakeTokenVerifier.js';
import { ensureCollections } from '../../src/db/ensureCollections.js';
import { createPollPricesAdapter } from '../../src/scheduler/adapters.js';
import { createAgenda, JOB_NAMES } from '../../src/scheduler/agenda.js';
import { registerRecurringJobs } from '../../src/scheduler/definitions.js';
import { clearDatabase, startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';

const silentLogger = pino({ level: 'silent' });

const ADMIN_TOKEN = 'jobs-admin-token';
const USER_TOKEN = 'jobs-user-token';
const ADMIN_IDENTITY = {
  uid: 'jobs-admin-uid',
  email: 'jobs-admin@example.com',
  emailVerified: true,
  name: null,
};
const USER_IDENTITY = {
  uid: 'jobs-plain-user-uid',
  email: 'jobs-plain-user@example.com',
  emailVerified: true,
  name: null,
};

function createAppWithFakeAuth() {
  return createApp({
    logger: silentLogger,
    tokenVerifier: createFakeTokenVerifier({
      identities: { [ADMIN_TOKEN]: ADMIN_IDENTITY, [USER_TOKEN]: USER_IDENTITY },
    }),
  });
}

async function seedAdminUser(): Promise<void> {
  await UserModel.create({
    firebaseUid: ADMIN_IDENTITY.uid,
    email: ADMIN_IDENTITY.email,
    emailVerified: ADMIN_IDENTITY.emailVerified,
    displayName: null,
    role: 'admin',
    lastSeenAt: new Date(),
  });
}

async function seedRegularUser(): Promise<void> {
  await UserModel.create({
    firebaseUid: USER_IDENTITY.uid,
    email: USER_IDENTITY.email,
    emailVerified: USER_IDENTITY.emailVerified,
    displayName: null,
    role: 'user',
    lastSeenAt: new Date(),
  });
}

function getDb(): Db {
  const db = mongoose.connection.db;
  if (!db) throw new Error('no db connection');
  return db;
}

/** Levanta un worker real (rol `worker`) para que un job encolado por la API efectivamente se procese. */
async function startFakeWorker() {
  const db = getDb();
  const agenda = createAgenda({ db, role: 'worker' });
  agenda.processEvery(200);

  const job = createPollPricesJob({
    coinsRepo: createCoinsRepo(),
    snapshotsRepo: createSnapshotsRepo(),
    jobRunsRepo: createJobRunsRepo(),
    coingecko: {
      getSimplePrices: async () => ({ prices: new Map(), attempts: 1 }),
    },
    clock: systemClock,
    logger: silentLogger,
    workerId: 'fake-worker',
  });

  const adapter = createPollPricesAdapter({
    job,
    jobRunsRepo: createJobRunsRepo(),
    clock: systemClock,
    workerId: 'fake-worker',
    leaseTtlMs: 300000,
    logger: silentLogger,
  });

  agenda.define(JOB_NAMES.POLL_PRICES, adapter, {
    concurrency: 1,
    lockLimit: 1,
    lockLifetime: 300000,
  });

  await agenda.start();
  return agenda;
}

/** Espera hasta que `predicate()` sea `true` o venza `timeoutMs`. */
async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('waitUntil: condition never became true within the timeout');
}

/**
 * Tests de integración de `/api/v1/admin/jobs*` (spec admin-jobs-api):
 * E6-10 (202 -> JobRun con trigger: api), E6-11 (nombre desconocido -> 404,
 * usuario regular -> 403) y E6-14 (la API encola pero nunca procesa sin un
 * worker corriendo).
 */
describe('admin jobs API (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
    await ensureCollections(silentLogger);
  }, 120000);

  afterEach(async () => {
    await clearDatabase();
  });

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  it('GET /api/v1/admin/jobs lists the three recurring jobs, even with none registered yet', async () => {
    await seedAdminUser();
    const app = createAppWithFakeAuth();

    const response = await request(app)
      .get('/api/v1/admin/jobs')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(response.status).toBe(200);
    expect(response.body.data.recurring).toHaveLength(3);
    expect(response.body.data.recurring.map((job: { name: string }) => job.name).sort()).toEqual(
      [JOB_NAMES.POLL_PRICES, JOB_NAMES.SEND_NOTIFICATIONS, JOB_NAMES.MAINTENANCE].sort(),
    );
  });

  it('E6-11: an unknown job name is 404', async () => {
    await seedAdminUser();
    const app = createAppWithFakeAuth();

    const response = await request(app)
      .post('/api/v1/admin/jobs/not-a-real-job/run')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(response.status).toBe(404);
  });

  it('E6-11: a regular user gets 403 FORBIDDEN', async () => {
    await seedRegularUser();
    const app = createAppWithFakeAuth();

    const response = await request(app)
      .post(`/api/v1/admin/jobs/${JOB_NAMES.POLL_PRICES}/run`)
      .set('Authorization', `Bearer ${USER_TOKEN}`);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('E6-14: the API enqueues a job but never processes it while no worker runs', async () => {
    await seedAdminUser();
    const app = createAppWithFakeAuth();

    const response = await request(app)
      .post(`/api/v1/admin/jobs/${JOB_NAMES.POLL_PRICES}/run`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(response.status).toBe(202);
    expect(response.body.data.agendaJobId).toBeTruthy();
    expect(response.body.data.name).toBe(JOB_NAMES.POLL_PRICES);

    // Da tiempo de sobra: si hubiera un worker, ya habría procesado el job.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const doc = await getDb()
      .collection('agenda_jobs')
      .findOne({ _id: new ObjectId(response.body.data.agendaJobId as string) });
    expect(doc?.lastRunAt).toBeFalsy();
    expect(doc?.lastFinishedAt).toBeFalsy();

    const runs = await getDb().collection('job_runs').find({ trigger: 'api' }).toArray();
    expect(runs).toHaveLength(0);
  });

  it('E6-10: 202 Accepted, and a JobRun with trigger: api appears once a worker picks it up', async () => {
    await seedAdminUser();
    const app = createAppWithFakeAuth();
    const worker = await startFakeWorker();

    try {
      const response = await request(app)
        .post(`/api/v1/admin/jobs/${JOB_NAMES.POLL_PRICES}/run`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

      expect(response.status).toBe(202);
      expect(response.body.data).toMatchObject({ name: JOB_NAMES.POLL_PRICES });
      expect(typeof response.body.data.queuedAt).toBe('string');

      await waitUntil(async () => {
        const count = await getDb().collection('job_runs').countDocuments({ trigger: 'api' });
        return count === 1;
      });

      const run = await getDb().collection('job_runs').findOne({ trigger: 'api' });
      expect(run?.jobName).toBe(JOB_NAMES.POLL_PRICES);
    } finally {
      await worker.stop();
    }
  });

  it('disable then enable round-trips the recurring job state, and a disabled job cannot be triggered', async () => {
    await seedAdminUser();
    // `agenda.disable({name})` solo actualiza un documento recurrente
    // EXISTENTE — en producción siempre existe porque el worker ya llamó a
    // `registerRecurringJobs()` al arrancar. Acá se simula ese registro
    // previo con un worker real de corta vida.
    const bootstrapAgenda = createAgenda({ db: getDb(), role: 'worker' });
    await registerRecurringJobs(bootstrapAgenda, getDb());

    const app = createAppWithFakeAuth();

    const disableResponse = await request(app)
      .post(`/api/v1/admin/jobs/${JOB_NAMES.POLL_PRICES}/disable`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(disableResponse.status).toBe(200);
    expect(disableResponse.body.data.disabled).toBe(true);

    const runResponse = await request(app)
      .post(`/api/v1/admin/jobs/${JOB_NAMES.POLL_PRICES}/run`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(runResponse.status).toBe(409);

    const enableResponse = await request(app)
      .post(`/api/v1/admin/jobs/${JOB_NAMES.POLL_PRICES}/enable`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(enableResponse.status).toBe(200);
    expect(enableResponse.body.data.disabled).toBe(false);
  });

  it('rate-limits repeated triggers of the same job within 30 seconds', async () => {
    await seedAdminUser();
    const app = createAppWithFakeAuth();

    const first = await request(app)
      .post(`/api/v1/admin/jobs/${JOB_NAMES.POLL_PRICES}/run`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(first.status).toBe(202);

    const second = await request(app)
      .post(`/api/v1/admin/jobs/${JOB_NAMES.POLL_PRICES}/run`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(second.status).toBe(429);
  });
});

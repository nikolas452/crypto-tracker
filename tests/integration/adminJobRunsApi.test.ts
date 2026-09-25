import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import { createApp } from '../../src/app.js';
import { JobRunModel } from '../../src/modules/job-runs/job-runs.model.js';
import { UserModel } from '../../src/modules/users/users.model.js';
import { createFakeTokenVerifier } from '../../src/integrations/firebase/fakeTokenVerifier.js';
import { ensureCollections } from '../../src/db/ensureCollections.js';
import { clearDatabase, startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';

const silentLogger = pino({ level: 'silent' });

const ADMIN_TOKEN = 'admin-token';
const USER_TOKEN = 'user-token';
const ADMIN_IDENTITY = {
  uid: 'admin-uid',
  email: 'admin@example.com',
  emailVerified: true,
  name: null,
};
const USER_IDENTITY = {
  uid: 'plain-user-uid',
  email: 'plain-user@example.com',
  emailVerified: true,
  name: null,
};

/** `createApp` con un `FakeTokenVerifier` que conoce a un admin y a un usuario `user` (specs role-authorization / auth-middleware). */
function createAppWithFakeAuth() {
  return createApp({
    tokenVerifier: createFakeTokenVerifier({
      identities: {
        [ADMIN_TOKEN]: ADMIN_IDENTITY,
        [USER_TOKEN]: USER_IDENTITY,
      },
    }),
  });
}

/** Pre-aprovisiona el perfil de Mongo del admin con `role: 'admin'` antes del primer request autenticado. */
async function seedAdminUser() {
  await UserModel.create({
    firebaseUid: ADMIN_IDENTITY.uid,
    email: ADMIN_IDENTITY.email,
    emailVerified: ADMIN_IDENTITY.emailVerified,
    displayName: null,
    role: 'admin',
    lastSeenAt: new Date(),
  });
}

const EMPTY_STATS = {
  coinsRequested: 0,
  coinsReturned: 0,
  snapshotsInserted: 0,
  skippedUnchanged: 0,
  missingCoins: [],
  upstreamAttempts: 0,
  latestUpdated: 0,
};

async function createJobRun(overrides: {
  jobName?: string;
  status?: 'running' | 'success' | 'partial' | 'failed' | 'skipped';
  startedAt: Date;
}) {
  return JobRunModel.create({
    jobName: overrides.jobName ?? 'poll-prices',
    trigger: 'schedule',
    status: overrides.status ?? 'success',
    startedAt: overrides.startedAt,
    finishedAt: overrides.startedAt,
    durationMs: 0,
    stats: EMPTY_STATS,
    error: null,
    workerId: 'test-worker',
  });
}

/**
 * Tests de integración de los endpoints admin de job-runs (`/api/v1/admin/job-runs`),
 * protegidos por `requireAuth({ checkRevoked: true })` + `requireRole('admin')`
 * (spec role-authorization) desde que se retiró `requireAdminKey` (auth-firebase,
 * tarea 6.2/6.3).
 */
describe('admin job-runs API (integration)', () => {
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

  describe('as an authenticated admin', () => {
    it('returns the paginated list', async () => {
      await seedAdminUser();
      const now = new Date();
      await createJobRun({ startedAt: new Date(now.getTime() - 1000) });
      await createJobRun({ startedAt: now });

      const app = createAppWithFakeAuth();
      const response = await request(app)
        .get('/api/v1/admin/job-runs')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(2);
      expect(response.body.meta).toEqual({ page: 1, limit: 20, total: 2, totalPages: 1 });
      // startedAt descendente.
      expect(new Date(response.body.data[0].startedAt).getTime()).toBe(now.getTime());
    });

    it('filters by a comma-separated status list', async () => {
      await seedAdminUser();
      await createJobRun({ startedAt: new Date(), status: 'failed' });
      await createJobRun({ startedAt: new Date(), status: 'partial' });
      await createJobRun({ startedAt: new Date(), status: 'success' });

      const app = createAppWithFakeAuth();
      const response = await request(app)
        .get('/api/v1/admin/job-runs?status=failed,partial')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

      expect(response.status).toBe(200);
      const statuses = response.body.data.map((run: { status: string }) => run.status).sort();
      expect(statuses).toEqual(['failed', 'partial']);
    });

    it('rejects a limit above 100 with a 400 VALIDATION_ERROR', async () => {
      await seedAdminUser();
      const app = createAppWithFakeAuth();
      const response = await request(app)
        .get('/api/v1/admin/job-runs?limit=101')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    describe('GET /api/v1/admin/job-runs/:id', () => {
      it('returns the full document without __v for a known id', async () => {
        await seedAdminUser();
        const run = await createJobRun({ startedAt: new Date() });

        const app = createAppWithFakeAuth();
        const response = await request(app)
          .get(`/api/v1/admin/job-runs/${run._id.toString()}`)
          .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

        expect(response.status).toBe(200);
        expect(response.body.data.id).toBe(run._id.toString());
        expect(response.body.data).not.toHaveProperty('__v');
      });

      it('returns 400 VALIDATION_ERROR for a malformed id', async () => {
        await seedAdminUser();
        const app = createAppWithFakeAuth();
        const response = await request(app)
          .get('/api/v1/admin/job-runs/not-an-object-id')
          .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      });

      it('returns 404 NOT_FOUND for an unknown id', async () => {
        await seedAdminUser();
        const app = createAppWithFakeAuth();
        const response = await request(app)
          .get('/api/v1/admin/job-runs/507f1f77bcf86cd799439011')
          .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe('NOT_FOUND');
      });
    });
  });

  // E3-9 (rol `user` -> 403; rol `admin` -> 200, ya cubierto arriba).
  it('E3-9: rejects an authenticated non-admin user with 403 FORBIDDEN', async () => {
    const app = createAppWithFakeAuth();
    const response = await request(app)
      .get('/api/v1/admin/job-runs')
      .set('Authorization', `Bearer ${USER_TOKEN}`);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  // E3-10: el viejo header X-Admin-Key, sin token, ya no funciona.
  it('E3-10: rejects the retired X-Admin-Key header with no token with 401 UNAUTHENTICATED', async () => {
    const app = createAppWithFakeAuth();
    const response = await request(app)
      .get('/api/v1/admin/job-runs')
      .set('X-Admin-Key', 'a'.repeat(32));

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a request with no Authorization header with 401 UNAUTHENTICATED', async () => {
    const app = createAppWithFakeAuth();
    const response = await request(app).get('/api/v1/admin/job-runs');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });
});

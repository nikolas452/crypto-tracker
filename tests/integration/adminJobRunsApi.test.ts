import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import { createApp } from '../../src/app.js';
import { JobRunModel } from '../../src/modules/job-runs/job-runs.model.js';
import { ensureCollections } from '../../src/db/ensureCollections.js';
import { clearDatabase, startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';

const silentLogger = pino({ level: 'silent' });
const ADMIN_KEY = 'a'.repeat(32);

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

/** Tests de integración de los endpoints admin de job-runs (`/api/v1/admin/job-runs`). */

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

  describe('when ADMIN_API_KEY is configured', () => {
    // E2-13 (parte 1): sin header -> 401 UNAUTHENTICATED.
    it('E2-13: rejects a request without X-Admin-Key with 401 UNAUTHENTICATED', async () => {
      const app = createApp({ adminApiKey: ADMIN_KEY });
      const response = await request(app).get('/api/v1/admin/job-runs');

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('rejects a request with a wrong X-Admin-Key with 401 UNAUTHENTICATED', async () => {
      const app = createApp({ adminApiKey: ADMIN_KEY });
      const response = await request(app)
        .get('/api/v1/admin/job-runs')
        .set('X-Admin-Key', 'b'.repeat(32));

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('UNAUTHENTICATED');
    });

    // E2-13 (parte 2): clave correcta -> lista paginada.
    it('E2-13: returns the paginated list with the correct X-Admin-Key', async () => {
      const now = new Date();
      await createJobRun({ startedAt: new Date(now.getTime() - 1000) });
      await createJobRun({ startedAt: now });

      const app = createApp({ adminApiKey: ADMIN_KEY });
      const response = await request(app)
        .get('/api/v1/admin/job-runs')
        .set('X-Admin-Key', ADMIN_KEY);

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(2);
      expect(response.body.meta).toEqual({ page: 1, limit: 20, total: 2, totalPages: 1 });
      // startedAt descendente.
      expect(new Date(response.body.data[0].startedAt).getTime()).toBe(now.getTime());
    });

    it('filters by a comma-separated status list', async () => {
      await createJobRun({ startedAt: new Date(), status: 'failed' });
      await createJobRun({ startedAt: new Date(), status: 'partial' });
      await createJobRun({ startedAt: new Date(), status: 'success' });

      const app = createApp({ adminApiKey: ADMIN_KEY });
      const response = await request(app)
        .get('/api/v1/admin/job-runs?status=failed,partial')
        .set('X-Admin-Key', ADMIN_KEY);

      expect(response.status).toBe(200);
      const statuses = response.body.data.map((run: { status: string }) => run.status).sort();
      expect(statuses).toEqual(['failed', 'partial']);
    });

    it('rejects a limit above 100 with a 400 VALIDATION_ERROR', async () => {
      const app = createApp({ adminApiKey: ADMIN_KEY });
      const response = await request(app)
        .get('/api/v1/admin/job-runs?limit=101')
        .set('X-Admin-Key', ADMIN_KEY);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    describe('GET /api/v1/admin/job-runs/:id', () => {
      it('returns the full document without __v for a known id', async () => {
        const run = await createJobRun({ startedAt: new Date() });

        const app = createApp({ adminApiKey: ADMIN_KEY });
        const response = await request(app)
          .get(`/api/v1/admin/job-runs/${run._id.toString()}`)
          .set('X-Admin-Key', ADMIN_KEY);

        expect(response.status).toBe(200);
        expect(response.body.data.id).toBe(run._id.toString());
        expect(response.body.data).not.toHaveProperty('__v');
      });

      it('returns 400 VALIDATION_ERROR for a malformed id', async () => {
        const app = createApp({ adminApiKey: ADMIN_KEY });
        const response = await request(app)
          .get('/api/v1/admin/job-runs/not-an-object-id')
          .set('X-Admin-Key', ADMIN_KEY);

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      });

      it('returns 404 NOT_FOUND for an unknown id', async () => {
        const app = createApp({ adminApiKey: ADMIN_KEY });
        const response = await request(app)
          .get('/api/v1/admin/job-runs/507f1f77bcf86cd799439011')
          .set('X-Admin-Key', ADMIN_KEY);

        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe('NOT_FOUND');
      });
    });
  });

  describe('when ADMIN_API_KEY is unset', () => {
    // E2-14: toda ruta admin devuelve 404, indistinguible de una ruta que
    // no existe, incluso con un header de clave adjunto.
    it.each([
      [
        'GET /api/v1/admin/job-runs',
        () => request(createApp({ adminApiKey: undefined })).get('/api/v1/admin/job-runs'),
      ],
      [
        'GET /api/v1/admin/job-runs/:id',
        () =>
          request(createApp({ adminApiKey: undefined })).get(
            '/api/v1/admin/job-runs/507f1f77bcf86cd799439011',
          ),
      ],
    ])('E2-14: %s returns 404 NOT_FOUND', async (_label, makeRequest) => {
      const response = await makeRequest().set('X-Admin-Key', ADMIN_KEY);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });
  });
});

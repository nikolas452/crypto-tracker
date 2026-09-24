import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import { createApp } from '../../src/app.js';
import { CoinModel } from '../../src/modules/coins/coins.model.js';
import { JobRunModel } from '../../src/modules/job-runs/job-runs.model.js';
import { ensureCollections } from '../../src/db/ensureCollections.js';
import { clearDatabase, startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';

const silentLogger = pino({ level: 'silent' });

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
  status: 'running' | 'success' | 'partial' | 'failed' | 'skipped';
  startedAt: Date;
  finishedAt: Date | null;
  error?: { code: string; message: string } | null;
}) {
  return JobRunModel.create({
    jobName: 'poll-prices',
    trigger: 'schedule',
    status: overrides.status,
    startedAt: overrides.startedAt,
    finishedAt: overrides.finishedAt,
    durationMs: overrides.finishedAt
      ? overrides.finishedAt.getTime() - overrides.startedAt.getTime()
      : null,
    stats: EMPTY_STATS,
    error: overrides.error ?? null,
    workerId: 'test-worker',
  });
}

/** Tests de integración del endpoint `GET /api/v1/status`. */

describe('status API (integration)', () => {
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

  describe('GET /api/v1/status', () => {
    it('is readable without credentials and reports activeCoins', async () => {
      await CoinModel.create({
        coingeckoId: 'bitcoin',
        symbol: 'btc',
        name: 'Bitcoin',
        isActive: true,
      });
      await CoinModel.create({
        coingeckoId: 'delisted',
        symbol: 'del',
        name: 'Delisted',
        isActive: false,
      });

      const app = createApp();
      const response = await request(app).get('/api/v1/status');

      expect(response.status).toBe(200);
      expect(response.body.data.activeCoins).toBe(1);
    });

    // E2-12: un último éxito hace 45 minutos con el umbral por defecto de 30
    // minutos (STALE_POLL_THRESHOLD_MIN) da stale: true.
    it('E2-12: a last success 45 minutes ago reports stale: true', async () => {
      const now = new Date();
      const startedAt = new Date(now.getTime() - 46 * 60_000);
      const finishedAt = new Date(now.getTime() - 45 * 60_000);
      await createJobRun({ status: 'success', startedAt, finishedAt });

      const app = createApp();
      const response = await request(app).get('/api/v1/status');

      expect(response.status).toBe(200);
      expect(response.body.data.pollPrices.stale).toBe(true);
      expect(response.body.data.pollPrices.lastRunStatus).toBe('success');
      expect(new Date(response.body.data.pollPrices.lastSuccessAt).getTime()).toBe(
        finishedAt.getTime(),
      );
    });

    it('reports stale: true and null timestamps when no run has ever been recorded', async () => {
      const app = createApp();
      const response = await request(app).get('/api/v1/status');

      expect(response.status).toBe(200);
      expect(response.body.data.pollPrices).toEqual({
        lastSuccessAt: null,
        lastRunAt: null,
        lastRunStatus: null,
        stale: true,
      });
    });

    it('reports stale: false for a recent successful run', async () => {
      const now = new Date();
      const startedAt = new Date(now.getTime() - 6 * 60_000);
      const finishedAt = new Date(now.getTime() - 5 * 60_000);
      await createJobRun({ status: 'success', startedAt, finishedAt });

      const app = createApp();
      const response = await request(app).get('/api/v1/status');

      expect(response.status).toBe(200);
      expect(response.body.data.pollPrices.stale).toBe(false);
    });

    it('a partial run counts as a success for liveness', async () => {
      const now = new Date();
      const startedAt = new Date(now.getTime() - 6 * 60_000);
      const finishedAt = new Date(now.getTime() - 5 * 60_000);
      await createJobRun({ status: 'partial', startedAt, finishedAt });

      const app = createApp();
      const response = await request(app).get('/api/v1/status');

      expect(response.status).toBe(200);
      expect(response.body.data.pollPrices.stale).toBe(false);
      expect(response.body.data.pollPrices.lastRunStatus).toBe('partial');
      expect(new Date(response.body.data.pollPrices.lastSuccessAt).getTime()).toBe(
        finishedAt.getTime(),
      );
    });

    it('never leaks an error message, code or worker identifier for a failed last run', async () => {
      const now = new Date();
      const startedAt = new Date(now.getTime() - 6 * 60_000);
      const finishedAt = new Date(now.getTime() - 5 * 60_000);
      await createJobRun({
        status: 'failed',
        startedAt,
        finishedAt,
        error: { code: 'UPSTREAM_ERROR', message: 'CoinGecko timed out' },
      });

      const app = createApp();
      const response = await request(app).get('/api/v1/status');

      expect(response.status).toBe(200);
      expect(response.body.data.pollPrices.lastRunStatus).toBe('failed');
      // Nunca se registró un éxito, así que sigue stale y sin lastSuccessAt.
      expect(response.body.data.pollPrices.stale).toBe(true);
      expect(response.body.data.pollPrices.lastSuccessAt).toBeNull();

      const raw = JSON.stringify(response.body);
      expect(raw).not.toContain('UPSTREAM_ERROR');
      expect(raw).not.toContain('CoinGecko timed out');
      expect(raw).not.toContain('test-worker');
      expect(raw).not.toContain('workerId');
      expect(raw).not.toContain('error');
    });
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import type { Types } from 'mongoose';
import { createApp } from '../../src/app.js';
import { CoinModel } from '../../src/modules/coins/coins.model.js';
import { PriceSnapshotModel } from '../../src/modules/snapshots/snapshots.model.js';
import { ensureCollections } from '../../src/db/ensureCollections.js';
import { clearDatabase, startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';

const silentLogger = pino({ level: 'silent' });

async function createActiveCoin(coingeckoId = 'bitcoin') {
  return CoinModel.create({ coingeckoId, symbol: 'btc', name: 'Bitcoin', isActive: true });
}

async function insertSnapshot(
  coinId: Types.ObjectId,
  coingeckoId: string,
  timestamp: Date,
  priceUsd: number,
) {
  return PriceSnapshotModel.create({
    timestamp,
    meta: { coinId, coingeckoId },
    priceUsd,
    marketCapUsd: null,
    volume24hUsd: null,
    change24hPct: null,
    sourceUpdatedAt: null,
  });
}

/** Tests de integración del endpoint `GET /api/v1/coins/:coingeckoId/history`. */

describe('price history API (integration)', () => {
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

  describe('GET /api/v1/coins/:coingeckoId/history', () => {
    it('returns 404 for an unknown coin', async () => {
      const app = createApp();
      const response = await request(app).get('/api/v1/coins/no-existe/history');

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 404 for a deactivated coin', async () => {
      await CoinModel.create({
        coingeckoId: 'delisted',
        symbol: 'del',
        name: 'Delisted',
        isActive: false,
      });

      const app = createApp();
      const response = await request(app).get('/api/v1/coins/delisted/history');

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 200 with points: [] for an active coin with no data in range', async () => {
      await createActiveCoin();

      const app = createApp();
      const response = await request(app).get(
        '/api/v1/coins/bitcoin/history?from=2026-01-01T00:00:00Z&to=2026-01-01T01:00:00Z',
      );

      expect(response.status).toBe(200);
      expect(response.body.data.points).toEqual([]);
      expect(response.body.data.coingeckoId).toBe('bitcoin');
    });

    it('rejects a datetime without a timezone', async () => {
      await createActiveCoin();
      const app = createApp();
      const response = await request(app).get(
        '/api/v1/coins/bitcoin/history?from=2026-01-01T00:00&to=2026-01-02T00:00',
      );

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    // E2-7: tres horas conocidas producen tres buckets OHLC exactos, calculados a mano.
    it('E2-7: three hours of known snapshots produce three exact buckets', async () => {
      const coin = await createActiveCoin();

      // Bucket 1 (00:00-00:59): 100, 105, 95 -> open 100, high 105, low 95, close 95, avg 100, samples 3
      await insertSnapshot(coin._id, 'bitcoin', new Date('2026-01-01T00:00:00.000Z'), 100);
      await insertSnapshot(coin._id, 'bitcoin', new Date('2026-01-01T00:20:00.000Z'), 105);
      await insertSnapshot(coin._id, 'bitcoin', new Date('2026-01-01T00:40:00.000Z'), 95);
      // Bucket 2 (01:00-01:59): muestra única -> open=high=low=close=200
      await insertSnapshot(coin._id, 'bitcoin', new Date('2026-01-01T01:15:00.000Z'), 200);
      // Bucket 3 (02:00-02:59): 50, 60 -> open 50, high 60, low 50, close 60, avg 55, samples 2
      await insertSnapshot(coin._id, 'bitcoin', new Date('2026-01-01T02:10:00.000Z'), 50);
      await insertSnapshot(coin._id, 'bitcoin', new Date('2026-01-01T02:50:00.000Z'), 60);

      const app = createApp();
      const response = await request(app).get(
        '/api/v1/coins/bitcoin/history?interval=1h&from=2026-01-01T00:00:00Z&to=2026-01-01T03:00:00Z',
      );

      expect(response.status).toBe(200);
      expect(response.body.data.interval).toBe('1h');
      expect(response.body.data.points).toHaveLength(3);

      const [bucket1, bucket2, bucket3] = response.body.data.points;
      expect(bucket1).toMatchObject({
        open: 100,
        high: 105,
        low: 95,
        close: 95,
        avg: 100,
        samples: 3,
      });
      // 6.10: un bucket con una sola muestra colapsa open=high=low=close.
      expect(bucket2).toMatchObject({
        open: 200,
        high: 200,
        low: 200,
        close: 200,
        avg: 200,
        samples: 1,
      });
      expect(bucket3).toMatchObject({
        open: 50,
        high: 60,
        low: 50,
        close: 60,
        avg: 55,
        samples: 2,
      });
    });

    // 6.10: los buckets vacíos se omiten, no se rellenan con un placeholder.
    it('omits hours with no snapshots rather than filling them', async () => {
      const coin = await createActiveCoin();

      await insertSnapshot(coin._id, 'bitcoin', new Date('2026-01-01T00:10:00.000Z'), 100);
      // 01:00-01:59 no tiene snapshots.
      await insertSnapshot(coin._id, 'bitcoin', new Date('2026-01-01T02:10:00.000Z'), 200);

      const app = createApp();
      const response = await request(app).get(
        '/api/v1/coins/bitcoin/history?interval=1h&from=2026-01-01T00:00:00Z&to=2026-01-01T03:00:00Z',
      );

      expect(response.status).toBe(200);
      expect(response.body.data.points).toHaveLength(2);
      const hours = response.body.data.points.map((point: { t: string }) =>
        new Date(point.t).getUTCHours(),
      );
      expect(hours).toEqual([0, 2]);
    });

    // E2-8: raw sobre un rango de 10 días es rechazado con un mensaje que sugiere 1h.
    it('E2-8: raw over a 10-day range returns 400 suggesting 1h', async () => {
      await createActiveCoin();

      const app = createApp();
      const response = await request(app).get(
        '/api/v1/coins/bitcoin/history?interval=raw&from=2026-01-01T00:00:00Z&to=2026-01-11T00:00:00Z',
      );

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.message).toMatch(/1h/);
    });

    // E2-9: un rango de 20 días sin interval indicado auto-selecciona 1h.
    it('E2-9: a 20-day range with no interval selects 1h', async () => {
      await createActiveCoin();

      const app = createApp();
      const response = await request(app).get(
        '/api/v1/coins/bitcoin/history?from=2026-01-01T00:00:00Z&to=2026-01-21T00:00:00Z',
      );

      expect(response.status).toBe(200);
      expect(response.body.data.interval).toBe('1h');
    });

    // E2-10: el warm-up con sma=3 anula los dos primeros buckets y luego la media exacta.
    it('E2-10: sma=3 warm-up nulls then the exact moving average', async () => {
      const coin = await createActiveCoin();

      await insertSnapshot(coin._id, 'bitcoin', new Date('2026-01-01T00:00:00.000Z'), 10);
      await insertSnapshot(coin._id, 'bitcoin', new Date('2026-01-01T01:00:00.000Z'), 20);
      await insertSnapshot(coin._id, 'bitcoin', new Date('2026-01-01T02:00:00.000Z'), 30);

      const app = createApp();
      const response = await request(app).get(
        '/api/v1/coins/bitcoin/history?interval=1h&sma=3&from=2026-01-01T00:00:00Z&to=2026-01-01T03:00:00Z',
      );

      expect(response.status).toBe(200);
      const smaValues = response.body.data.points.map((point: { sma: number | null }) => point.sma);
      expect(smaValues).toEqual([null, null, 20]);
    });

    // 6.10: un sma mayor que la cantidad de buckets da todo null, sin error.
    it('a window larger than the series yields only nulls', async () => {
      const coin = await createActiveCoin();

      await insertSnapshot(coin._id, 'bitcoin', new Date('2026-01-01T00:00:00.000Z'), 10);
      await insertSnapshot(coin._id, 'bitcoin', new Date('2026-01-01T01:00:00.000Z'), 20);

      const app = createApp();
      const response = await request(app).get(
        '/api/v1/coins/bitcoin/history?interval=1h&sma=10&from=2026-01-01T00:00:00Z&to=2026-01-01T03:00:00Z',
      );

      expect(response.status).toBe(200);
      const smaValues = response.body.data.points.map((point: { sma: number | null }) => point.sma);
      expect(smaValues).toEqual([null, null]);
    });

    it('rejects sma together with interval=raw', async () => {
      await createActiveCoin();

      const app = createApp();
      const response = await request(app).get(
        '/api/v1/coins/bitcoin/history?interval=raw&sma=5&from=2026-01-01T00:00:00Z&to=2026-01-01T12:00:00Z',
      );

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns raw points with the projected fields, ascending', async () => {
      const coin = await createActiveCoin();
      await insertSnapshot(coin._id, 'bitcoin', new Date('2026-01-01T00:30:00.000Z'), 200);
      await insertSnapshot(coin._id, 'bitcoin', new Date('2026-01-01T00:10:00.000Z'), 100);

      const app = createApp();
      const response = await request(app).get(
        '/api/v1/coins/bitcoin/history?interval=raw&from=2026-01-01T00:00:00Z&to=2026-01-01T01:00:00Z',
      );

      expect(response.status).toBe(200);
      expect(response.body.data.points).toHaveLength(2);
      expect(response.body.data.points[0]).toMatchObject({ priceUsd: 100 });
      expect(response.body.data.points[1]).toMatchObject({ priceUsd: 200 });
    });

    it('rejects raw over the 2000-point cap with a 400 suggesting 1h', async () => {
      const coin = await createActiveCoin();
      const docs = Array.from({ length: 2001 }, (_, i) => ({
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
        meta: { coinId: coin._id, coingeckoId: 'bitcoin' },
        priceUsd: 100 + i,
        marketCapUsd: null,
        volume24hUsd: null,
        change24hPct: null,
        sourceUpdatedAt: null,
      }));
      await PriceSnapshotModel.insertMany(docs, { ordered: false });

      const app = createApp();
      const response = await request(app).get(
        '/api/v1/coins/bitcoin/history?interval=raw&from=2026-01-01T00:00:00Z&to=2026-01-01T01:00:00Z',
      );

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.message).toMatch(/1h/);
    }, 20000);
  });
});

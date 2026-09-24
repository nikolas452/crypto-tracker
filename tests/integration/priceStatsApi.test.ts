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

/** Tests de integración del endpoint `GET /api/v1/coins/:coingeckoId/stats`. */

describe('price stats API (integration)', () => {
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

  describe('GET /api/v1/coins/:coingeckoId/stats', () => {
    // E2-11: las stats de una coin desconocida devuelven 404.
    it('E2-11: returns 404 NOT_FOUND for an unknown coin', async () => {
      const app = createApp();
      const response = await request(app).get('/api/v1/coins/no-existe/stats');

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
      const response = await request(app).get('/api/v1/coins/delisted/stats');

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('rejects an unknown range value', async () => {
      await createActiveCoin();
      const app = createApp();
      const response = await request(app).get('/api/v1/coins/bitcoin/stats?range=1y');

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    // E2-11: aserción de estadísticas calculadas a mano sobre un conjunto conocido de snapshots.
    it('E2-11: statistics match hand-computed values', async () => {
      const coin = await createActiveCoin();
      const now = new Date();
      const within = (msAgo: number) => new Date(now.getTime() - msAgo);

      // open=100 (primero), close=130 (último), min=90, max=130, avg=(100+90+130)/3=106.6667, samples=3
      await insertSnapshot(coin._id, 'bitcoin', within(3 * 60 * 60 * 1000), 100);
      await insertSnapshot(coin._id, 'bitcoin', within(2 * 60 * 60 * 1000), 90);
      await insertSnapshot(coin._id, 'bitcoin', within(1 * 60 * 60 * 1000), 130);

      const app = createApp();
      const response = await request(app).get('/api/v1/coins/bitcoin/stats?range=24h');

      expect(response.status).toBe(200);
      expect(response.body.data.range).toBe('24h');
      expect(response.body.data.open).toBe(100);
      expect(response.body.data.close).toBe(130);
      expect(response.body.data.min).toBe(90);
      expect(response.body.data.max).toBe(130);
      expect(response.body.data.samples).toBe(3);
      expect(response.body.data.avg).toBeCloseTo(106.6667, 3);
      // changePct = (130 - 100) / 100 * 100 = 30
      expect(response.body.data.changePct).toBe(30);
    });

    // spec price-stats-api: forma de la respuesta para un rango vacío.
    it('E2-11: an empty range returns 200 with samples: 0 and every field null', async () => {
      await createActiveCoin();

      const app = createApp();
      const response = await request(app).get('/api/v1/coins/bitcoin/stats?range=24h');

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        samples: 0,
        open: null,
        close: null,
        changePct: null,
        min: null,
        max: null,
        avg: null,
        firstAt: null,
        lastAt: null,
      });
    });

    it('defaults range to 24h when omitted', async () => {
      await createActiveCoin();
      const app = createApp();
      const response = await request(app).get('/api/v1/coins/bitcoin/stats');

      expect(response.status).toBe(200);
      expect(response.body.data.range).toBe('24h');
    });

    it('excludes snapshots outside the requested range', async () => {
      const coin = await createActiveCoin();
      const now = new Date();

      // Fuera de un rango de 24h.
      await insertSnapshot(coin._id, 'bitcoin', new Date(now.getTime() - 48 * 60 * 60 * 1000), 999);
      // Dentro de un rango de 24h.
      await insertSnapshot(coin._id, 'bitcoin', new Date(now.getTime() - 1 * 60 * 60 * 1000), 100);

      const app = createApp();
      const response = await request(app).get('/api/v1/coins/bitcoin/stats?range=24h');

      expect(response.status).toBe(200);
      expect(response.body.data.samples).toBe(1);
      expect(response.body.data.open).toBe(100);
    });
  });
});

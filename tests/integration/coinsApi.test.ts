import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import { createApp } from '../../src/app.js';
import { CoinModel } from '../../src/modules/coins/coins.model.js';
import { ensureCollections } from '../../src/db/ensureCollections.js';
import { clearDatabase, startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';

const silentLogger = pino({ level: 'silent' });

/**
 * Tests de integración de los endpoints de lectura de coins
 * (`GET /api/v1/coins` y `GET /api/v1/coins/:coingeckoId`).
 */

interface ExplainStageNode {
  stage?: string;
  inputStage?: ExplainStageNode;
  inputStages?: ExplainStageNode[];
  shards?: { winningPlan?: ExplainStageNode }[];
}

/** Aplana un árbol winningPlan de explain() en la lista de nombres `stage` que contiene. */
function collectStages(plan: ExplainStageNode | undefined): string[] {
  if (!plan) return [];
  const stages: string[] = [];
  if (plan.stage) stages.push(plan.stage);
  if (plan.inputStage) stages.push(...collectStages(plan.inputStage));
  if (plan.inputStages) plan.inputStages.forEach((stage) => stages.push(...collectStages(stage)));
  if (plan.shards) plan.shards.forEach((shard) => stages.push(...collectStages(shard.winningPlan)));
  return stages;
}

async function createCoin(input: {
  coingeckoId: string;
  symbol: string;
  name: string;
  isActive?: boolean;
  latest?: {
    priceUsd: number;
    marketCapUsd?: number | null;
    volume24hUsd?: number | null;
    change24hPct?: number | null;
    capturedAt: Date;
  } | null;
}) {
  return CoinModel.create({
    coingeckoId: input.coingeckoId,
    symbol: input.symbol,
    name: input.name,
    isActive: input.isActive ?? true,
    latest: input.latest ?? null,
  });
}

describe('coin read API (integration)', () => {
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

  describe('GET /api/v1/coins', () => {
    // E2-1: paginación por offset sobre una última página parcialmente llena.
    it('E2-1: returns the requested page with the correct pagination meta', async () => {
      for (let i = 0; i < 12; i += 1) {
        await createCoin({ coingeckoId: `coin-${i}`, symbol: `c${i}`, name: `Coin ${i}` });
      }

      const app = createApp();
      const response = await request(app).get('/api/v1/coins?limit=5&page=3');

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(2);
      expect(response.body.meta).toEqual({ page: 3, limit: 5, total: 12, totalPages: 3 });
    });

    it('excludes inactive coins', async () => {
      await createCoin({ coingeckoId: 'bitcoin', symbol: 'btc', name: 'Bitcoin' });
      await createCoin({
        coingeckoId: 'delisted',
        symbol: 'del',
        name: 'Delisted',
        isActive: false,
      });

      const app = createApp();
      const response = await request(app).get('/api/v1/coins');

      const ids = response.body.data.map((item: { coingeckoId: string }) => item.coingeckoId);
      expect(ids).toContain('bitcoin');
      expect(ids).not.toContain('delisted');
    });

    // E2-2: q=BIT matchea sin distinguir mayúsculas/minúsculas vía nameLower / prefijo de symbol.
    it('E2-2: q=BIT matches coins by name or symbol prefix, case-insensitively', async () => {
      await createCoin({ coingeckoId: 'bitcoin', symbol: 'btc', name: 'Bitcoin' });
      await createCoin({ coingeckoId: 'bittensor', symbol: 'tao', name: 'Bittensor' });
      await createCoin({ coingeckoId: 'some-coin', symbol: 'bit', name: 'Some Coin' });
      await createCoin({ coingeckoId: 'ethereum', symbol: 'eth', name: 'Ethereum' });

      const app = createApp();
      const response = await request(app).get('/api/v1/coins?q=BIT');

      const ids = response.body.data.map((item: { coingeckoId: string }) => item.coingeckoId);
      expect(ids.sort()).toEqual(['bitcoin', 'bittensor', 'some-coin']);
      expect(ids).not.toContain('ethereum');
    });

    it('matches q literally, without treating it as a regex', async () => {
      await createCoin({ coingeckoId: 'bitcoin', symbol: 'btc', name: 'Bitcoin' });

      const app = createApp();
      const response = await request(app).get('/api/v1/coins?q=' + encodeURIComponent('.*'));

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(0);
    });

    // E2-3: el orden ascendente por cambio 24h deja las coins sin polling al final.
    it('E2-3: sort=change24h&order=asc orders by change24hPct ascending, unpolled coins last', async () => {
      const now = new Date('2026-01-01T00:00:00.000Z');
      await createCoin({
        coingeckoId: 'gainer',
        symbol: 'gnr',
        name: 'Gainer',
        latest: { priceUsd: 1, change24hPct: 10, capturedAt: now },
      });
      await createCoin({
        coingeckoId: 'loser',
        symbol: 'lsr',
        name: 'Loser',
        latest: { priceUsd: 1, change24hPct: -5, capturedAt: now },
      });
      await createCoin({ coingeckoId: 'unpolled', symbol: 'unp', name: 'Unpolled' });

      const app = createApp();
      const response = await request(app).get('/api/v1/coins?sort=change24h&order=asc');

      const ids = response.body.data.map((item: { coingeckoId: string }) => item.coingeckoId);
      expect(ids).toEqual(['loser', 'gainer', 'unpolled']);
    });

    // E2-4: un parámetro de query desconocido es rechazado por el schema estricto.
    it('E2-4: an unknown query parameter is a 400 VALIDATION_ERROR', async () => {
      const app = createApp();
      const response = await request(app).get('/api/v1/coins?foo=1');

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects an invalid limit with a 400 naming the offending parameter', async () => {
      const app = createApp();
      const response = await request(app).get('/api/v1/coins?limit=0');

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(
        response.body.error.details.some((detail: { path: string }) =>
          detail.path.includes('limit'),
        ),
      ).toBe(true);
    });

    it('never exposes _id or __v on a list item', async () => {
      await createCoin({ coingeckoId: 'bitcoin', symbol: 'btc', name: 'Bitcoin' });

      const app = createApp();
      const response = await request(app).get('/api/v1/coins');

      expect(response.body.data[0]).not.toHaveProperty('_id');
      expect(response.body.data[0]).not.toHaveProperty('__v');
    });

    // E2-16: revalidar con el ETag recibido previamente devuelve 304
    // sin body (spec http-caching).
    it('E2-16: repeating the request with the received ETag as If-None-Match returns 304 with no body', async () => {
      await createCoin({ coingeckoId: 'bitcoin', symbol: 'btc', name: 'Bitcoin' });

      const app = createApp();
      const first = await request(app).get('/api/v1/coins');
      const etag: string | undefined = first.headers.etag;

      expect(first.status).toBe(200);
      expect(etag).toBeDefined();
      expect(first.headers['cache-control']).toBe('public, max-age=60');

      const second = await request(app)
        .get('/api/v1/coins')
        .set('If-None-Match', etag as string);

      expect(second.status).toBe(304);
      expect(second.body).toEqual({});
      expect(second.text).toBe('');
    });

    // RNF-2.2: la query de listado por defecto debe resolverse con un índice,
    // nunca con un collection scan (design.md: "la diferencia entre IXSCAN
    // y COLLSCAN en el endpoint de listado").
    it('RNF-2.2: the default list query plan uses IXSCAN, not COLLSCAN', async () => {
      await createCoin({
        coingeckoId: 'bitcoin',
        symbol: 'btc',
        name: 'Bitcoin',
        latest: { priceUsd: 50000, marketCapUsd: 1, capturedAt: new Date() },
      });

      const explainResult = (await CoinModel.find({ isActive: true })
        .select({ coingeckoId: 1, symbol: 1, name: 1, latest: 1, _id: 0 })
        .sort({ 'latest.marketCapUsd': -1 })
        .limit(20)
        .explain('executionStats')) as unknown as {
        queryPlanner: { winningPlan: ExplainStageNode };
      };

      const stages = collectStages(explainResult.queryPlanner.winningPlan);

      expect(stages).toContain('IXSCAN');
      expect(stages).not.toContain('COLLSCAN');
    });
  });

  describe('GET /api/v1/coins/:coingeckoId', () => {
    it('returns the coin detail with trackedSince derived from createdAt', async () => {
      const coin = await createCoin({
        coingeckoId: 'bitcoin',
        symbol: 'btc',
        name: 'Bitcoin',
        latest: { priceUsd: 50000, capturedAt: new Date('2026-01-01T00:00:00.000Z') },
      });

      const app = createApp();
      const response = await request(app).get('/api/v1/coins/bitcoin');

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        coingeckoId: 'bitcoin',
        symbol: 'btc',
        name: 'Bitcoin',
        latest: { priceUsd: 50000 },
      });
      expect(new Date(response.body.data.trackedSince).getTime()).toBe(coin.createdAt?.getTime());
      expect(response.body.data).not.toHaveProperty('_id');
      expect(response.body.data).not.toHaveProperty('__v');
    });

    // escenario 5.5: una coin desconocida devuelve 404 NOT_FOUND.
    it('returns 404 NOT_FOUND for an unknown coin', async () => {
      const app = createApp();
      const response = await request(app).get('/api/v1/coins/no-existe');

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    // escenario 5.5: una coin desactivada queda oculta en el endpoint de detalle.
    it('returns 404 for a deactivated coin', async () => {
      await createCoin({
        coingeckoId: 'delisted',
        symbol: 'del',
        name: 'Delisted',
        isActive: false,
      });

      const app = createApp();
      const response = await request(app).get('/api/v1/coins/delisted');

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    // escenario 5.5: un coingeckoId malformado es un error de validación, no un 404.
    it('returns 400 VALIDATION_ERROR for a malformed coingeckoId', async () => {
      const app = createApp();
      const response = await request(app).get('/api/v1/coins/Not_Valid!');

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});

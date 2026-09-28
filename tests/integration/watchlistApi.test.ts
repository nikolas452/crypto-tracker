import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import { Types } from 'mongoose';
import { createApp } from '../../src/app.js';
import { CoinModel } from '../../src/modules/coins/coins.model.js';
import { UserModel } from '../../src/modules/users/users.model.js';
import { WatchlistItemModel } from '../../src/modules/watchlist/watchlist.model.js';
import { createFakeTokenVerifier } from '../../src/integrations/firebase/fakeTokenVerifier.js';
import { ensureCollections } from '../../src/db/ensureCollections.js';
import { clearDatabase, startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';

const silentLogger = pino({ level: 'silent' });

/**
 * Tests de integración de los endpoints de watchlist (specs
 * watchlist-read-api / watchlist-write-api / watchlist-store /
 * user-data-isolation): E4-1 a E4-13, contra un Mongo en memoria real y un
 * `FakeTokenVerifier` — nunca un proyecto de Firebase real.
 */

const TOKEN_A = 'user-a-token';
const IDENTITY_A = {
  uid: 'watchlist-uid-a',
  email: 'a@example.com',
  emailVerified: true,
  name: null,
};
const TOKEN_B = 'user-b-token';
const IDENTITY_B = {
  uid: 'watchlist-uid-b',
  email: 'b@example.com',
  emailVerified: true,
  name: null,
};

function createAppWithFakeAuth(overrides: Parameters<typeof createApp>[0] = {}) {
  return createApp({
    logger: silentLogger,
    tokenVerifier: createFakeTokenVerifier({
      identities: { [TOKEN_A]: IDENTITY_A, [TOKEN_B]: IDENTITY_B },
    }),
    ...overrides,
  });
}

async function createCoin(input: {
  coingeckoId: string;
  symbol?: string;
  name?: string;
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
    symbol: input.symbol ?? input.coingeckoId.slice(0, 3),
    name: input.name ?? input.coingeckoId,
    isActive: input.isActive ?? true,
    latest: input.latest ?? null,
  });
}

describe('watchlist API (integration)', () => {
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

  describe('GET /api/v1/me/watchlist', () => {
    it('rejects an unauthenticated request with 401', async () => {
      const app = createAppWithFakeAuth();
      const response = await request(app).get('/api/v1/me/watchlist');
      expect(response.status).toBe(401);
    });

    it('E4-1: an added coin is listed with its latest projection', async () => {
      const app = createAppWithFakeAuth();
      await createCoin({
        coingeckoId: 'bitcoin',
        symbol: 'btc',
        name: 'Bitcoin',
        latest: {
          priceUsd: 64210.12,
          change24hPct: -1.23,
          marketCapUsd: 1_265_000_000_000,
          capturedAt: new Date(),
        },
      });

      const addResponse = await request(app)
        .post('/api/v1/me/watchlist')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ coingeckoId: 'bitcoin' });
      expect(addResponse.status).toBe(201);

      const listResponse = await request(app)
        .get('/api/v1/me/watchlist')
        .set('Authorization', `Bearer ${TOKEN_A}`);

      expect(listResponse.status).toBe(200);
      expect(listResponse.body.data).toHaveLength(1);
      expect(listResponse.body.data[0]).toMatchObject({
        coingeckoId: 'bitcoin',
        symbol: 'btc',
        name: 'Bitcoin',
        isActive: true,
      });
      expect(listResponse.body.data[0].latest.priceUsd).toBe(64210.12);
      expect(listResponse.body.meta).toEqual({ count: 1, max: 50 });
    });

    // RNF-4.3 (tarea 8.3): ninguna respuesta de watchlist contiene userId
    // ni ningún _id interno.
    it('RNF-4.3: the listed item exposes no userId, _id or __v', async () => {
      const app = createAppWithFakeAuth();
      await createCoin({ coingeckoId: 'bitcoin' });
      await request(app)
        .post('/api/v1/me/watchlist')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ coingeckoId: 'bitcoin' });

      const response = await request(app)
        .get('/api/v1/me/watchlist')
        .set('Authorization', `Bearer ${TOKEN_A}`);

      expect(Object.keys(response.body.data[0])).not.toEqual(
        expect.arrayContaining(['userId', '_id', '__v']),
      );
    });

    it('sends Cache-Control: private, no-cache', async () => {
      const app = createAppWithFakeAuth();
      const response = await request(app)
        .get('/api/v1/me/watchlist')
        .set('Authorization', `Bearer ${TOKEN_A}`);

      expect(response.headers['cache-control']).toBe('private, no-cache');
    });

    it('rejects an unknown query parameter with 400 VALIDATION_ERROR', async () => {
      const app = createAppWithFakeAuth();
      const response = await request(app)
        .get('/api/v1/me/watchlist?page=1')
        .set('Authorization', `Bearer ${TOKEN_A}`);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    // E4-13.
    it('E4-13: sort=change24h&order=desc orders by latest.change24hPct descending', async () => {
      const app = createAppWithFakeAuth();
      await createCoin({
        coingeckoId: 'bitcoin',
        latest: { priceUsd: 1, change24hPct: 2, capturedAt: new Date() },
      });
      await createCoin({
        coingeckoId: 'ethereum',
        latest: { priceUsd: 1, change24hPct: 8, capturedAt: new Date() },
      });
      await createCoin({
        coingeckoId: 'solana',
        latest: { priceUsd: 1, change24hPct: -3, capturedAt: new Date() },
      });

      for (const coingeckoId of ['bitcoin', 'ethereum', 'solana']) {
        await request(app)
          .post('/api/v1/me/watchlist')
          .set('Authorization', `Bearer ${TOKEN_A}`)
          .send({ coingeckoId });
      }

      const response = await request(app)
        .get('/api/v1/me/watchlist?sort=change24h&order=desc')
        .set('Authorization', `Bearer ${TOKEN_A}`);

      expect(response.status).toBe(200);
      expect(response.body.data.map((item: { coingeckoId: string }) => item.coingeckoId)).toEqual([
        'ethereum',
        'bitcoin',
        'solana',
      ]);
    });

    // RNF-4.2.
    it('RNF-4.2: the listing aggregation uses an IXSCAN on { userId: 1, addedAt: -1 }, never a COLLSCAN', async () => {
      const userId = new Types.ObjectId();
      const coin = await createCoin({ coingeckoId: 'bitcoin' });
      await WatchlistItemModel.create({ userId, coinId: coin._id, note: null });

      const explainResult = await WatchlistItemModel.aggregate([
        { $match: { userId } },
        {
          $lookup: {
            from: 'coins',
            localField: 'coinId',
            foreignField: '_id',
            as: 'coin',
            pipeline: [
              { $project: { _id: 0, coingeckoId: 1, symbol: 1, name: 1, isActive: 1, latest: 1 } },
            ],
          },
        },
        { $unwind: '$coin' },
        { $sort: { addedAt: -1 } },
      ]).explain('executionStats');

      const serialized = JSON.stringify(explainResult);
      expect(serialized).toContain('IXSCAN');
      expect(serialized).toContain('userId_1_addedAt_-1');
      expect(serialized).not.toContain('COLLSCAN');
    });
  });

  describe('POST /api/v1/me/watchlist', () => {
    it('rejects a malformed body with 400 before any coin lookup', async () => {
      const app = createAppWithFakeAuth();
      const response = await request(app)
        .post('/api/v1/me/watchlist')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ note: 'sin coingeckoId' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a client-supplied userId in the body with 400 (RF-4.5)', async () => {
      const app = createAppWithFakeAuth();
      const response = await request(app)
        .post('/api/v1/me/watchlist')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ coingeckoId: 'bitcoin', userId: 'someone-elses-id' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    // E4-3 (unknown coin).
    it('E4-3: an unknown coingeckoId is rejected with 404', async () => {
      const app = createAppWithFakeAuth();
      const response = await request(app)
        .post('/api/v1/me/watchlist')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ coingeckoId: 'does-not-exist' });

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    // E4-3 (inactive coin).
    it('E4-3: an inactive coingeckoId is rejected with 404', async () => {
      const app = createAppWithFakeAuth();
      await createCoin({ coingeckoId: 'dogecoin', isActive: false });

      const response = await request(app)
        .post('/api/v1/me/watchlist')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ coingeckoId: 'dogecoin' });

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    // E4-1 + 4.4: 201 with Location header.
    it('E4-1: returns 201 with the item and a Location header naming the watchlist path', async () => {
      const app = createAppWithFakeAuth();
      await createCoin({ coingeckoId: 'bitcoin' });

      const response = await request(app)
        .post('/api/v1/me/watchlist')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ coingeckoId: 'bitcoin', note: 'largo plazo' });

      expect(response.status).toBe(201);
      expect(response.headers.location).toBe('/api/v1/me/watchlist/bitcoin');
      expect(response.body.data).toMatchObject({ coingeckoId: 'bitcoin', note: 'largo plazo' });
      expect(response.body.data.userId).toBeUndefined();
      expect(response.body.data._id).toBeUndefined();
    });

    // E4-2.
    it('E4-2: adding the same coin twice conflicts with 409', async () => {
      const app = createAppWithFakeAuth();
      await createCoin({ coingeckoId: 'bitcoin' });

      await request(app)
        .post('/api/v1/me/watchlist')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ coingeckoId: 'bitcoin' });

      const response = await request(app)
        .post('/api/v1/me/watchlist')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ coingeckoId: 'bitcoin' });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('CONFLICT');
    });

    // E4-4, with a small injected cap so the test doesn't need to seed 50 items.
    it('E4-4: reaching WATCHLIST_MAX_ITEMS is reported as 422 UNPROCESSABLE / LIMIT_REACHED', async () => {
      const app = createAppWithFakeAuth({ watchlistConfig: { WATCHLIST_MAX_ITEMS: 2 } });
      await createCoin({ coingeckoId: 'bitcoin' });
      await createCoin({ coingeckoId: 'ethereum' });
      await createCoin({ coingeckoId: 'solana' });

      await request(app)
        .post('/api/v1/me/watchlist')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ coingeckoId: 'bitcoin' });
      await request(app)
        .post('/api/v1/me/watchlist')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ coingeckoId: 'ethereum' });

      const response = await request(app)
        .post('/api/v1/me/watchlist')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ coingeckoId: 'solana' });

      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('UNPROCESSABLE');
      expect(response.body.error.details).toEqual({ reason: 'LIMIT_REACHED' });
    });

    // 4.11: two concurrent identical POSTs yield exactly one 201 and one 409.
    it('two concurrent identical POST requests yield exactly one 201 and one 409', async () => {
      const app = createAppWithFakeAuth();
      await createCoin({ coingeckoId: 'bitcoin' });

      const [first, second] = await Promise.all([
        request(app)
          .post('/api/v1/me/watchlist')
          .set('Authorization', `Bearer ${TOKEN_A}`)
          .send({ coingeckoId: 'bitcoin' }),
        request(app)
          .post('/api/v1/me/watchlist')
          .set('Authorization', `Bearer ${TOKEN_A}`)
          .send({ coingeckoId: 'bitcoin' }),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);

      const user = await UserModel.findOne({ firebaseUid: IDENTITY_A.uid }).lean();
      const count = await WatchlistItemModel.countDocuments({ userId: user?._id });
      expect(count).toBe(1);
    });

    // E4-5, with two distinct fake tokens.
    it('E4-5: isolation between two users — A adding a coin leaves B empty, and B deleting it does not affect A', async () => {
      const app = createAppWithFakeAuth();
      await createCoin({ coingeckoId: 'bitcoin' });

      const addResponse = await request(app)
        .post('/api/v1/me/watchlist')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ coingeckoId: 'bitcoin' });
      expect(addResponse.status).toBe(201);

      const bListResponse = await request(app)
        .get('/api/v1/me/watchlist')
        .set('Authorization', `Bearer ${TOKEN_B}`);
      expect(bListResponse.body.data).toHaveLength(0);

      const bDeleteResponse = await request(app)
        .delete('/api/v1/me/watchlist/bitcoin')
        .set('Authorization', `Bearer ${TOKEN_B}`);
      expect(bDeleteResponse.status).toBe(204);

      const aListResponse = await request(app)
        .get('/api/v1/me/watchlist')
        .set('Authorization', `Bearer ${TOKEN_A}`);
      expect(aListResponse.body.data).toHaveLength(1);
      expect(aListResponse.body.data[0].coingeckoId).toBe('bitcoin');
    });
  });

  describe('PATCH /api/v1/me/watchlist/:coingeckoId', () => {
    it('updates the note of a followed coin', async () => {
      const app = createAppWithFakeAuth();
      await createCoin({ coingeckoId: 'bitcoin' });
      await request(app)
        .post('/api/v1/me/watchlist')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ coingeckoId: 'bitcoin' });

      const response = await request(app)
        .patch('/api/v1/me/watchlist/bitcoin')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ note: 'nueva nota' });

      expect(response.status).toBe(200);
      expect(response.body.data.note).toBe('nueva nota');
    });

    it('updates the note of a deactivated coin still followed', async () => {
      const app = createAppWithFakeAuth();
      const coin = await createCoin({ coingeckoId: 'bitcoin' });
      await request(app)
        .post('/api/v1/me/watchlist')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ coingeckoId: 'bitcoin' });

      await CoinModel.updateOne({ _id: coin._id }, { $set: { isActive: false } });

      const response = await request(app)
        .patch('/api/v1/me/watchlist/bitcoin')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ note: 'todavía la sigo' });

      expect(response.status).toBe(200);
      expect(response.body.data.isActive).toBe(false);
      expect(response.body.data.note).toBe('todavía la sigo');
    });

    // E4-7.
    it('E4-7: patching a coin not in the watchlist is 404', async () => {
      const app = createAppWithFakeAuth();
      await createCoin({ coingeckoId: 'ethereum' });

      const response = await request(app)
        .patch('/api/v1/me/watchlist/ethereum')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ note: 'nota' });

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('resolves a mixed-case path id by lowercasing it first', async () => {
      const app = createAppWithFakeAuth();
      await createCoin({ coingeckoId: 'bitcoin' });
      await request(app)
        .post('/api/v1/me/watchlist')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ coingeckoId: 'bitcoin' });

      const response = await request(app)
        .patch('/api/v1/me/watchlist/Bitcoin')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ note: 'nota' });

      expect(response.status).toBe(200);
      expect(response.body.data.coingeckoId).toBe('bitcoin');
    });
  });

  describe('DELETE /api/v1/me/watchlist/:coingeckoId', () => {
    // E4-6.
    it('E4-6: deleting the same coin twice is 204 both times', async () => {
      const app = createAppWithFakeAuth();
      await createCoin({ coingeckoId: 'bitcoin' });
      await request(app)
        .post('/api/v1/me/watchlist')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ coingeckoId: 'bitcoin' });

      const first = await request(app)
        .delete('/api/v1/me/watchlist/bitcoin')
        .set('Authorization', `Bearer ${TOKEN_A}`);
      const second = await request(app)
        .delete('/api/v1/me/watchlist/bitcoin')
        .set('Authorization', `Bearer ${TOKEN_A}`);

      expect(first.status).toBe(204);
      expect(second.status).toBe(204);
    });

    it('deleting a coingeckoId that matches no coin at all is still 204', async () => {
      const app = createAppWithFakeAuth();
      const response = await request(app)
        .delete('/api/v1/me/watchlist/does-not-exist')
        .set('Authorization', `Bearer ${TOKEN_A}`);

      expect(response.status).toBe(204);
    });

    it('a malformed coingeckoId is a 400 VALIDATION_ERROR', async () => {
      const app = createAppWithFakeAuth();
      const response = await request(app)
        .delete('/api/v1/me/watchlist/Not_Valid!')
        .set('Authorization', `Bearer ${TOKEN_A}`);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});

describe('watchlist_items unique index (integration, task 2.3)', () => {
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

  it('rejects a duplicate { userId, coinId } pairing with a duplicate-key error', async () => {
    const userId = new Types.ObjectId();
    const coinId = new Types.ObjectId();

    await WatchlistItemModel.create({ userId, coinId, note: null });

    await expect(WatchlistItemModel.create({ userId, coinId, note: null })).rejects.toMatchObject({
      code: 11000,
    });
  });

  it('allows the same coin for two different users', async () => {
    const coinId = new Types.ObjectId();

    await WatchlistItemModel.create({ userId: new Types.ObjectId(), coinId, note: null });
    await WatchlistItemModel.create({ userId: new Types.ObjectId(), coinId, note: null });

    const count = await WatchlistItemModel.countDocuments({ coinId });
    expect(count).toBe(2);
  });
});

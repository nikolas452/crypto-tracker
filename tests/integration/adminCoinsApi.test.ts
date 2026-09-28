import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import { createApp } from '../../src/app.js';
import { CoinModel } from '../../src/modules/coins/coins.model.js';
import { UserModel } from '../../src/modules/users/users.model.js';
import { WatchlistItemModel } from '../../src/modules/watchlist/watchlist.model.js';
import { createCoinsRepo } from '../../src/modules/coins/coins.service.js';
import { createFakeTokenVerifier } from '../../src/integrations/firebase/fakeTokenVerifier.js';
import { ensureCollections } from '../../src/db/ensureCollections.js';
import { clearDatabase, startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';
import type { CoinGeckoClient } from '../../src/integrations/coingecko/coingecko.types.js';

const silentLogger = pino({ level: 'silent' });

const ADMIN_TOKEN = 'coins-admin-token';
const USER_TOKEN = 'coins-user-token';
const ADMIN_IDENTITY = {
  uid: 'coins-admin-uid',
  email: 'coins-admin@example.com',
  emailVerified: true,
  name: null,
};
const USER_IDENTITY = {
  uid: 'coins-plain-user-uid',
  email: 'coins-plain-user@example.com',
  emailVerified: true,
  name: null,
};

/** Un cliente de CoinGecko falso: `getMarkets` resuelve contra un mapa fijo de id -> { symbol, name }. */
function createFakeCoingecko(
  markets: Record<string, { symbol: string; name: string }>,
): CoinGeckoClient {
  return {
    getMarkets: vi.fn(async (ids: string[]) =>
      ids
        .filter((id) => id in markets)
        .map((id) => ({
          coingeckoId: id,
          symbol: markets[id]!.symbol,
          name: markets[id]!.name,
          priceUsd: 1,
        })),
    ),
    getSimplePrices: vi.fn(),
    ping: vi.fn(),
    getMarketChart: vi.fn(),
  };
}

function createAppWithFakeAuth(coingecko: CoinGeckoClient) {
  return createApp({
    logger: silentLogger,
    tokenVerifier: createFakeTokenVerifier({
      identities: { [ADMIN_TOKEN]: ADMIN_IDENTITY, [USER_TOKEN]: USER_IDENTITY },
    }),
    coingecko,
  });
}

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

/**
 * Tests de integración de los endpoints de administración de monedas
 * (`/api/v1/admin/coins`, spec admin-coin-management): E4-8, E4-9, E4-10,
 * E4-11, protegidos por `requireAuth({ checkRevoked: true })` +
 * `requireRole('admin')`.
 */
describe('admin coins API (integration)', () => {
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

  // E4-9.
  it('E4-9: a non-admin user gets 403 FORBIDDEN on POST /api/v1/admin/coins', async () => {
    const app = createAppWithFakeAuth(createFakeCoingecko({}));

    const response = await request(app)
      .post('/api/v1/admin/coins')
      .set('Authorization', `Bearer ${USER_TOKEN}`)
      .send({ coingeckoId: 'bitcoin' });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  // E4-10.
  it('E4-10: an id CoinGecko does not recognize is 422 UNKNOWN_COINGECKO_ID', async () => {
    await seedAdminUser();
    const app = createAppWithFakeAuth(createFakeCoingecko({}));

    const response = await request(app)
      .post('/api/v1/admin/coins')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ coingeckoId: 'not-a-real-coin' });

    expect(response.status).toBe(422);
    expect(response.body.error.details).toEqual({ reason: 'UNKNOWN_COINGECKO_ID' });

    const created = await CoinModel.findOne({ coingeckoId: 'not-a-real-coin' });
    expect(created).toBeNull();
  });

  it('creates a brand-new coin as active with 201', async () => {
    await seedAdminUser();
    const app = createAppWithFakeAuth(
      createFakeCoingecko({ bitcoin: { symbol: 'btc', name: 'Bitcoin' } }),
    );

    const response = await request(app)
      .post('/api/v1/admin/coins')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ coingeckoId: 'bitcoin' });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      coingeckoId: 'bitcoin',
      symbol: 'btc',
      name: 'Bitcoin',
      isActive: true,
      watchersCount: 0,
    });
  });

  // E4-11.
  it('E4-11: reactivating an existing inactive coin responds 200 with isActive: true', async () => {
    await seedAdminUser();
    await CoinModel.create({
      coingeckoId: 'dogecoin',
      symbol: 'doge',
      name: 'Dogecoin',
      isActive: false,
    });
    const app = createAppWithFakeAuth(
      createFakeCoingecko({ dogecoin: { symbol: 'doge', name: 'Dogecoin' } }),
    );

    const response = await request(app)
      .post('/api/v1/admin/coins')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ coingeckoId: 'dogecoin' });

    expect(response.status).toBe(200);
    expect(response.body.data.isActive).toBe(true);

    const stored = await CoinModel.findOne({ coingeckoId: 'dogecoin' });
    expect(stored?.isActive).toBe(true);
  });

  it('an already-active coin conflicts with 409', async () => {
    await seedAdminUser();
    await CoinModel.create({
      coingeckoId: 'bitcoin',
      symbol: 'btc',
      name: 'Bitcoin',
      isActive: true,
    });
    const app = createAppWithFakeAuth(
      createFakeCoingecko({ bitcoin: { symbol: 'btc', name: 'Bitcoin' } }),
    );

    const response = await request(app)
      .post('/api/v1/admin/coins')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ coingeckoId: 'bitcoin' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CONFLICT');
  });

  it('an upstream CoinGecko failure is reported as 502 UPSTREAM_ERROR', async () => {
    await seedAdminUser();
    const coingecko = createFakeCoingecko({});
    (coingecko.getMarkets as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('network down'),
    );
    const app = createAppWithFakeAuth(coingecko);

    const response = await request(app)
      .post('/api/v1/admin/coins')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ coingeckoId: 'bitcoin' });

    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe('UPSTREAM_ERROR');
  });

  // E4-8.
  it("E4-8: a deactivated coin stays in the follower's watchlist with isActive: false, and drops out of the next poll batch", async () => {
    await seedAdminUser();
    const coin = await CoinModel.create({
      coingeckoId: 'bitcoin',
      symbol: 'btc',
      name: 'Bitcoin',
      isActive: true,
      latest: { priceUsd: 100, capturedAt: new Date() },
    });
    await WatchlistItemModel.create({
      userId: (await UserModel.findOne({ firebaseUid: ADMIN_IDENTITY.uid }))!._id,
      coinId: coin._id,
      note: null,
    });

    const app = createAppWithFakeAuth(createFakeCoingecko({}));
    const patchResponse = await request(app)
      .patch('/api/v1/admin/coins/bitcoin')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ isActive: false });

    expect(patchResponse.status).toBe(200);
    expect(patchResponse.body.data).toMatchObject({ isActive: false, watchersCount: 1 });

    const listResponse = await request(app)
      .get('/api/v1/me/watchlist')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(listResponse.body.data[0]).toMatchObject({ coingeckoId: 'bitcoin', isActive: false });
    expect(listResponse.body.data[0].latest.priceUsd).toBe(100);

    // El job de polling solo consulta `findActive()` (spec price-polling-job): una vez
    // desactivada, la próxima corrida ya no la incluye en el batch.
    const activeCoins = await createCoinsRepo().findActive();
    expect(activeCoins.map((c) => c.coingeckoId)).not.toContain('bitcoin');
  });

  it('GET /api/v1/admin/coins includes inactive coins and each watchersCount', async () => {
    await seedAdminUser();
    const bitcoin = await CoinModel.create({
      coingeckoId: 'bitcoin',
      symbol: 'btc',
      name: 'Bitcoin',
      isActive: true,
    });
    await CoinModel.create({
      coingeckoId: 'dogecoin',
      symbol: 'doge',
      name: 'Dogecoin',
      isActive: false,
    });
    const admin = await UserModel.findOne({ firebaseUid: ADMIN_IDENTITY.uid });
    await WatchlistItemModel.create({ userId: admin!._id, coinId: bitcoin._id, note: null });

    const app = createAppWithFakeAuth(createFakeCoingecko({}));
    const response = await request(app)
      .get('/api/v1/admin/coins')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(2);
    const byId = Object.fromEntries(
      response.body.data.map((c: { coingeckoId: string }) => [c.coingeckoId, c]),
    );
    expect(byId.bitcoin).toMatchObject({ isActive: true, watchersCount: 1 });
    expect(byId.dogecoin).toMatchObject({ isActive: false, watchersCount: 0 });
  });

  it('supports filtering by isActive', async () => {
    await seedAdminUser();
    await CoinModel.create({
      coingeckoId: 'bitcoin',
      symbol: 'btc',
      name: 'Bitcoin',
      isActive: true,
    });
    await CoinModel.create({
      coingeckoId: 'dogecoin',
      symbol: 'doge',
      name: 'Dogecoin',
      isActive: false,
    });

    const app = createAppWithFakeAuth(createFakeCoingecko({}));
    const response = await request(app)
      .get('/api/v1/admin/coins?isActive=false')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].coingeckoId).toBe('dogecoin');
  });

  it('has no DELETE route for coins (spec: coins are never deleted)', async () => {
    await seedAdminUser();
    await CoinModel.create({
      coingeckoId: 'bitcoin',
      symbol: 'btc',
      name: 'Bitcoin',
      isActive: true,
    });
    const app = createAppWithFakeAuth(createFakeCoingecko({}));

    const response = await request(app)
      .delete('/api/v1/admin/coins/bitcoin')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(response.status).toBe(404);
  });
});

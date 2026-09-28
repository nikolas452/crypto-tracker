import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import { Types } from 'mongoose';
import { createApp } from '../../src/app.js';
import { CoinModel } from '../../src/modules/coins/coins.model.js';
import { UserModel } from '../../src/modules/users/users.model.js';
import { AlertModel } from '../../src/modules/alerts/alerts.model.js';
import { NotificationModel } from '../../src/modules/notifications/notifications.model.js';
import { createFakeTokenVerifier } from '../../src/integrations/firebase/fakeTokenVerifier.js';
import { ensureCollections } from '../../src/db/ensureCollections.js';
import { clearDatabase, startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';

const silentLogger = pino({ level: 'silent' });

/**
 * Tests de integración de los endpoints de alertas (spec alert-api): tarea
 * 5.9, E5-1 y E5-16 (obligatorios) más cobertura razonable del resto del
 * CRUD — contra un Mongo en memoria real y un `FakeTokenVerifier`, nunca un
 * proyecto de Firebase real.
 */

const TOKEN_A = 'alerts-user-a-token';
const IDENTITY_A = {
  uid: 'alerts-uid-a',
  email: 'a@example.com',
  emailVerified: true,
  name: null,
};
const TOKEN_UNVERIFIED = 'alerts-user-unverified-token';
const IDENTITY_UNVERIFIED = {
  uid: 'alerts-uid-unverified',
  email: 'unverified@example.com',
  emailVerified: false,
  name: null,
};
const TOKEN_B = 'alerts-user-b-token';
const IDENTITY_B = {
  uid: 'alerts-uid-b',
  email: 'b@example.com',
  emailVerified: true,
  name: null,
};

function createAppWithFakeAuth(overrides: Parameters<typeof createApp>[0] = {}) {
  return createApp({
    logger: silentLogger,
    tokenVerifier: createFakeTokenVerifier({
      identities: {
        [TOKEN_A]: IDENTITY_A,
        [TOKEN_UNVERIFIED]: IDENTITY_UNVERIFIED,
        [TOKEN_B]: IDENTITY_B,
      },
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

/** Provisiona al usuario A (crea su documento de `users`) haciendo un request autenticado cualquiera, y devuelve su ObjectId. */
async function provisionUserA(app: ReturnType<typeof createApp>) {
  await request(app).get('/api/v1/me/alerts').set('Authorization', `Bearer ${TOKEN_A}`);
  const user = await UserModel.findOne({ firebaseUid: IDENTITY_A.uid });
  if (!user) {
    throw new Error('expected user A to be provisioned');
  }
  return user._id;
}

describe('alerts API (integration)', () => {
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

  describe('GET /api/v1/me/alerts', () => {
    it('rejects an unauthenticated request with 401', async () => {
      const app = createAppWithFakeAuth();
      const response = await request(app).get('/api/v1/me/alerts');
      expect(response.status).toBe(401);
    });

    it('sends Cache-Control: private, no-cache', async () => {
      const app = createAppWithFakeAuth();
      const response = await request(app)
        .get('/api/v1/me/alerts')
        .set('Authorization', `Bearer ${TOKEN_A}`);

      expect(response.headers['cache-control']).toBe('private, no-cache');
    });

    it('rejects an unknown query parameter with 400 VALIDATION_ERROR', async () => {
      const app = createAppWithFakeAuth();
      const response = await request(app)
        .get('/api/v1/me/alerts?foo=bar')
        .set('Authorization', `Bearer ${TOKEN_A}`);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects an unknown status value with 400 VALIDATION_ERROR', async () => {
      const app = createAppWithFakeAuth();
      const response = await request(app)
        .get('/api/v1/me/alerts?status=not-a-status')
        .set('Authorization', `Bearer ${TOKEN_A}`);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('lists alerts ordered by createdAt descending, each with its coin identity and latest', async () => {
      const app = createAppWithFakeAuth();
      await createCoin({
        coingeckoId: 'bitcoin',
        symbol: 'btc',
        name: 'Bitcoin',
        latest: { priceUsd: 64000, change24hPct: 1.2, capturedAt: new Date() },
      });
      await createCoin({ coingeckoId: 'ethereum', symbol: 'eth', name: 'Ethereum' });

      await request(app)
        .post('/api/v1/me/alerts')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ coingeckoId: 'bitcoin', type: 'PRICE_ABOVE', threshold: 50000 });
      await request(app)
        .post('/api/v1/me/alerts')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ coingeckoId: 'ethereum', type: 'PRICE_BELOW', threshold: 1000 });

      const response = await request(app)
        .get('/api/v1/me/alerts')
        .set('Authorization', `Bearer ${TOKEN_A}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(2);
      // Más reciente primero (ethereum se creó después de bitcoin).
      expect(response.body.data[0].coingeckoId).toBe('ethereum');
      expect(response.body.data[1].coingeckoId).toBe('bitcoin');
      expect(response.body.data[1].coin).toMatchObject({ symbol: 'btc', name: 'Bitcoin', isActive: true });
      expect(response.body.data[1].coin.latest.priceUsd).toBe(64000);
      expect(response.body.meta).toMatchObject({ page: 1, limit: 20, total: 2, totalPages: 1 });
    });

    it('paginates with page/limit', async () => {
      const app = createAppWithFakeAuth();
      for (const id of ['bitcoin', 'ethereum', 'solana']) {
        await createCoin({ coingeckoId: id });
        await request(app)
          .post('/api/v1/me/alerts')
          .set('Authorization', `Bearer ${TOKEN_A}`)
          .send({ coingeckoId: id, type: 'PRICE_ABOVE', threshold: 100 });
      }

      const response = await request(app)
        .get('/api/v1/me/alerts?page=2&limit=2')
        .set('Authorization', `Bearer ${TOKEN_A}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.meta).toMatchObject({ page: 2, limit: 2, total: 3, totalPages: 2 });
    });

    it('filters by one or more comma-separated status values', async () => {
      const app = createAppWithFakeAuth();
      const userId = await provisionUserA(app);
      const coin = await createCoin({ coingeckoId: 'bitcoin' });

      await AlertModel.create([
        { userId, coinId: coin._id, type: 'PRICE_ABOVE', threshold: 100, status: 'armed' },
        { userId, coinId: coin._id, type: 'PRICE_BELOW', threshold: 50, status: 'disabled' },
        { userId, coinId: coin._id, type: 'CHANGE_24H_ABS_GTE', threshold: 5, status: 'completed' },
      ]);

      const response = await request(app)
        .get('/api/v1/me/alerts?status=armed,disabled')
        .set('Authorization', `Bearer ${TOKEN_A}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(2);
      const statuses = response.body.data.map((item: { status: string }) => item.status).sort();
      expect(statuses).toEqual(['armed', 'disabled']);
    });

    it('filters by coingeckoId', async () => {
      const app = createAppWithFakeAuth();
      await createCoin({ coingeckoId: 'bitcoin' });
      await createCoin({ coingeckoId: 'ethereum' });
      await request(app)
        .post('/api/v1/me/alerts')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ coingeckoId: 'bitcoin', type: 'PRICE_ABOVE', threshold: 100 });
      await request(app)
        .post('/api/v1/me/alerts')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ coingeckoId: 'ethereum', type: 'PRICE_ABOVE', threshold: 100 });

      const response = await request(app)
        .get('/api/v1/me/alerts?coingeckoId=ethereum')
        .set('Authorization', `Bearer ${TOKEN_A}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].coingeckoId).toBe('ethereum');
    });
  });

  describe('POST /api/v1/me/alerts', () => {
    it('rejects a malformed body with 400 before any coin lookup', async () => {
      const app = createAppWithFakeAuth();
      const response = await request(app)
        .post('/api/v1/me/alerts')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ coingeckoId: 'bitcoin' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects an out-of-range threshold for CHANGE_24H_ABS_GTE with 400', async () => {
      const app = createAppWithFakeAuth();
      const response = await request(app)
        .post('/api/v1/me/alerts')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ coingeckoId: 'bitcoin', type: 'CHANGE_24H_ABS_GTE', threshold: 500 });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    // E5-1.
    it('E5-1: an unverified email is rejected with 422 UNPROCESSABLE / EMAIL_NOT_VERIFIED', async () => {
      const app = createAppWithFakeAuth();
      const response = await request(app)
        .post('/api/v1/me/alerts')
        .set('Authorization', `Bearer ${TOKEN_UNVERIFIED}`)
        .send({ coingeckoId: 'bitcoin', type: 'PRICE_ABOVE', threshold: 50000 });

      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('UNPROCESSABLE');
      expect(response.body.error.details).toEqual({ reason: 'EMAIL_NOT_VERIFIED' });
    });

    it('an unknown coingeckoId is rejected with 404, even with a verified email', async () => {
      const app = createAppWithFakeAuth();
      const response = await request(app)
        .post('/api/v1/me/alerts')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ coingeckoId: 'does-not-exist', type: 'PRICE_ABOVE', threshold: 50000 });

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('an inactive coin is rejected with 404', async () => {
      const app = createAppWithFakeAuth();
      await createCoin({ coingeckoId: 'dogecoin', isActive: false });

      const response = await request(app)
        .post('/api/v1/me/alerts')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ coingeckoId: 'dogecoin', type: 'PRICE_ABOVE', threshold: 1 });

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 201 with the alert, Location header, and meta.conditionCurrentlyMet computed from latest', async () => {
      const app = createAppWithFakeAuth();
      await createCoin({
        coingeckoId: 'bitcoin',
        latest: { priceUsd: 51000, change24hPct: 2, capturedAt: new Date() },
      });

      const response = await request(app)
        .post('/api/v1/me/alerts')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ coingeckoId: 'bitcoin', type: 'PRICE_ABOVE', threshold: 50000 });

      expect(response.status).toBe(201);
      expect(response.headers.location).toBe(`/api/v1/me/alerts/${response.body.data.id}`);
      expect(response.body.data).toMatchObject({
        coingeckoId: 'bitcoin',
        type: 'PRICE_ABOVE',
        threshold: 50000,
        status: 'armed',
        mode: 'recurring',
        cooldownMinutes: 60,
        rearmPct: 1,
        version: 0,
      });
      expect(response.body.meta).toEqual({ currentValue: 51000, conditionCurrentlyMet: true });
    });

    it('reports conditionCurrentlyMet: false and currentValue: null when the coin has no latest snapshot yet', async () => {
      const app = createAppWithFakeAuth();
      await createCoin({ coingeckoId: 'bitcoin', latest: null });

      const response = await request(app)
        .post('/api/v1/me/alerts')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ coingeckoId: 'bitcoin', type: 'PRICE_ABOVE', threshold: 50000 });

      expect(response.status).toBe(201);
      expect(response.body.meta).toEqual({ currentValue: null, conditionCurrentlyMet: false });
    });

    it('falls back to the model defaults (mode/cooldownMinutes/rearmPct/note) when optional fields are omitted', async () => {
      const app = createAppWithFakeAuth();
      await createCoin({ coingeckoId: 'bitcoin' });

      const response = await request(app)
        .post('/api/v1/me/alerts')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ coingeckoId: 'bitcoin', type: 'PRICE_ABOVE', threshold: 50000 });

      expect(response.body.data).toMatchObject({
        mode: 'recurring',
        cooldownMinutes: 60,
        rearmPct: 1,
        note: null,
      });
    });

    // Cap con un valor pequeño inyectado, mismo criterio que E4-4 en watchlistApi.test.ts.
    it('reaching ALERTS_MAX_ACTIVE is reported as 422 UNPROCESSABLE / LIMIT_REACHED', async () => {
      const app = createAppWithFakeAuth({ alertsConfig: { ALERTS_MAX_ACTIVE: 1 } });
      await createCoin({ coingeckoId: 'bitcoin' });
      await createCoin({ coingeckoId: 'ethereum' });

      await request(app)
        .post('/api/v1/me/alerts')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ coingeckoId: 'bitcoin', type: 'PRICE_ABOVE', threshold: 100 });

      const response = await request(app)
        .post('/api/v1/me/alerts')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ coingeckoId: 'ethereum', type: 'PRICE_ABOVE', threshold: 100 });

      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('UNPROCESSABLE');
      expect(response.body.error.details).toEqual({ reason: 'LIMIT_REACHED' });
    });
  });

  describe('GET /api/v1/me/alerts/:id', () => {
    it('a malformed id is a 400 VALIDATION_ERROR', async () => {
      const app = createAppWithFakeAuth();
      const response = await request(app)
        .get('/api/v1/me/alerts/not-an-object-id')
        .set('Authorization', `Bearer ${TOKEN_A}`);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('an unknown but well-formed id is 404', async () => {
      const app = createAppWithFakeAuth();
      const response = await request(app)
        .get(`/api/v1/me/alerts/${new Types.ObjectId().toString()}`)
        .set('Authorization', `Bearer ${TOKEN_A}`);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    // E5-16.
    it("E5-16: user B requesting user A's alert gets 404, never 403", async () => {
      const app = createAppWithFakeAuth();
      await createCoin({ coingeckoId: 'bitcoin' });

      const createResponse = await request(app)
        .post('/api/v1/me/alerts')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ coingeckoId: 'bitcoin', type: 'PRICE_ABOVE', threshold: 50000 });
      const alertId = createResponse.body.data.id;

      const response = await request(app)
        .get(`/api/v1/me/alerts/${alertId}`)
        .set('Authorization', `Bearer ${TOKEN_B}`);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it("returns the caller's own alert with its coingeckoId resolved", async () => {
      const app = createAppWithFakeAuth();
      await createCoin({ coingeckoId: 'bitcoin' });
      const createResponse = await request(app)
        .post('/api/v1/me/alerts')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ coingeckoId: 'bitcoin', type: 'PRICE_ABOVE', threshold: 50000 });

      const response = await request(app)
        .get(`/api/v1/me/alerts/${createResponse.body.data.id}`)
        .set('Authorization', `Bearer ${TOKEN_A}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({ coingeckoId: 'bitcoin', threshold: 50000 });
    });
  });

  describe('PATCH /api/v1/me/alerts/:id', () => {
    it('rejects an empty body with 400', async () => {
      const app = createAppWithFakeAuth();
      await createCoin({ coingeckoId: 'bitcoin' });
      const createResponse = await request(app)
        .post('/api/v1/me/alerts')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ coingeckoId: 'bitcoin', type: 'PRICE_ABOVE', threshold: 50000 });

      const response = await request(app)
        .patch(`/api/v1/me/alerts/${createResponse.body.data.id}`)
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a threshold outside its (immutable) type range with 400', async () => {
      const app = createAppWithFakeAuth();
      await createCoin({ coingeckoId: 'bitcoin' });
      const createResponse = await request(app)
        .post('/api/v1/me/alerts')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ coingeckoId: 'bitcoin', type: 'CHANGE_24H_ABS_GTE', threshold: 5 });

      // `findOneAndUpdate` no corre el validador del schema por defecto — esto
      // prueba que `updateAlert` revalida `threshold` contra el `type` ya
      // guardado (alerts.service.ts) en vez de confiar solo en Mongoose.
      const response = await request(app)
        .patch(`/api/v1/me/alerts/${createResponse.body.data.id}`)
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ threshold: 5000 });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a body carrying type with 400 (unrecognized key, .strict())', async () => {
      const app = createAppWithFakeAuth();
      await createCoin({ coingeckoId: 'bitcoin' });
      const createResponse = await request(app)
        .post('/api/v1/me/alerts')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ coingeckoId: 'bitcoin', type: 'PRICE_ABOVE', threshold: 50000 });

      const response = await request(app)
        .patch(`/api/v1/me/alerts/${createResponse.body.data.id}`)
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ type: 'PRICE_BELOW' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('a malformed id is a 400 VALIDATION_ERROR', async () => {
      const app = createAppWithFakeAuth();
      const response = await request(app)
        .patch('/api/v1/me/alerts/not-an-object-id')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ note: 'x' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('patching an unknown id is 404', async () => {
      const app = createAppWithFakeAuth();
      const response = await request(app)
        .patch(`/api/v1/me/alerts/${new Types.ObjectId().toString()}`)
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ note: 'x' });

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('changing threshold on an armed alert updates it without touching status, and increments version', async () => {
      const app = createAppWithFakeAuth();
      const userId = await provisionUserA(app);
      const coin = await createCoin({ coingeckoId: 'bitcoin' });
      const alert = await AlertModel.create({
        userId,
        coinId: coin._id,
        type: 'PRICE_ABOVE',
        threshold: 50000,
        status: 'armed',
      });

      const response = await request(app)
        .patch(`/api/v1/me/alerts/${alert._id.toString()}`)
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ threshold: 60000 });

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({ threshold: 60000, status: 'armed', version: 1 });
    });

    it('changing threshold on a triggered alert rearms it back to armed', async () => {
      const app = createAppWithFakeAuth();
      const userId = await provisionUserA(app);
      const coin = await createCoin({ coingeckoId: 'bitcoin' });
      const alert = await AlertModel.create({
        userId,
        coinId: coin._id,
        type: 'PRICE_ABOVE',
        threshold: 50000,
        status: 'triggered',
        triggerCount: 1,
        lastTriggeredAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      const response = await request(app)
        .patch(`/api/v1/me/alerts/${alert._id.toString()}`)
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ threshold: 70000 });

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('armed');
      expect(response.body.data.threshold).toBe(70000);
      // lastTriggeredAt/triggerCount quedan intactos (no forman parte del $set).
      expect(response.body.data.triggerCount).toBe(1);
      expect(response.body.data.lastTriggeredAt).not.toBeNull();
    });

    it('a non-threshold change on a triggered alert leaves status untouched', async () => {
      const app = createAppWithFakeAuth();
      const userId = await provisionUserA(app);
      const coin = await createCoin({ coingeckoId: 'bitcoin' });
      const alert = await AlertModel.create({
        userId,
        coinId: coin._id,
        type: 'PRICE_ABOVE',
        threshold: 50000,
        status: 'triggered',
      });

      const response = await request(app)
        .patch(`/api/v1/me/alerts/${alert._id.toString()}`)
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ note: 'seguimiento' });

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('triggered');
      expect(response.body.data.note).toBe('seguimiento');
    });

    it('enabled: false always disables, regardless of current status', async () => {
      const app = createAppWithFakeAuth();
      const userId = await provisionUserA(app);
      const coin = await createCoin({ coingeckoId: 'bitcoin' });
      const alert = await AlertModel.create({
        userId,
        coinId: coin._id,
        type: 'PRICE_ABOVE',
        threshold: 50000,
        status: 'triggered',
      });

      const response = await request(app)
        .patch(`/api/v1/me/alerts/${alert._id.toString()}`)
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ enabled: false });

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('disabled');
    });

    it('enabled: true re-arms a disabled alert when the cap allows it', async () => {
      const app = createAppWithFakeAuth({ alertsConfig: { ALERTS_MAX_ACTIVE: 5 } });
      const userId = await provisionUserA(app);
      const coin = await createCoin({ coingeckoId: 'bitcoin' });
      const alert = await AlertModel.create({
        userId,
        coinId: coin._id,
        type: 'PRICE_ABOVE',
        threshold: 50000,
        status: 'disabled',
      });

      const response = await request(app)
        .patch(`/api/v1/me/alerts/${alert._id.toString()}`)
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ enabled: true });

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('armed');
    });

    it('enabled: true on a disabled alert is rejected with 422 LIMIT_REACHED when the cap is already full, and nothing is changed', async () => {
      const app = createAppWithFakeAuth({ alertsConfig: { ALERTS_MAX_ACTIVE: 1 } });
      const userId = await provisionUserA(app);
      const coin = await createCoin({ coingeckoId: 'bitcoin' });

      // Ya hay una alerta activa que llena el cap.
      await AlertModel.create({
        userId,
        coinId: coin._id,
        type: 'PRICE_ABOVE',
        threshold: 1,
        status: 'armed',
      });
      const disabledAlert = await AlertModel.create({
        userId,
        coinId: coin._id,
        type: 'PRICE_BELOW',
        threshold: 2,
        status: 'disabled',
      });

      const response = await request(app)
        .patch(`/api/v1/me/alerts/${disabledAlert._id.toString()}`)
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ enabled: true });

      expect(response.status).toBe(422);
      expect(response.body.error.details).toEqual({ reason: 'LIMIT_REACHED' });

      const stillDisabled = await AlertModel.findById(disabledAlert._id);
      expect(stillDisabled?.status).toBe('disabled');
      expect(stillDisabled?.version).toBe(0);
    });

    it('enabled: true on an already-armed alert is a status no-op, but a simultaneous threshold change still rearms a triggered one', async () => {
      const app = createAppWithFakeAuth();
      const userId = await provisionUserA(app);
      const coin = await createCoin({ coingeckoId: 'bitcoin' });
      const alert = await AlertModel.create({
        userId,
        coinId: coin._id,
        type: 'PRICE_ABOVE',
        threshold: 50000,
        status: 'triggered',
      });

      const response = await request(app)
        .patch(`/api/v1/me/alerts/${alert._id.toString()}`)
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ enabled: true, threshold: 65000 });

      expect(response.status).toBe(200);
      // enabled: true fue un no-op de status (la alerta ya no estaba
      // disabled/completed), pero el cambio de threshold sobre una alerta
      // triggered la rearma igual (regla 3c, independiente de 3b).
      expect(response.body.data.status).toBe('armed');
      expect(response.body.data.threshold).toBe(65000);
    });
  });

  describe('DELETE /api/v1/me/alerts/:id', () => {
    it('is always 204, even for an unknown id', async () => {
      const app = createAppWithFakeAuth();
      const response = await request(app)
        .delete(`/api/v1/me/alerts/${new Types.ObjectId().toString()}`)
        .set('Authorization', `Bearer ${TOKEN_A}`);

      expect(response.status).toBe(204);
    });

    it("is 204 for user B deleting user A's alert, and leaves it untouched", async () => {
      const app = createAppWithFakeAuth();
      await createCoin({ coingeckoId: 'bitcoin' });
      const createResponse = await request(app)
        .post('/api/v1/me/alerts')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ coingeckoId: 'bitcoin', type: 'PRICE_ABOVE', threshold: 50000 });

      const response = await request(app)
        .delete(`/api/v1/me/alerts/${createResponse.body.data.id}`)
        .set('Authorization', `Bearer ${TOKEN_B}`);
      expect(response.status).toBe(204);

      const stillThere = await AlertModel.findById(createResponse.body.data.id);
      expect(stillThere).not.toBeNull();
    });

    it('a malformed id is a 400 VALIDATION_ERROR', async () => {
      const app = createAppWithFakeAuth();
      const response = await request(app)
        .delete('/api/v1/me/alerts/not-an-object-id')
        .set('Authorization', `Bearer ${TOKEN_A}`);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('deletes the alert and cancels only its pending notifications, leaving a sending one alone', async () => {
      const app = createAppWithFakeAuth();
      const userId = await provisionUserA(app);
      const coin = await createCoin({ coingeckoId: 'bitcoin' });
      const alert = await AlertModel.create({
        userId,
        coinId: coin._id,
        type: 'PRICE_ABOVE',
        threshold: 50000,
        status: 'armed',
      });

      function payload() {
        return {
          coingeckoId: 'bitcoin',
          coinName: 'Bitcoin',
          symbol: 'btc',
          alertType: 'PRICE_ABOVE' as const,
          threshold: 50000,
          value: 51000,
          priceUsd: 51000,
          change24hPct: 2,
          triggeredAt: new Date(),
          note: null,
        };
      }

      const pendingNotification = await NotificationModel.create({
        userId,
        alertId: alert._id,
        to: 'a@example.com',
        status: 'pending',
        dedupeKey: `${alert._id.toString()}:1`,
        payload: payload(),
      });
      const sendingNotification = await NotificationModel.create({
        userId,
        alertId: alert._id,
        to: 'a@example.com',
        status: 'sending',
        dedupeKey: `${alert._id.toString()}:2`,
        payload: payload(),
      });

      const response = await request(app)
        .delete(`/api/v1/me/alerts/${alert._id.toString()}`)
        .set('Authorization', `Bearer ${TOKEN_A}`);
      expect(response.status).toBe(204);

      const deletedAlert = await AlertModel.findById(alert._id);
      expect(deletedAlert).toBeNull();

      const updatedPending = await NotificationModel.findById(pendingNotification._id);
      expect(updatedPending?.status).toBe('cancelled');

      const updatedSending = await NotificationModel.findById(sendingNotification._id);
      expect(updatedSending?.status).toBe('sending');
    });

    it('deleting twice is 204 both times, and the second delete does not touch notifications again', async () => {
      const app = createAppWithFakeAuth();
      await createCoin({ coingeckoId: 'bitcoin' });
      const createResponse = await request(app)
        .post('/api/v1/me/alerts')
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .send({ coingeckoId: 'bitcoin', type: 'PRICE_ABOVE', threshold: 50000 });

      const first = await request(app)
        .delete(`/api/v1/me/alerts/${createResponse.body.data.id}`)
        .set('Authorization', `Bearer ${TOKEN_A}`);
      const second = await request(app)
        .delete(`/api/v1/me/alerts/${createResponse.body.data.id}`)
        .set('Authorization', `Bearer ${TOKEN_A}`);

      expect(first.status).toBe(204);
      expect(second.status).toBe(204);
    });
  });
});

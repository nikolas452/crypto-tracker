import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import { createApp } from '../../src/app.js';
import { UserModel } from '../../src/modules/users/users.model.js';
import { CoinModel } from '../../src/modules/coins/coins.model.js';
import { WatchlistItemModel } from '../../src/modules/watchlist/watchlist.model.js';
import { AlertModel } from '../../src/modules/alerts/alerts.model.js';
import { NotificationModel } from '../../src/modules/notifications/notifications.model.js';
import { createFakeTokenVerifier } from '../../src/integrations/firebase/fakeTokenVerifier.js';
import { ensureCollections } from '../../src/db/ensureCollections.js';
import { clearDatabase, startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';

const silentLogger = pino({ level: 'silent' });

const TOKEN = 'user-token';
const IDENTITY = {
  uid: 'me-uid-1',
  email: 'me-user@example.com',
  emailVerified: true,
  name: null,
};

/** `createApp` con un `FakeTokenVerifier` que resuelve `TOKEN` -> `IDENTITY` (spec me-endpoints). */
function createAppWithFakeAuth() {
  return createApp({
    logger: silentLogger,
    tokenVerifier: createFakeTokenVerifier({ identities: { [TOKEN]: IDENTITY } }),
  });
}

/**
 * Tests de integración de `GET`/`PATCH`/`DELETE /api/v1/me` (spec
 * me-endpoints), contra un Mongo en memoria real y un `FakeTokenVerifier` —
 * nunca un proyecto de Firebase real.
 */
describe('me API (integration)', () => {
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

  it('rejects a request with no Authorization header with 401 UNAUTHENTICATED', async () => {
    const app = createAppWithFakeAuth();
    const response = await request(app).get('/api/v1/me');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  // E3-4.
  it('E3-4: a new uid is provisioned and its profile returned', async () => {
    const app = createAppWithFakeAuth();
    const response = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${TOKEN}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      email: IDENTITY.email,
      emailVerified: true,
      displayName: null,
      role: 'user',
    });
    expect(typeof response.body.data.id).toBe('string');
    expect(response.body.data.createdAt).toBeDefined();

    const count = await UserModel.countDocuments({ firebaseUid: IDENTITY.uid });
    expect(count).toBe(1);
  });

  describe('PATCH /api/v1/me', () => {
    // E3-8 (parte 1): displayName aceptado.
    it('E3-8: updates displayName', async () => {
      const app = createAppWithFakeAuth();
      const response = await request(app)
        .patch('/api/v1/me')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ displayName: 'Nico' });

      expect(response.status).toBe(200);
      expect(response.body.data.displayName).toBe('Nico');

      const stored = await UserModel.findOne({ firebaseUid: IDENTITY.uid }).lean();
      expect(stored?.displayName).toBe('Nico');
    });

    it('clears displayName when sent as null', async () => {
      const app = createAppWithFakeAuth();
      await request(app)
        .patch('/api/v1/me')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ displayName: 'Nico' });

      const response = await request(app)
        .patch('/api/v1/me')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ displayName: null });

      expect(response.status).toBe(200);
      expect(response.body.data.displayName).toBeNull();
    });

    // E3-8 (parte 2): role rechazado con 400.
    it('E3-8: rejects an attempt to set role with 400 VALIDATION_ERROR', async () => {
      const app = createAppWithFakeAuth();
      const response = await request(app)
        .patch('/api/v1/me')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ role: 'admin' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');

      const stored = await UserModel.findOne({ firebaseUid: IDENTITY.uid }).lean();
      expect(stored?.role ?? 'user').toBe('user');
    });

    it('rejects an empty body with 400 VALIDATION_ERROR', async () => {
      const app = createAppWithFakeAuth();
      const response = await request(app)
        .patch('/api/v1/me')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects an attempt to set email with 400 VALIDATION_ERROR', async () => {
      const app = createAppWithFakeAuth();
      const response = await request(app)
        .patch('/api/v1/me')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ email: 'someone-else@example.com' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('DELETE /api/v1/me', () => {
    // E3-11.
    it('E3-11: deletes the profile and responds 204', async () => {
      const app = createAppWithFakeAuth();
      await request(app).get('/api/v1/me').set('Authorization', `Bearer ${TOKEN}`);

      const response = await request(app)
        .delete('/api/v1/me')
        .set('Authorization', `Bearer ${TOKEN}`);

      expect(response.status).toBe(204);
      expect(response.body).toEqual({});

      const count = await UserModel.countDocuments({ firebaseUid: IDENTITY.uid });
      expect(count).toBe(0);
    });

    // E4-12 / spec account-deletion-cascade: los ítems de watchlist se
    // borran antes que el propio usuario.
    it("E4-12: deletes the user's watchlist items along with the account", async () => {
      const app = createAppWithFakeAuth();
      await request(app).get('/api/v1/me').set('Authorization', `Bearer ${TOKEN}`);
      const user = await UserModel.findOne({ firebaseUid: IDENTITY.uid });

      const coins = await CoinModel.create([
        { coingeckoId: 'bitcoin', symbol: 'btc', name: 'Bitcoin', isActive: true },
        { coingeckoId: 'ethereum', symbol: 'eth', name: 'Ethereum', isActive: true },
        { coingeckoId: 'solana', symbol: 'sol', name: 'Solana', isActive: true },
      ]);
      await WatchlistItemModel.create(
        coins.map((coin) => ({ userId: user!._id, coinId: coin._id, note: null })),
      );

      const response = await request(app)
        .delete('/api/v1/me')
        .set('Authorization', `Bearer ${TOKEN}`);

      expect(response.status).toBe(204);
      const remainingItems = await WatchlistItemModel.countDocuments({ userId: user!._id });
      expect(remainingItems).toBe(0);
    });

    // E5-15 / spec account-deletion-cascade: las alertas y notificaciones
    // pendientes del usuario se borran junto con la cuenta, sin llegar a
    // enviarse nunca. Una notificación `sending` (ya reclamada por un job de
    // envío) se deja intacta a propósito, para que ese envío en curso pueda
    // terminar sin corromperse.
    it("E5-15: deletes the user's alerts and pending notifications along with the account, leaving a 'sending' one untouched", async () => {
      const app = createAppWithFakeAuth();
      await request(app).get('/api/v1/me').set('Authorization', `Bearer ${TOKEN}`);
      const user = await UserModel.findOne({ firebaseUid: IDENTITY.uid });

      const coin = await CoinModel.create({
        coingeckoId: 'bitcoin',
        symbol: 'btc',
        name: 'Bitcoin',
        isActive: true,
      });
      const alerts = await AlertModel.create([
        { userId: user!._id, coinId: coin._id, type: 'PRICE_BELOW', threshold: 50000 },
        { userId: user!._id, coinId: coin._id, type: 'PRICE_ABOVE', threshold: 90000 },
      ]);

      const notificationPayload = {
        coingeckoId: 'bitcoin',
        coinName: 'Bitcoin',
        symbol: 'btc',
        alertType: 'PRICE_BELOW' as const,
        threshold: 50000,
        value: 49000,
        priceUsd: 49000,
        change24hPct: null,
        triggeredAt: new Date(),
        note: null,
      };
      const pendingNotification = await NotificationModel.create({
        userId: user!._id,
        alertId: alerts[0]!._id,
        to: IDENTITY.email,
        status: 'pending',
        dedupeKey: `${alerts[0]!._id.toString()}:1`,
        payload: notificationPayload,
      });
      const sendingNotification = await NotificationModel.create({
        userId: user!._id,
        alertId: alerts[1]!._id,
        to: IDENTITY.email,
        status: 'sending',
        lockedAt: new Date(),
        lockedBy: 'some-other-worker',
        dedupeKey: `${alerts[1]!._id.toString()}:1`,
        payload: notificationPayload,
      });

      const response = await request(app)
        .delete('/api/v1/me')
        .set('Authorization', `Bearer ${TOKEN}`);

      expect(response.status).toBe(204);

      const remainingAlerts = await AlertModel.countDocuments({ userId: user!._id });
      expect(remainingAlerts).toBe(0);

      const remainingPending = await NotificationModel.findById(pendingNotification._id);
      expect(remainingPending).toBeNull();

      const stillSending = await NotificationModel.findById(sendingNotification._id);
      expect(stillSending).not.toBeNull();
      expect(stillSending!.status).toBe('sending');
    });

    // Documentado en el README (tarea 7.5): la cuenta de Firebase sobrevive,
    // así que un request posterior con un token todavía válido reaprovisiona
    // un perfil vacío nuevo.
    it('re-provisions an empty profile on a later request with a still-valid token', async () => {
      const app = createAppWithFakeAuth();
      await request(app).get('/api/v1/me').set('Authorization', `Bearer ${TOKEN}`);
      await request(app).delete('/api/v1/me').set('Authorization', `Bearer ${TOKEN}`);

      const response = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${TOKEN}`);

      expect(response.status).toBe(200);
      expect(response.body.data.role).toBe('user');
      expect(response.body.data.displayName).toBeNull();

      const count = await UserModel.countDocuments({ firebaseUid: IDENTITY.uid });
      expect(count).toBe(1);
    });
  });
});

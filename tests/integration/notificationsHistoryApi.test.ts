import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import { Types } from 'mongoose';
import { createApp } from '../../src/app.js';
import { config } from '../../src/config/env.js';
import { UserModel } from '../../src/modules/users/users.model.js';
import { NotificationModel } from '../../src/modules/notifications/notifications.model.js';
import { createFakeTokenVerifier } from '../../src/integrations/firebase/fakeTokenVerifier.js';
import { ensureCollections } from '../../src/db/ensureCollections.js';
import { clearDatabase, startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';

const silentLogger = pino({ level: 'silent' });

/**
 * Tests de integración del módulo notifications (spec notification-outbox,
 * tarea 4.5): el índice TTL de `notifications` existe con la retención
 * configurada, y `GET /api/v1/me/notifications` nunca expone campos
 * internos, contra un Mongo en memoria real y un `FakeTokenVerifier` — nunca
 * un proyecto de Firebase real.
 */

const TOKEN_A = 'notifications-user-a-token';
const IDENTITY_A = {
  uid: 'notifications-uid-a',
  email: 'a@example.com',
  emailVerified: true,
  name: null,
};

function createAppWithFakeAuth(overrides: Parameters<typeof createApp>[0] = {}) {
  return createApp({
    logger: silentLogger,
    tokenVerifier: createFakeTokenVerifier({
      identities: { [TOKEN_A]: IDENTITY_A },
    }),
    ...overrides,
  });
}

function buildNotificationPayload() {
  return {
    coingeckoId: 'bitcoin',
    coinName: 'Bitcoin',
    symbol: 'btc',
    alertType: 'PRICE_ABOVE' as const,
    threshold: 50000,
    value: 51000,
    priceUsd: 51000,
    change24hPct: 3.4,
    triggeredAt: new Date(),
    note: null,
  };
}

describe('notifications TTL index (integration, task 4.5)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
    await ensureCollections(silentLogger);
  }, 120000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  it('exists on createdAt with expireAfterSeconds = NOTIFICATIONS_RETENTION_DAYS x 86400', async () => {
    const indexes = await NotificationModel.collection.indexes();

    const ttlIndex = indexes.find(
      (index) => index.key && Object.keys(index.key).length === 1 && index.key.createdAt === 1,
    );

    expect(ttlIndex).toBeDefined();
    expect(ttlIndex?.expireAfterSeconds).toBe(config.NOTIFICATIONS_RETENTION_DAYS * 86400);
  });
});

describe('GET /api/v1/me/notifications (integration, task 4.5)', () => {
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

  it('rejects an unauthenticated request with 401', async () => {
    const app = createAppWithFakeAuth();
    const response = await request(app).get('/api/v1/me/notifications');
    expect(response.status).toBe(401);
  });

  it('exposes lastError.code but never lockedBy, dedupeKey or the internal error message, and masks to', async () => {
    const app = createAppWithFakeAuth();

    // Primer request autenticado: aprovisiona al usuario (mismo mecanismo
    // que watchlistApi.test.ts) para poder sembrar la notificación con su
    // userId real.
    await request(app).get('/api/v1/me/notifications').set('Authorization', `Bearer ${TOKEN_A}`);
    const user = await UserModel.findOne({ firebaseUid: IDENTITY_A.uid });
    expect(user).not.toBeNull();

    const alertId = new Types.ObjectId();
    const rawEmail = 'nicolas@example.com';
    const internalErrorMessage = 'Connection timed out while talking to smtp.example.com';

    await NotificationModel.create({
      userId: user!._id,
      alertId,
      channel: 'email',
      to: rawEmail,
      status: 'failed',
      dedupeKey: `${alertId.toString()}:1`,
      payload: buildNotificationPayload(),
      attempts: 5,
      maxAttempts: 5,
      nextAttemptAt: new Date(),
      lockedAt: null,
      lockedBy: 'worker-1',
      lastError: {
        code: 'SMTP_UNAVAILABLE',
        message: internalErrorMessage,
        permanent: false,
      },
      sentAt: null,
      providerMessageId: null,
    });

    const response = await request(app)
      .get('/api/v1/me/notifications')
      .set('Authorization', `Bearer ${TOKEN_A}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);

    const item = response.body.data[0];
    expect(item.status).toBe('failed');
    expect(item.lastError).toEqual({ code: 'SMTP_UNAVAILABLE' });
    expect(item.to).not.toBe(rawEmail);
    expect(item.to).toBe('n***@example.com');

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('lockedBy');
    expect(serialized).not.toContain('dedupeKey');
    expect(serialized).not.toContain(internalErrorMessage);
    expect(serialized).not.toContain(rawEmail);
  });

  it('only returns the caller\'s own notifications', async () => {
    const app = createAppWithFakeAuth();

    await request(app).get('/api/v1/me/notifications').set('Authorization', `Bearer ${TOKEN_A}`);

    const otherUserId = new Types.ObjectId();
    const otherAlertId = new Types.ObjectId();
    await NotificationModel.create({
      userId: otherUserId,
      alertId: otherAlertId,
      channel: 'email',
      to: 'otro@example.com',
      status: 'pending',
      dedupeKey: `${otherAlertId.toString()}:1`,
      payload: buildNotificationPayload(),
    });

    const response = await request(app)
      .get('/api/v1/me/notifications')
      .set('Authorization', `Bearer ${TOKEN_A}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(0);
  });

  it('sends Cache-Control: private, no-cache', async () => {
    const app = createAppWithFakeAuth();
    const response = await request(app)
      .get('/api/v1/me/notifications')
      .set('Authorization', `Bearer ${TOKEN_A}`);

    expect(response.headers['cache-control']).toBe('private, no-cache');
  });

  it('rejects an unknown query parameter with 400 VALIDATION_ERROR', async () => {
    const app = createAppWithFakeAuth();
    const response = await request(app)
      .get('/api/v1/me/notifications?foo=bar')
      .set('Authorization', `Bearer ${TOKEN_A}`);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an unknown status value with 400 VALIDATION_ERROR', async () => {
    const app = createAppWithFakeAuth();
    const response = await request(app)
      .get('/api/v1/me/notifications?status=not-a-status')
      .set('Authorization', `Bearer ${TOKEN_A}`);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('notifications dedupeKey unique index (integration)', () => {
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

  it('rejects a duplicate dedupeKey with a duplicate-key error', async () => {
    const userId = new Types.ObjectId();
    const alertId = new Types.ObjectId();
    const dedupeKey = `${alertId.toString()}:1`;

    await NotificationModel.create({
      userId,
      alertId,
      channel: 'email',
      to: 'a@example.com',
      status: 'pending',
      dedupeKey,
      payload: buildNotificationPayload(),
    });

    await expect(
      NotificationModel.create({
        userId,
        alertId,
        channel: 'email',
        to: 'a@example.com',
        status: 'pending',
        dedupeKey,
        payload: buildNotificationPayload(),
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });
});

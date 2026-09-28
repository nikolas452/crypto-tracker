import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import { Types } from 'mongoose';
import { createApp } from '../../src/app.js';
import { UserModel } from '../../src/modules/users/users.model.js';
import { NotificationModel } from '../../src/modules/notifications/notifications.model.js';
import { createFakeTokenVerifier } from '../../src/integrations/firebase/fakeTokenVerifier.js';
import { createFakeMailer } from '../../src/integrations/mailer/fakeMailer.js';
import { ensureCollections } from '../../src/db/ensureCollections.js';
import { clearDatabase, startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';

const silentLogger = pino({ level: 'silent' });

/**
 * Tests de integración de los endpoints de administración de notifications
 * (`/api/v1/admin/notifications`, spec admin-notifications-api, tarea 10.4):
 * **E5-17** (reintento de una notificación `failed`/`sent`), listado con
 * diagnóstico completo contrastado contra la supresión del endpoint de
 * usuario, y el email de prueba inmediato que bypassea el outbox.
 */

const ADMIN_TOKEN = 'admin-notifications-admin-token';
const ADMIN_NO_EMAIL_TOKEN = 'admin-notifications-admin-no-email-token';
const USER_TOKEN = 'admin-notifications-user-token';

const ADMIN_IDENTITY = {
  uid: 'admin-notifications-admin-uid',
  email: 'admin-notifications-admin@example.com',
  emailVerified: true,
  name: null,
};
const ADMIN_NO_EMAIL_IDENTITY = {
  uid: 'admin-notifications-admin-no-email-uid',
  email: null,
  emailVerified: false,
  name: null,
};
const USER_IDENTITY = {
  uid: 'admin-notifications-plain-user-uid',
  email: 'admin-notifications-plain-user@example.com',
  emailVerified: true,
  name: null,
};

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

function createAppWithFakeAuth(overrides: Parameters<typeof createApp>[0] = {}) {
  return createApp({
    logger: silentLogger,
    tokenVerifier: createFakeTokenVerifier({
      identities: {
        [ADMIN_TOKEN]: ADMIN_IDENTITY,
        [ADMIN_NO_EMAIL_TOKEN]: ADMIN_NO_EMAIL_IDENTITY,
        [USER_TOKEN]: USER_IDENTITY,
      },
    }),
    ...overrides,
  });
}

async function seedAdminUser(identity: { uid: string }) {
  await UserModel.updateOne(
    { firebaseUid: identity.uid },
    { $set: { role: 'admin' } },
  ).exec();
}

describe('admin notifications API (integration, task 10.4)', () => {
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

  it('a non-admin user gets 403 FORBIDDEN on GET /api/v1/admin/notifications', async () => {
    const app = createAppWithFakeAuth();

    const response = await request(app)
      .get('/api/v1/admin/notifications')
      .set('Authorization', `Bearer ${USER_TOKEN}`);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it(
    'admin listing shows full lastError and lockedBy, while GET /me/notifications ' +
      'suppresses both for the same notification',
    async () => {
      const app = createAppWithFakeAuth();

      // Aprovisiona ambos usuarios (mismo mecanismo que adminCoinsApi.test.ts).
      await request(app).get('/api/v1/admin/notifications').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      await request(app).get('/api/v1/me/notifications').set('Authorization', `Bearer ${USER_TOKEN}`);
      await seedAdminUser(ADMIN_IDENTITY);
      const owner = await UserModel.findOne({ firebaseUid: USER_IDENTITY.uid });
      expect(owner).not.toBeNull();

      const alertId = new Types.ObjectId();
      const internalErrorMessage = 'Connection timed out while talking to smtp.example.com';

      await NotificationModel.create({
        userId: owner!._id,
        alertId,
        channel: 'email',
        to: 'nicolas@example.com',
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

      const adminResponse = await request(app)
        .get('/api/v1/admin/notifications')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

      expect(adminResponse.status).toBe(200);
      expect(adminResponse.body.data).toHaveLength(1);
      expect(adminResponse.body.data[0].lastError).toEqual({
        code: 'SMTP_UNAVAILABLE',
        message: internalErrorMessage,
        permanent: false,
      });
      expect(adminResponse.body.data[0].lockedBy).toBe('worker-1');

      const userResponse = await request(app)
        .get('/api/v1/me/notifications')
        .set('Authorization', `Bearer ${USER_TOKEN}`);

      expect(userResponse.status).toBe(200);
      expect(userResponse.body.data).toHaveLength(1);
      expect(userResponse.body.data[0].lastError).toEqual({ code: 'SMTP_UNAVAILABLE' });
      const serialized = JSON.stringify(userResponse.body);
      expect(serialized).not.toContain('lockedBy');
      expect(serialized).not.toContain(internalErrorMessage);
    },
  );

  describe('POST /api/v1/admin/notifications/:id/retry', () => {
    it('E5-17: retrying a failed notification requeues it with attempts: 0', async () => {
      const app = createAppWithFakeAuth();
      await request(app).get('/api/v1/admin/notifications').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      await seedAdminUser(ADMIN_IDENTITY);

      const alertId = new Types.ObjectId();
      const notification = await NotificationModel.create({
        userId: new Types.ObjectId(),
        alertId,
        channel: 'email',
        to: 'nicolas@example.com',
        status: 'failed',
        dedupeKey: `${alertId.toString()}:1`,
        payload: buildNotificationPayload(),
        attempts: 5,
        maxAttempts: 5,
        lastError: { code: 'SMTP_UNAVAILABLE', message: 'boom', permanent: false },
      });

      const response = await request(app)
        .post(`/api/v1/admin/notifications/${notification._id.toString()}/retry`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({ status: 'pending', attempts: 0, lastError: null });

      const stored = await NotificationModel.findById(notification._id);
      expect(stored?.status).toBe('pending');
      expect(stored?.attempts).toBe(0);
      expect(stored?.lastError).toBeNull();
    });

    // E5-17.
    it('E5-17: retrying a sent notification returns 409, notification unchanged', async () => {
      const app = createAppWithFakeAuth();
      await request(app).get('/api/v1/admin/notifications').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      await seedAdminUser(ADMIN_IDENTITY);

      const alertId = new Types.ObjectId();
      const sentAt = new Date();
      const notification = await NotificationModel.create({
        userId: new Types.ObjectId(),
        alertId,
        channel: 'email',
        to: 'nicolas@example.com',
        status: 'sent',
        dedupeKey: `${alertId.toString()}:1`,
        payload: buildNotificationPayload(),
        attempts: 1,
        sentAt,
        providerMessageId: 'provider-1',
      });

      const response = await request(app)
        .post(`/api/v1/admin/notifications/${notification._id.toString()}/retry`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('CONFLICT');

      const stored = await NotificationModel.findById(notification._id);
      expect(stored?.status).toBe('sent');
      expect(stored?.attempts).toBe(1);
      expect(stored?.providerMessageId).toBe('provider-1');
    });

    it('retrying a missing id returns 404', async () => {
      const app = createAppWithFakeAuth();
      await request(app).get('/api/v1/admin/notifications').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      await seedAdminUser(ADMIN_IDENTITY);

      const missingId = new Types.ObjectId().toString();

      const response = await request(app)
        .post(`/api/v1/admin/notifications/${missingId}/retry`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('rejects a malformed id with 400 VALIDATION_ERROR', async () => {
      const app = createAppWithFakeAuth();
      await request(app).get('/api/v1/admin/notifications').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      await seedAdminUser(ADMIN_IDENTITY);

      const response = await request(app)
        .post('/api/v1/admin/notifications/not-an-id/retry')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /api/v1/admin/notifications/test-email', () => {
    it('sends immediately via the injected mailer and creates no outbox document', async () => {
      const mailer = createFakeMailer();
      const app = createAppWithFakeAuth({ mailer });
      await request(app).get('/api/v1/admin/notifications').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      await seedAdminUser(ADMIN_IDENTITY);

      const response = await request(app)
        .post('/api/v1/admin/notifications/test-email')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

      expect(response.status).toBe(200);
      expect(response.body.data.messageId).toBeDefined();
      expect(mailer.sentMessages).toHaveLength(1);
      expect(mailer.sentMessages[0]?.to).toBe(ADMIN_IDENTITY.email);

      const count = await NotificationModel.countDocuments({});
      expect(count).toBe(0);
    });

    it('surfaces an SMTP failure as 502 with the mailer code in details.reason', async () => {
      const mailer = createFakeMailer({ failNextSends: 1, failWith: 'SMTP_UNAVAILABLE' });
      const app = createAppWithFakeAuth({ mailer });
      await request(app).get('/api/v1/admin/notifications').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      await seedAdminUser(ADMIN_IDENTITY);

      const response = await request(app)
        .post('/api/v1/admin/notifications/test-email')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

      expect(response.status).toBe(502);
      expect(response.body.error.code).toBe('UPSTREAM_ERROR');
      expect(response.body.error.details).toEqual({ reason: 'SMTP_UNAVAILABLE' });

      const count = await NotificationModel.countDocuments({});
      expect(count).toBe(0);
    });

    it('responds 422 UNPROCESSABLE when the admin has no email on file', async () => {
      const mailer = createFakeMailer();
      const app = createAppWithFakeAuth({ mailer });
      await request(app)
        .get('/api/v1/admin/notifications')
        .set('Authorization', `Bearer ${ADMIN_NO_EMAIL_TOKEN}`);
      await seedAdminUser(ADMIN_NO_EMAIL_IDENTITY);

      const response = await request(app)
        .post('/api/v1/admin/notifications/test-email')
        .set('Authorization', `Bearer ${ADMIN_NO_EMAIL_TOKEN}`);

      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('UNPROCESSABLE');
      expect(response.body.error.details).toEqual({ reason: 'NO_EMAIL_ON_FILE' });
      expect(mailer.sentMessages).toHaveLength(0);
    });
  });
});

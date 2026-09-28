import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import pino from 'pino';
import {
  createNotificationUsersRepo,
  createSendNotificationsJob,
} from '../../src/jobs/sendNotifications.js';
import { createNotificationsJobRepo } from '../../src/modules/notifications/notifications.service.js';
import { createJobRunsRepo } from '../../src/modules/job-runs/job-runs.service.js';
import {
  NotificationModel,
  type NotificationStatus,
} from '../../src/modules/notifications/notifications.model.js';
import { UserModel } from '../../src/modules/users/users.model.js';
import { createFakeMailer } from '../../src/integrations/mailer/fakeMailer.js';
import { render } from '../../src/modules/notifications/templates/alert-triggered.js';
import { createFixedClock, type Clock } from '../../src/lib/clock.js';
import { config } from '../../src/config/env.js';
import { ensureCollections } from '../../src/db/ensureCollections.js';
import { clearDatabase, startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';
import type { Mailer } from '../../src/integrations/mailer/mailer.types.js';

const silentLogger = pino({ level: 'silent' });

/**
 * Tests de integración del job `send-notifications` (spec
 * send-notifications-job, tareas 9.11-9.12): corre el job completo contra un
 * Mongo en memoria real, con `NotificationModel`/`UserModel` reales y un
 * `FakeMailer` — el reclamo atómico, el filtro owner-scoped y la
 * recuperación de locks obsoletos son justamente lo que hay que probar, así
 * que no tiene sentido fakearlos.
 */

const T0 = new Date('2026-01-01T00:00:00.000Z');

interface JobOverrides {
  readonly mailer?: Mailer;
  readonly workerId?: string;
  readonly clock?: Clock;
}

function createJob(overrides: JobOverrides = {}) {
  return createSendNotificationsJob({
    notificationsRepo: createNotificationsJobRepo(),
    usersRepo: createNotificationUsersRepo(),
    mailer: overrides.mailer ?? createFakeMailer(),
    jobRunsRepo: createJobRunsRepo(),
    clock: overrides.clock ?? createFixedClock(T0),
    logger: silentLogger,
    workerId: overrides.workerId ?? 'test-worker-1',
  });
}

async function seedUser() {
  return UserModel.create({
    firebaseUid: new Types.ObjectId().toString(),
    email: 'user@example.com',
    emailVerified: true,
    lastSeenAt: T0,
  });
}

interface SeedNotificationInput {
  readonly userId: Types.ObjectId;
  readonly alertId?: Types.ObjectId;
  readonly to?: string;
  readonly status?: NotificationStatus;
  readonly attempts?: number;
  readonly maxAttempts?: number;
  readonly nextAttemptAt?: Date;
  readonly lockedAt?: Date | null;
  readonly lockedBy?: string | null;
  readonly dedupeKey?: string;
}

/** Payload congelado usado por `seedNotification`, reutilizado literalmente en las aserciones (evita esparcir un subdocumento de Mongoose hidratado). */
const DEFAULT_PAYLOAD = {
  coingeckoId: 'bitcoin',
  coinName: 'Bitcoin',
  symbol: 'btc',
  alertType: 'PRICE_BELOW' as const,
  threshold: 50000,
  value: 49000,
  priceUsd: 49000,
  change24hPct: null,
  triggeredAt: T0,
  note: null,
};

async function seedNotification(input: SeedNotificationInput) {
  return NotificationModel.create({
    userId: input.userId,
    alertId: input.alertId ?? new Types.ObjectId(),
    channel: 'email',
    to: input.to ?? 'user@example.com',
    status: input.status ?? 'pending',
    dedupeKey: input.dedupeKey ?? new Types.ObjectId().toString(),
    payload: DEFAULT_PAYLOAD,
    attempts: input.attempts ?? 0,
    maxAttempts: input.maxAttempts ?? 5,
    nextAttemptAt: input.nextAttemptAt ?? T0,
    lockedAt: input.lockedAt ?? null,
    lockedBy: input.lockedBy ?? null,
  });
}

describe('send-notifications (integration)', () => {
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

  // E5-9
  it('E5-9: a pending notification sent successfully via FakeMailer -> sent, with providerMessageId and exactly one captured message', async () => {
    const user = await seedUser();
    const notification = await seedNotification({ userId: user._id, to: user.email! });

    const mailer = createFakeMailer();
    const job = createJob({ mailer });

    const result = await job.run('manual');

    expect(result.status).toBe('success');
    expect(result.stats.sent).toBe(1);
    expect(result.stats.claimed).toBe(1);

    const updated = await NotificationModel.findById(notification._id).orFail();
    expect(updated.status).toBe('sent');
    expect(updated.providerMessageId).toBeTruthy();
    expect(updated.sentAt).not.toBeNull();
    expect(updated.lockedAt).toBeNull();
    expect(updated.lockedBy).toBeNull();

    expect(mailer.sentMessages).toHaveLength(1);
    const expectedSubject = render({
      ...DEFAULT_PAYLOAD,
      alertId: notification.alertId.toString(),
      displayTimezone: config.MAIL_DISPLAY_TIMEZONE,
    }).subject;
    expect(mailer.sentMessages[0]?.subject).toBe(expectedSubject);
    expect(mailer.sentMessages[0]?.to).toBe(user.email);
  });

  // E5-10
  it('E5-10: a transient FakeMailer failure -> pending again with attempts:1 and nextAttemptAt ~1 minute out', async () => {
    const user = await seedUser();
    await seedNotification({ userId: user._id, to: user.email! });

    const mailer = createFakeMailer({ failNextSends: Infinity, failWith: 'SMTP_UNAVAILABLE' });
    const job = createJob({ mailer });

    const result = await job.run('manual');

    expect(result.stats.retried).toBe(1);

    const updated = await NotificationModel.findOne({ userId: user._id }).orFail();
    expect(updated.status).toBe('pending');
    expect(updated.attempts).toBe(1);
    expect(updated.lastError?.permanent).toBe(false);
    expect(updated.lockedAt).toBeNull();
    expect(updated.lockedBy).toBeNull();

    // ~1 minute out (backoffMinutes(1) = 1 * (1 +- 0.1)), tolerancia amplia
    // en lugar de un valor exacto en milisegundos.
    const deltaMs = updated.nextAttemptAt.getTime() - T0.getTime();
    expect(deltaMs).toBeGreaterThanOrEqual(0.85 * 60_000);
    expect(deltaMs).toBeLessThanOrEqual(1.15 * 60_000);
  });

  it('E5-10 (exhaustion): a notification already at attempts:4/maxAttempts:5 that fails transiently once more -> failed', async () => {
    const user = await seedUser();
    await seedNotification({ userId: user._id, to: user.email!, attempts: 4, maxAttempts: 5 });

    const mailer = createFakeMailer({ failNextSends: Infinity, failWith: 'SMTP_UNAVAILABLE' });
    const job = createJob({ mailer });

    const result = await job.run('manual');

    expect(result.stats.failedExhausted).toBe(1);
    expect(result.stats.retried).toBe(0);

    const updated = await NotificationModel.findOne({ userId: user._id }).orFail();
    expect(updated.status).toBe('failed');
    expect(updated.attempts).toBe(5);
    expect(updated.lastError?.permanent).toBe(false);
  });

  // E5-11
  it('E5-11: a permanent MailError (SMTP_REJECTED) -> failed on the first attempt, lastError.permanent:true', async () => {
    const user = await seedUser();
    await seedNotification({ userId: user._id, to: user.email! });

    const mailer = createFakeMailer({ failNextSends: 1, failWith: 'SMTP_REJECTED' });
    const job = createJob({ mailer });

    const result = await job.run('manual');

    expect(result.stats.failedPermanent).toBe(1);
    expect(result.stats.retried).toBe(0);

    const updated = await NotificationModel.findOne({ userId: user._id }).orFail();
    expect(updated.status).toBe('failed');
    expect(updated.attempts).toBe(0); // nunca se toca `attempts` en una falla permanente
    expect(updated.lastError?.permanent).toBe(true);
    expect(updated.lastError?.code).toBe('SMTP_REJECTED');
  });

  // E5-13
  it('E5-13: a stale sending lock is recovered AND sent within the same run', async () => {
    const user = await seedUser();
    const staleLockedAt = new Date(T0.getTime() - 15 * 60_000); // 15 min, > NOTIFY_LOCK_TIMEOUT_MIN (10 por defecto)
    const notification = await seedNotification({
      userId: user._id,
      to: user.email!,
      status: 'sending',
      lockedAt: staleLockedAt,
      lockedBy: 'dead-worker',
    });

    const mailer = createFakeMailer();
    const job = createJob({ mailer });

    const result = await job.run('manual');

    expect(result.stats.recoveredStale).toBe(1);
    expect(result.stats.sent).toBe(1);

    const updated = await NotificationModel.findById(notification._id).orFail();
    expect(updated.status).toBe('sent');
    expect(updated.lockedAt).toBeNull();
    expect(updated.lockedBy).toBeNull();
    expect(mailer.sentMessages).toHaveLength(1);
  });

  it('recovers a stale lock into failed (without resetting nextAttemptAt) when the increment reaches maxAttempts, without sending', async () => {
    const user = await seedUser();
    const staleLockedAt = new Date(T0.getTime() - 15 * 60_000);
    const originalNextAttemptAt = new Date(T0.getTime() - 60 * 60_000);
    const notification = await seedNotification({
      userId: user._id,
      to: user.email!,
      status: 'sending',
      lockedAt: staleLockedAt,
      lockedBy: 'dead-worker',
      attempts: 4,
      maxAttempts: 5,
      nextAttemptAt: originalNextAttemptAt,
    });

    const mailer = createFakeMailer();
    const job = createJob({ mailer });

    const result = await job.run('manual');

    expect(result.stats.recoveredStale).toBe(1);
    expect(result.stats.claimed).toBe(0);
    expect(mailer.sentMessages).toHaveLength(0);

    const updated = await NotificationModel.findById(notification._id).orFail();
    expect(updated.status).toBe('failed');
    expect(updated.attempts).toBe(5);
    expect(updated.lockedAt).toBeNull();
    expect(updated.lockedBy).toBeNull();
    // La recuperación a `failed` nunca resetea `nextAttemptAt`.
    expect(updated.nextAttemptAt.getTime()).toBe(originalNextAttemptAt.getTime());
  });

  // Cancelación por usuario inexistente ("User gone"): sin intento de envío.
  it('cancels a notification whose user no longer exists, without attempting to send', async () => {
    const orphanedUserId = new Types.ObjectId();
    const notification = await seedNotification({ userId: orphanedUserId, to: 'gone@example.com' });

    const mailer = createFakeMailer();
    const job = createJob({ mailer });

    const result = await job.run('manual');

    expect(result.stats.cancelled).toBe(1);
    expect(mailer.sentMessages).toHaveLength(0);

    const updated = await NotificationModel.findById(notification._id).orFail();
    expect(updated.status).toBe('cancelled');
  });

  // E5-12 (tarea 9.12): dos instancias del job con distinto workerId
  // corriendo CONCURRENTEMENTE contra la misma DB, compartiendo un único
  // FakeMailer — ninguna notificación debe quedar sin reclamar ni
  // duplicarse.
  it('E5-12: two concurrent job instances with different workerIds claim all 10 notifications without duplicates', async () => {
    const user = await seedUser();
    const seeded = await Promise.all(
      Array.from({ length: 10 }, () => seedNotification({ userId: user._id, to: user.email! })),
    );

    const mailer = createFakeMailer();
    const jobA = createJob({ mailer, workerId: 'worker-a' });
    const jobB = createJob({ mailer, workerId: 'worker-b' });

    const [resultA, resultB] = await Promise.all([jobA.run('manual'), jobB.run('manual')]);

    expect(mailer.sentMessages).toHaveLength(10);
    expect(resultA.stats.sent + resultB.stats.sent).toBe(10);

    const sentCount = await NotificationModel.countDocuments({ status: 'sent' });
    expect(sentCount).toBe(10);

    const stillClaimable = await NotificationModel.countDocuments({
      _id: { $in: seeded.map((n) => n._id) },
      status: { $in: ['pending', 'sending'] },
    });
    expect(stillClaimable).toBe(0);
  });
});

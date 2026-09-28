import { schedule, validate, type ScheduledTask } from 'node-cron';
import { assertCoinGeckoApiKey, assertSmtpCredentials, config } from './config/env.js';
import { logger } from './lib/logger.js';
import { connectDb, disconnectDb } from './db/connect.js';
import { ensureCollections } from './db/ensureCollections.js';
import { verifyReplicaSet } from './lib/verifyReplicaSet.js';
import { systemClock } from './lib/clock.js';
import { createWorkerId } from './lib/workerId.js';
import { createOverlapGuard } from './lib/overlapGuard.js';
import { createCoinGeckoClient } from './integrations/coingecko/coingecko.client.js';
import { createSmtpMailer } from './integrations/mailer/smtpMailer.js';
import { MailError } from './integrations/mailer/mailer.errors.js';
import { createCoinsRepo } from './modules/coins/coins.service.js';
import { createSnapshotsRepo } from './modules/snapshots/snapshots.service.js';
import { createJobRunsRepo } from './modules/job-runs/job-runs.service.js';
import { createNotificationsJobRepo } from './modules/notifications/notifications.service.js';
import { createPollPricesJob, JOB_NAME as POLL_JOB_NAME } from './jobs/pollPrices.js';
import {
  createNotificationUsersRepo,
  createSendNotificationsJob,
  JOB_NAME as SEND_JOB_NAME,
} from './jobs/sendNotifications.js';
import type { JobTrigger } from './modules/job-runs/job-runs.model.js';

const MINUTE_MS = 60_000;

function delay(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * Punto de entrada del proceso del worker: sin servidor HTTP. Secuencia de
 * arranque y apagado de RF-1.6/RF-1.7. `src/jobs/pollPrices.ts` no tiene
 * idea de que nada de esto (cron, guarda de solapamiento, recuperación de
 * corridas obsoletas) existe — este es el único módulo que sí sabe.
 */
async function main(): Promise<void> {
  assertCoinGeckoApiKey(config, logger);
  assertSmtpCredentials(config, logger);

  // Chequeo no fatal de la configuración SMTP al arrancar (spec mailer,
  // tarea 7.3): un fallo acá se loguea en `error` (nunca `fatal` — jamás
  // debe terminar el proceso) y el worker sigue arrancando con normalidad.
  // Este mismo `mailer` es el que usa después el job `send-notifications`
  // (fase 9) para el envío real.
  const mailer = createSmtpMailer();
  try {
    await mailer.verify();
  } catch (error) {
    const mailError = error instanceof MailError ? error : undefined;
    logger.error(
      {
        err: mailError
          ? { code: mailError.code, message: mailError.message }
          : { message: 'Unknown error verifying SMTP configuration' },
      },
      'SMTP verification failed at startup; continuing without confirmed outgoing mail',
    );
  }

  await connectDb(config.MONGODB_URI, config.MONGODB_DB_NAME, logger, {
    isProduction: config.NODE_ENV === 'production',
  });
  // Spec transactional-mongo: falla rápido si la conexión no soporta
  // transacciones, antes de que nada más toque la base de datos.
  await verifyReplicaSet(logger);
  await ensureCollections(logger);

  const workerId = createWorkerId();
  const jobRunsRepo = createJobRunsRepo();

  // RF-1.6 paso 3: la recuperación de corridas obsoletas corre una vez, antes de programar nada.
  const now = systemClock.now();
  const staleThreshold = new Date(now.getTime() - config.STALE_RUN_THRESHOLD_MIN * MINUTE_MS);
  const recoveredCount = await jobRunsRepo.recoverStaleRuns(staleThreshold, now);
  if (recoveredCount > 0) {
    logger.warn(
      { recoveredCount, staleRunThresholdMin: config.STALE_RUN_THRESHOLD_MIN },
      'Recovered JobRun(s) left running by a previous worker process',
    );
  }

  // Ambas expresiones cron se validan ACA, antes de programar cualquiera de
  // las dos (tarea 9.9): un `SEND_NOTIFICATIONS_CRON` inválido debe fallar
  // el arranque exactamente igual que hoy lo hace un `POLL_PRICES_CRON`
  // inválido, nunca dejar el worker corriendo solo con poll-prices.
  if (!validate(config.POLL_PRICES_CRON)) {
    logger.fatal(
      { cron: config.POLL_PRICES_CRON },
      'Invalid POLL_PRICES_CRON expression; refusing to start.',
    );
    process.exit(1);
    return;
  }

  if (!validate(config.SEND_NOTIFICATIONS_CRON)) {
    logger.fatal(
      { cron: config.SEND_NOTIFICATIONS_CRON },
      'Invalid SEND_NOTIFICATIONS_CRON expression; refusing to start.',
    );
    process.exit(1);
    return;
  }

  const coingecko = createCoinGeckoClient({
    baseUrl: config.COINGECKO_BASE_URL,
    apiKey: config.COINGECKO_API_KEY,
    timeoutMs: config.COINGECKO_TIMEOUT_MS,
    maxRetries: config.COINGECKO_MAX_RETRIES,
    maxIdsPerCall: config.COINGECKO_MAX_IDS_PER_CALL,
    logger,
  });
  const coinsRepo = createCoinsRepo();
  const snapshotsRepo = createSnapshotsRepo();
  const notificationsJobRepo = createNotificationsJobRepo();
  const notificationUsersRepo = createNotificationUsersRepo();

  // El job `send-notifications` (y su guarda) se arman ANTES que
  // `poll-prices`, porque `poll-prices` necesita `sendGuard` ya construida
  // para su hook `triggerSendNotifications` (tarea 6.10, finalmente
  // conectado acá).
  const sendNotificationsJob = createSendNotificationsJob({
    notificationsRepo: notificationsJobRepo,
    usersRepo: notificationUsersRepo,
    mailer,
    jobRunsRepo,
    clock: systemClock,
    logger,
    workerId,
  });

  // Guarda de solapamiento propia de `send-notifications`, independiente de
  // la de `poll-prices` (spec send-notifications-job): un solapamiento de
  // un job nunca bloquea ni se confunde con el del otro.
  const sendGuard = createOverlapGuard<JobTrigger, unknown>({
    run: (trigger) => sendNotificationsJob.run(trigger),
    onOverlap: async (trigger) => {
      logger.warn(
        { jobName: SEND_JOB_NAME, trigger },
        'send-notifications: overlap detected; skipping this tick',
      );
      const overlapAt = systemClock.now();
      await jobRunsRepo.createSkipped({
        jobName: SEND_JOB_NAME,
        trigger,
        skipReason: 'overlap',
        at: overlapAt,
        workerId,
      });
    },
  });

  const job = createPollPricesJob({
    coinsRepo,
    snapshotsRepo,
    jobRunsRepo,
    coingecko,
    clock: systemClock,
    logger,
    workerId,
    // Tarea 6.10, conectada acá: un run de poll-prices que disparó alguna
    // alerta despacha send-notifications de inmediato, a través de su
    // propia guarda de solapamiento, fire-and-forget — nunca esperado por
    // poll-prices (ver el comentario de `triggerSendNotifications` en
    // `CreatePollPricesJobDeps`).
    triggerSendNotifications: () => {
      void sendGuard.runGuarded('manual');
    },
  });

  // RF-1.5: guarda de solapamiento en memoria. Vive acá, no en el job.
  const pollGuard = createOverlapGuard<JobTrigger, unknown>({
    run: (trigger) => job.run(trigger),
    onOverlap: async (trigger) => {
      logger.warn(
        { jobName: POLL_JOB_NAME, trigger },
        'poll-prices: overlap detected; skipping this tick',
      );
      const overlapAt = systemClock.now();
      await jobRunsRepo.createSkipped({
        jobName: POLL_JOB_NAME,
        trigger,
        skipReason: 'overlap',
        at: overlapAt,
        workerId,
      });
    },
  });

  const activeCoinsCount = (await coinsRepo.findActive()).length;

  const pollTask: ScheduledTask = schedule(
    config.POLL_PRICES_CRON,
    () => {
      void pollGuard.runGuarded('schedule');
    },
    { timezone: 'UTC', name: POLL_JOB_NAME },
  );

  const sendTask: ScheduledTask = schedule(
    config.SEND_NOTIFICATIONS_CRON,
    () => {
      void sendGuard.runGuarded('schedule');
    },
    { timezone: 'UTC', name: SEND_JOB_NAME },
  );

  logger.info(
    {
      workerId,
      pollPricesCron: config.POLL_PRICES_CRON,
      sendNotificationsCron: config.SEND_NOTIFICATIONS_CRON,
      activeCoinsCount,
    },
    'Worker started',
  );

  if (config.POLL_PRICES_RUN_ON_START) {
    void pollGuard.runGuarded('startup');
  }

  // --- RF-1.7: apagado ordenado ---
  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    logger.info({ signal }, 'Worker shutdown initiated');

    await pollTask.stop();
    await sendTask.stop();

    // Generalizado a las DOS guardas (tarea 9.9): espera las corridas en
    // curso de `pollGuard` y `sendGuard` en simultáneo contra un único
    // timeout compartido, en lugar del `guard.currentRun()` único de antes.
    const runsInProgress = [pollGuard.currentRun(), sendGuard.currentRun()].filter(
      (run): run is Promise<unknown> => run !== null,
    );

    if (runsInProgress.length > 0) {
      const { promise: timeoutPromise, cancel } = delay(config.WORKER_SHUTDOWN_TIMEOUT_MS);
      await Promise.race([Promise.all(runsInProgress), timeoutPromise]);
      cancel();
    }

    if (pollGuard.isRunning() || sendGuard.isRunning()) {
      logger.error(
        { timeoutMs: config.WORKER_SHUTDOWN_TIMEOUT_MS },
        'Worker shutdown timed out waiting for an in-progress run; exiting without touching its JobRun document',
      );
      process.exit(1);
      return;
    }

    await disconnectDb();
    logger.info('Worker shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection in worker');
  });

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception in worker');
  });
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Fatal error during worker startup');
  process.exit(1);
});

import mongoose from 'mongoose';
import { assertCoinGeckoApiKey, assertSmtpCredentials, config } from './config/env.js';
import { logger } from './lib/logger.js';
import { connectDb, disconnectDb } from './db/connect.js';
import { ensureCollections } from './db/ensureCollections.js';
import { verifyReplicaSet } from './lib/verifyReplicaSet.js';
import { systemClock } from './lib/clock.js';
import { createWorkerId } from './lib/workerId.js';
import { createCoinGeckoClient } from './integrations/coingecko/coingecko.client.js';
import { createSmtpMailer } from './integrations/mailer/smtpMailer.js';
import { MailError } from './integrations/mailer/mailer.errors.js';
import { createCoinsRepo } from './modules/coins/coins.service.js';
import { createSnapshotsRepo } from './modules/snapshots/snapshots.service.js';
import { createJobRunsRepo } from './modules/job-runs/job-runs.service.js';
import { createNotificationsJobRepo } from './modules/notifications/notifications.service.js';
import { createPollPricesJob } from './jobs/pollPrices.js';
import { createNotificationUsersRepo, createSendNotificationsJob } from './jobs/sendNotifications.js';
import { createMaintenanceJob } from './jobs/maintenance.js';
import { createAgenda, JOB_NAMES } from './scheduler/agenda.js';
import {
  defineJobs,
  registerRecurringJobs,
  removeObsoleteJobs,
  type JobHandlers,
} from './scheduler/definitions.js';
import {
  createMaintenanceAdapter,
  createPollPricesAdapter,
  createSendNotificationsAdapter,
} from './scheduler/adapters.js';
import { registerRetryPolicy } from './scheduler/retryPolicy.js';
import { registerObservability } from './scheduler/observability.js';

const MINUTE_MS = 60_000;

/**
 * Punto de entrada del proceso del worker: sin servidor HTTP. Desde la fase
 * 6, la programación vive en Agenda (colección `agenda_jobs`), no en
 * `node-cron` ni en un flag en memoria — este es el ÚNICO proceso que
 * construye Agenda con `role: 'worker'`, define los tres jobs, los registra
 * como recurrentes y llama a `agenda.start()`. `src/jobs/*.ts` no tiene idea
 * de que nada de esto existe; ese es el punto de mantenerlos scheduler-
 * agnósticos (design.md).
 */
async function main(): Promise<void> {
  assertCoinGeckoApiKey(config, logger);
  assertSmtpCredentials(config, logger);

  // Chequeo no fatal de la configuración SMTP al arrancar (spec mailer,
  // tarea 7.3): un fallo acá se loguea en `error` (nunca `fatal` — jamás
  // debe terminar el proceso) y el worker sigue arrancando con normalidad.
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
    maxPoolSize: config.MONGODB_MAX_POOL_SIZE,
  });
  // Spec transactional-mongo: falla rápido si la conexión no soporta
  // transacciones, antes de que nada más toque la base de datos.
  await verifyReplicaSet(logger);
  await ensureCollections(logger);

  const db = mongoose.connection.db;
  if (!db) {
    logger.fatal('MongoDB connection has no db handle after connectDb(); refusing to start.');
    process.exit(1);
    return;
  }

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

  const agenda = createAgenda({ db, role: 'worker' });
  await agenda.ready;

  const sendNotificationsJob = createSendNotificationsJob({
    notificationsRepo: notificationsJobRepo,
    usersRepo: notificationUsersRepo,
    mailer,
    jobRunsRepo,
    clock: systemClock,
    logger,
    workerId,
  });

  const pollPricesJob = createPollPricesJob({
    coinsRepo,
    snapshotsRepo,
    jobRunsRepo,
    coingecko,
    clock: systemClock,
    logger,
    workerId,
    // Tarea 6.10 (etapa 5), ahora sobre Agenda: un run de poll-prices que
    // disparó alguna alerta encola send-notifications de inmediato como un
    // job puntual, fire-and-forget — nunca esperado por poll-prices. No
    // necesita lease (design.md: su reclamo atómico por notificación ya lo
    // hace seguro de correr junto al recurrente).
    triggerSendNotifications: () => {
      void agenda.now(JOB_NAMES.SEND_NOTIFICATIONS, { trigger: 'agenda' });
    },
  });

  const maintenanceJob = createMaintenanceJob({
    jobRunsRepo,
    db,
    clock: systemClock,
    logger,
    workerId,
  });

  const handlers: JobHandlers = {
    [JOB_NAMES.POLL_PRICES]: createPollPricesAdapter({
      job: pollPricesJob,
      jobRunsRepo,
      clock: systemClock,
      workerId,
      leaseTtlMs: config.POLL_LOCK_TTL_MS,
      logger,
    }),
    [JOB_NAMES.SEND_NOTIFICATIONS]: createSendNotificationsAdapter({
      job: sendNotificationsJob,
      jobRunsRepo,
    }),
    [JOB_NAMES.MAINTENANCE]: createMaintenanceAdapter({
      job: maintenanceJob,
      jobRunsRepo,
    }),
  };

  defineJobs(agenda, handlers);
  registerObservability(agenda, { logger });
  registerRetryPolicy(agenda, {
    db,
    clock: systemClock,
    logger,
    maxRetries: config.POLL_MAX_JOB_RETRIES,
  });

  await removeObsoleteJobs(agenda);
  const recurringJobs = await registerRecurringJobs(agenda, db);

  // Agenda nunca rechaza `every()` por una expresión cron inválida — atrapa
  // el error de `cron-parser` internamente y deja `nextRunAt: null` (ver el
  // comentario de `registerRecurringJobs`). Reemplaza al `cron.validate()`
  // de node-cron: un `nextRunAt` nulo es la señal de que la expresión
  // configurada es inválida, y el worker debe fallar rápido igual que antes.
  for (const [jobName, job] of recurringJobs) {
    if (job.attrs.nextRunAt === null) {
      logger.fatal(
        { jobName, cron: job.attrs.repeatInterval },
        'Invalid cron expression; refusing to start.',
      );
      process.exit(1);
      return;
    }
  }

  await agenda.start();

  // Reemplaza la invocación directa de RF-1.8: encola un job puntual con
  // `trigger: "startup"` en lugar de correr el job directamente, así el
  // lease decide si realmente se ejecuta (spec worker-process: "Startup run
  // goes through the lease").
  if (config.POLL_PRICES_RUN_ON_START) {
    void agenda.now(JOB_NAMES.POLL_PRICES, { trigger: 'startup' });
  }

  logger.info(
    {
      workerId,
      pollPricesCron: config.POLL_PRICES_CRON,
      sendNotificationsCron: config.SEND_NOTIFICATIONS_CRON,
      maintenanceCron: config.MAINTENANCE_CRON,
    },
    'Worker started',
  );

  // --- Apagado ordenado (spec worker-process: "Ordered worker shutdown") ---
  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    logger.info({ signal }, 'Worker shutdown initiated');

    const result = await agenda.drain(config.WORKER_SHUTDOWN_TIMEOUT_MS);

    if (result.timedOut) {
      logger.warn(
        { remaining: result.running, timeoutMs: config.WORKER_SHUTDOWN_TIMEOUT_MS },
        'Worker shutdown timed out waiting for in-progress jobs; releasing their locks for another worker',
      );
      await agenda.stop();
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

import { Types } from 'mongoose';
import type { Logger } from 'pino';
import { config } from '../config/env.js';
import type { Clock } from '../lib/clock.js';
import { maskEmail } from '../lib/maskEmail.js';
import {
  EMPTY_JOB_RUN_STATS,
  type JobRunError,
  type JobRunsRepo,
  type JobRunStats,
} from '../modules/job-runs/job-runs.service.js';
import type { JobSkipReason, JobStatus, JobTrigger } from '../modules/job-runs/job-runs.model.js';
import type {
  ClaimedNotification,
  NotificationsJobRepo,
} from '../modules/notifications/notifications.service.js';
import { render } from '../modules/notifications/templates/alert-triggered.js';
import { UserModel } from '../modules/users/users.model.js';
import { MailError } from '../integrations/mailer/mailer.errors.js';
import type { Mailer } from '../integrations/mailer/mailer.types.js';
import { backoffMinutes, type RandomFn } from './notifyBackoff.js';
import type { JobRunResult } from './pollPrices.js';

/**
 * Job `send-notifications` (spec send-notifications-job): recuperación de
 * locks obsoletos, reclamo atómico y envío secuencial (nunca en paralelo)
 * de las notificaciones `pending` de la colección `notifications`, con
 * backoff con jitter, tope de intentos y tope de envíos por minuto. Corre
 * con su propio cron y su propia guarda de solapamiento en `worker.ts`,
 * independiente de `poll-prices` — y es también el destino del hook
 * `triggerSendNotifications` que dispara `poll-prices` cuando una corrida
 * suya generó al menos una notificación nueva.
 */

export const JOB_NAME = 'send-notifications';

const MINUTE_MS = 60_000;

/**
 * Lookup de existencia de un usuario, la única pieza de `users` que
 * necesita este job (spec send-notifications-job, paso "User gone"): un
 * simple chequeo de existencia alcanza, no hace falta el email completo ni
 * el resto del perfil. Se inyecta en `createSendNotificationsJob` para que
 * los tests puedan fakearlo — mismo criterio de inyección que
 * `CoinsRepo`/`NotificationsJobRepo`.
 */
export interface NotificationUsersRepo {
  exists(userId: Types.ObjectId): Promise<boolean>;
}

/** Crea el lookup de existencia de usuarios respaldado por Mongoose. Función factory simple, sin contenedor de DI. */
export function createNotificationUsersRepo(): NotificationUsersRepo {
  return {
    async exists(userId) {
      const found = await UserModel.exists({ _id: userId }).exec();
      return found !== null;
    },
  };
}

export interface CreateSendNotificationsJobDeps {
  readonly notificationsRepo: NotificationsJobRepo;
  readonly usersRepo: NotificationUsersRepo;
  readonly mailer: Mailer;
  readonly jobRunsRepo: JobRunsRepo;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly workerId: string;
  /** Inyectable para tests: por defecto `Math.random`, para poder fijar el jitter del backoff de forma determinística. */
  readonly random?: RandomFn;
}

export interface SendNotificationsJob {
  run(trigger: JobTrigger): Promise<JobRunResult>;
}

function toJobRunError(caught: unknown): JobRunError {
  if (caught instanceof MailError) {
    return { code: caught.code, message: caught.message };
  }
  if (caught instanceof Error) {
    return { code: 'INTERNAL', message: caught.message };
  }
  return { code: 'INTERNAL', message: 'Unknown error' };
}

/** Cuenta total de notificaciones efectivamente PROCESADAS en esta corrida (spec: el tope por minuto cuenta esto, nunca lo reclamado). */
function processedCount(stats: JobRunStats): number {
  return (
    stats.sent + stats.failedPermanent + stats.retried + stats.failedExhausted + stats.cancelled
  );
}

/**
 * Factory del job `send-notifications` (spec send-notifications-job).
 * Refleja la misma forma/convenciones que `createPollPricesJob`
 * (`src/jobs/pollPrices.ts`): mismo contrato `run(trigger):
 * Promise<JobRunResult>`, mismo cierre con `closeRun`, mismo
 * never-throws/always-closes-the-run, mismo `toJobRunError`. `run()` no
 * tiene idea de ningún scheduler, guarda de solapamiento o cron —
 * `worker.ts` es el único módulo que sabe de eso.
 */
export function createSendNotificationsJob(
  deps: CreateSendNotificationsJobDeps,
): SendNotificationsJob {
  const { notificationsRepo, usersRepo, mailer, jobRunsRepo, clock, logger, workerId } = deps;
  const random = deps.random ?? Math.random;

  /**
   * Procesa UNA notificación ya reclamada (spec, "Per notification, once
   * claimed"): cancela si el usuario ya no existe, o renderiza y envía,
   * ramificando sobre el resultado. Muta `stats` in-place — mismo patrón
   * que `handleTrigger`/`stats` en `alertEvaluation.ts`. Cada escritura
   * post-reclamo usa el mismo filtro owner-scoped
   * (`NotificationsJobRepo`); si no matchea nada (otro proceso ya recuperó
   * el lock obsoleto de esta notificación y la reclamó de nuevo), se loguea
   * y se sigue — nunca se trata como un error del job.
   */
  async function processOne(
    notification: ClaimedNotification,
    stats: JobRunStats,
    runId: Types.ObjectId,
  ): Promise<void> {
    const logCtx = {
      runId: runId.toString(),
      notificationId: notification.id.toString(),
      to: maskEmail(notification.to),
    };

    const userExists = await usersRepo.exists(notification.userId);
    if (!userExists) {
      const matched = await notificationsRepo.markCancelled(notification.id, workerId);
      if (!matched) {
        logger.warn(logCtx, 'send-notifications: markCancelled matched no document (owner-scoped race); moving on');
      }
      stats.cancelled += 1;
      logger.info(logCtx, 'send-notifications: cancelled (user no longer exists)');
      return;
    }

    const { subject, text, html } = render({
      ...notification.payload,
      alertId: notification.alertId.toString(),
      displayTimezone: config.MAIL_DISPLAY_TIMEZONE,
    });

    try {
      const result = await mailer.send({ to: notification.to, subject, text, html });
      const matched = await notificationsRepo.markSent(
        notification.id,
        workerId,
        clock.now(),
        result.messageId,
      );
      if (!matched) {
        logger.warn(logCtx, 'send-notifications: markSent matched no document (owner-scoped race); moving on');
      }
      stats.sent += 1;
      logger.info(logCtx, 'send-notifications: sent');
    } catch (caught) {
      if (caught instanceof MailError && caught.permanent) {
        const matched = await notificationsRepo.markFailedPermanent(notification.id, workerId, {
          code: caught.code,
          message: caught.message,
          permanent: true,
        });
        if (!matched) {
          logger.warn(logCtx, 'send-notifications: markFailedPermanent matched no document (owner-scoped race); moving on');
        }
        stats.failedPermanent += 1;
        logger.warn({ ...logCtx, code: caught.code }, 'send-notifications: permanent failure, no retry');
        return;
      }

      // Transitorio: un MailError con permanent:false, o cualquier otro
      // error inesperado lanzado por mailer.send (spec: "treat an
      // unexpected error the same as transient").
      const code = caught instanceof MailError ? caught.code : 'INTERNAL';
      const message =
        caught instanceof MailError
          ? caught.message
          : caught instanceof Error
            ? caught.message
            : 'Unknown error sending notification';
      const newAttempts = notification.attempts + 1;
      const lastError = { code, message, permanent: false };

      if (newAttempts >= notification.maxAttempts) {
        const matched = await notificationsRepo.markFailedExhausted(
          notification.id,
          workerId,
          newAttempts,
          lastError,
        );
        if (!matched) {
          logger.warn(logCtx, 'send-notifications: markFailedExhausted matched no document (owner-scoped race); moving on');
        }
        stats.failedExhausted += 1;
        logger.warn({ ...logCtx, code, newAttempts }, 'send-notifications: retries exhausted');
      } else {
        const nextAttemptAt = new Date(
          clock.now().getTime() + backoffMinutes(newAttempts, random) * MINUTE_MS,
        );
        const matched = await notificationsRepo.markRetry(
          notification.id,
          workerId,
          newAttempts,
          nextAttemptAt,
          lastError,
        );
        if (!matched) {
          logger.warn(logCtx, 'send-notifications: markRetry matched no document (owner-scoped race); moving on');
        }
        stats.retried += 1;
        logger.warn({ ...logCtx, code, newAttempts, nextAttemptAt }, 'send-notifications: transient failure, retry scheduled');
      }
    }
  }

  return {
    async run(trigger) {
      const startedAt = clock.now();

      let runId: Types.ObjectId;
      try {
        runId = await jobRunsRepo.createRunning({
          jobName: JOB_NAME,
          trigger,
          startedAt,
          workerId,
        });
      } catch (caught) {
        // Mismo caso límite que `pollPrices.ts`: ni siquiera se pudo abrir
        // un documento JobRun. `run()` igual nunca lanza una excepción.
        logger.error(
          { err: caught, jobName: JOB_NAME, trigger },
          'send-notifications: failed to create the JobRun document',
        );
        const finishedAt = clock.now();
        return {
          runId: new Types.ObjectId(),
          status: 'failed',
          startedAt,
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          stats: { ...EMPTY_JOB_RUN_STATS },
          error: toJobRunError(caught),
        };
      }

      logger.info(
        { runId: runId.toString(), jobName: JOB_NAME, trigger },
        'send-notifications run started',
      );

      async function closeRun(
        status: Exclude<JobStatus, 'running'>,
        stats: JobRunStats,
        error: JobRunError | null,
        skipReason?: JobSkipReason,
      ): Promise<JobRunResult> {
        const finishedAt = clock.now();
        const durationMs = finishedAt.getTime() - startedAt.getTime();

        try {
          await jobRunsRepo.closeRun(runId, {
            status,
            finishedAt,
            durationMs,
            stats,
            error,
            skipReason,
          });
        } catch (persistError) {
          logger.error(
            { runId: runId.toString(), err: persistError },
            'send-notifications: failed to persist the run closure; it will be recovered as stale on next startup',
          );
        }

        logger.info(
          { runId: runId.toString(), jobName: JOB_NAME, trigger, status, durationMs, stats },
          'send-notifications run finished',
        );

        return { runId, status, skipReason, startedAt, finishedAt, durationMs, stats, error };
      }

      try {
        // Paso 1 (spec, corre PRIMERO en toda corrida): recuperación de
        // locks obsoletos.
        const staleThreshold = new Date(
          startedAt.getTime() - config.NOTIFY_LOCK_TIMEOUT_MIN * MINUTE_MS,
        );
        const recoveredStale = await notificationsRepo.recoverStaleLocks(staleThreshold, startedAt);

        const stats: JobRunStats = { ...EMPTY_JOB_RUN_STATS, recoveredStale };

        // Paso 2: bucle de reclamo atómico, intercalado uno a la vez con el
        // envío (detalle crítico de la spec): reclamar TODO y recién
        // después enviar TODO dejaría notificaciones sobre-reclamadas
        // trabadas en `sending` en cuanto se llega al tope por minuto.
        while (stats.claimed < config.NOTIFY_BATCH_SIZE) {
          const notification = await notificationsRepo.claimNext(clock.now(), workerId);
          if (!notification) {
            break;
          }

          stats.claimed += 1;
          await processOne(notification, stats, runId);

          if (processedCount(stats) >= config.MAIL_MAX_PER_MINUTE) {
            break;
          }
        }

        return await closeRun('success', stats, null);
      } catch (caught) {
        logger.error(
          { runId: runId.toString(), err: caught },
          'send-notifications run failed with an unexpected error',
        );
        return await closeRun('failed', { ...EMPTY_JOB_RUN_STATS }, toJobRunError(caught));
      }
    },
  };
}

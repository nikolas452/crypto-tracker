import { MailError, type MailErrorCode } from './mailer.errors.js';
import type { Mailer, MailMessage, SendResult } from './mailer.types.js';

/**
 * Implementación falsa de `Mailer`, usada exclusivamente por tests (spec
 * mailer). No hace ninguna conexión de red: registra en memoria cada
 * mensaje enviado y puede configurarse para fallar los próximos N envíos (o
 * siempre) con un `MailError` transitorio o permanente. Mismo espíritu que
 * `createFakeTokenVerifier`/`FakeTokenVerifierOptions`.
 */

/** Fila de la tabla de clasificación de la spec mailer que `send()` puede lanzar. */
export type FakeMailerFailure = 'SMTP_REJECTED' | 'SMTP_UNAVAILABLE';

function errorForFailure(failure: FakeMailerFailure): MailError {
  const code: MailErrorCode = failure;
  const permanent = failure === 'SMTP_REJECTED';
  return new MailError(code, permanent, `Configured fake failure: ${failure}`);
}

export interface FakeMailerOptions {
  /**
   * Cuántos de los próximos `send()` deben fallar con `failWith` antes de
   * empezar a resolver normalmente. `Infinity` hace que todos los envíos
   * fallen siempre. Por defecto 0 (nunca falla).
   */
  readonly failNextSends?: number;
  /** Tipo de fallo a lanzar mientras queden envíos configurados para fallar. Requerido si `failNextSends` > 0. */
  readonly failWith?: FakeMailerFailure;
  /** Si `verify()` debe fallar (siempre) con este tipo de fallo. Por defecto, `verify()` resuelve sin más. */
  readonly verifyFailsWith?: FakeMailerFailure;
}

/** Copia inmutable de un mensaje enviado, tal como se le pasó a `send()`. */
export type SentMessage = MailMessage;

/** Superficie extra de `FakeMailer` sobre el contrato `Mailer`, para que los tests puedan inspeccionar lo enviado. */
export interface FakeMailer extends Mailer {
  readonly sentMessages: readonly SentMessage[];
}

export function createFakeMailer(options: FakeMailerOptions = {}): FakeMailer {
  const sentMessages: SentMessage[] = [];
  let remainingFailures = options.failNextSends ?? 0;
  const failWith = options.failWith;

  return {
    sentMessages,

    async send(msg: MailMessage): Promise<SendResult> {
      if (remainingFailures > 0) {
        if (Number.isFinite(remainingFailures)) {
          remainingFailures -= 1;
        }
        if (!failWith) {
          throw new Error('createFakeMailer: failNextSends configured without failWith');
        }
        throw errorForFailure(failWith);
      }

      sentMessages.push(msg);
      return { messageId: `fake-${sentMessages.length}` };
    },

    async verify(): Promise<void> {
      if (options.verifyFailsWith) {
        throw errorForFailure(options.verifyFailsWith);
      }
    },
  };
}

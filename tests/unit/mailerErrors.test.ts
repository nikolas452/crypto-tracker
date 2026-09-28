import { describe, expect, it } from 'vitest';
import { classifyMailError, MailError } from '../../src/integrations/mailer/mailer.errors.js';

/**
 * Tests unitarios de la clasificación de errores de la integración de
 * correo (`src/integrations/mailer/mailer.errors.ts`, spec mailer, tarea
 * 7.5): la tabla fija `responseCode` -> `code`/`permanent`, y que ningún
 * dato adyacente a las credenciales SMTP termine en el mensaje del
 * `MailError` resultante.
 */

describe('classifyMailError', () => {
  it.each([
    [500, 'SMTP_REJECTED', true],
    [599, 'SMTP_REJECTED', true],
    [421, 'SMTP_UNAVAILABLE', false],
    [451, 'SMTP_UNAVAILABLE', false],
    [400, 'SMTP_UNAVAILABLE', false],
    [499, 'SMTP_UNAVAILABLE', false],
  ] as const)(
    'classifies a responseCode of %i as %s (permanent: %s)',
    (responseCode, expectedCode, expectedPermanent) => {
      const error = classifyMailError({ responseCode });

      expect(error).toBeInstanceOf(MailError);
      expect(error.code).toBe(expectedCode);
      expect(error.permanent).toBe(expectedPermanent);
    },
  );

  it('classifies an error with no responseCode at all (connection failure/timeout) as transient SMTP_UNAVAILABLE', () => {
    const connectionError = Object.assign(new Error('connect ETIMEDOUT 1.2.3.4:587'), {
      code: 'ETIMEDOUT',
    });

    const error = classifyMailError(connectionError);

    expect(error.code).toBe('SMTP_UNAVAILABLE');
    expect(error.permanent).toBe(false);
  });

  it('classifies a plain connection-refused error shape as transient SMTP_UNAVAILABLE', () => {
    const connectionError = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1025'), {
      code: 'ECONNREFUSED',
    });

    const error = classifyMailError(connectionError);

    expect(error.code).toBe('SMTP_UNAVAILABLE');
    expect(error.permanent).toBe(false);
  });

  it('classifies a socket error shape as transient SMTP_UNAVAILABLE', () => {
    const socketError = Object.assign(new Error('Unexpected socket close'), { code: 'ESOCKET' });

    const error = classifyMailError(socketError);

    expect(error.code).toBe('SMTP_UNAVAILABLE');
    expect(error.permanent).toBe(false);
  });

  it('classifies a non-object/undefined failure as transient SMTP_UNAVAILABLE', () => {
    expect(classifyMailError(undefined).code).toBe('SMTP_UNAVAILABLE');
    expect(classifyMailError('boom').code).toBe('SMTP_UNAVAILABLE');
  });

  it('never echoes the underlying error message (which may carry SMTP AUTH command text) into MailError.message', () => {
    const secretUser = 'super-secret-user@example.com';
    const secretPass = 'super-secret-password';
    const rejectedByServer = Object.assign(
      new Error(
        `Invalid login: 535 5.7.8 Authentication failed for AUTH LOGIN ${secretUser} ${secretPass}`,
      ),
      { responseCode: 535 },
    );

    const error = classifyMailError(rejectedByServer);

    expect(error.message).not.toContain(secretUser);
    expect(error.message).not.toContain(secretPass);
    expect(error.message).not.toContain('AUTH LOGIN');
  });

  it('sets the original error as the cause without folding it into the message', () => {
    const original = new Error('some transport detail');
    const error = classifyMailError(original);

    expect(error.cause).toBe(original);
  });
});

/**
 * Error interno de la integración de correo y la clasificación de fallos de
 * envío/verificación de nodemailer (spec mailer). `MailError` NO extiende el
 * `AppError` del proyecto (`src/lib/errors.ts`): es un error de capa de
 * integración — nada acá habla directamente con Express — que cada caller
 * (por ejemplo el job de envío de notificaciones, fase 9) traduce a lo que
 * necesite.
 */

export type MailErrorCode = 'SMTP_REJECTED' | 'SMTP_UNAVAILABLE';

export interface MailErrorOptions {
  readonly cause?: unknown;
}

export class MailError extends Error {
  readonly code: MailErrorCode;
  readonly permanent: boolean;

  constructor(code: MailErrorCode, permanent: boolean, message: string, options: MailErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'MailError';
    this.code = code;
    this.permanent = permanent;
  }
}

/**
 * Forma mínima del error que lanza el transporte SMTP de nodemailer que nos
 * interesa para clasificar: `responseCode` (número) está presente cuando
 * hubo una respuesta real del servidor SMTP; ausente cuando el fallo es de
 * conexión o timeout antes de recibir cualquier respuesta (por ejemplo
 * `ETIMEDOUT`, `ECONNREFUSED`, `ESOCKET`, expuestos en `code`).
 */
interface SmtpLikeError {
  readonly responseCode?: number;
}

function isSmtpLikeError(error: unknown): error is SmtpLikeError {
  return typeof error === 'object' && error !== null;
}

/**
 * Clasifica un fallo de nodemailer en un {@link MailError} según la tabla
 * fija de la spec mailer:
 *
 * - `responseCode` presente y en `[500, 599]` -> permanente, `SMTP_REJECTED`.
 * - cualquier otro caso (sin `responseCode` en absoluto -por ejemplo un
 *   error de conexión/timeout-, o un `responseCode` 4xx -incluidos 421/451,
 *   que algunos proveedores usan para limitar tasa-) -> transitorio,
 *   `SMTP_UNAVAILABLE`.
 *
 * El mensaje del `MailError` resultante se arma solo a partir del `code`
 * clasificado, nunca del `.message` del error original: nodemailer a veces
 * incluye ahí el intercambio de comandos SMTP completo (`AUTH LOGIN` y
 * similares), lo que podría filtrar datos adyacentes a las credenciales.
 */
export function classifyMailError(error: unknown): MailError {
  const responseCode = isSmtpLikeError(error) ? error.responseCode : undefined;

  if (typeof responseCode === 'number' && responseCode >= 500 && responseCode <= 599) {
    return new MailError(
      'SMTP_REJECTED',
      true,
      `SMTP server permanently rejected the message (response code ${responseCode})`,
      { cause: error },
    );
  }

  return new MailError(
    'SMTP_UNAVAILABLE',
    false,
    'SMTP server unavailable, connection failed, or temporarily rejected the message',
    { cause: error },
  );
}

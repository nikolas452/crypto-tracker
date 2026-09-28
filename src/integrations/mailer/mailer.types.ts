/**
 * Tipos compartidos de la integración de correo saliente: el contrato
 * `Mailer` que reciben inyectado los jobs/servicios que necesitan enviar
 * correo (nunca el transporte concreto), y la forma del mensaje a enviar.
 */

/** Mensaje a enviar. `from` no forma parte de este contrato: lo agrega la implementación (`SmtpMailer`) a partir de `MAIL_FROM`. */
export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export interface SendResult {
  readonly messageId: string;
}

/**
 * Contrato `Mailer` (spec mailer). La implementación real sobre SMTP vive en
 * `smtpMailer.ts`; la implementación falsa para tests vive en
 * `fakeMailer.ts`.
 */
export interface Mailer {
  send(msg: MailMessage): Promise<SendResult>;
  verify(): Promise<void>;
}

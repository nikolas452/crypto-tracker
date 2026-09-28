import nodemailer from 'nodemailer';
import type { Config } from '../../config/env.js';
import { config as defaultConfig } from '../../config/env.js';
import { classifyMailError } from './mailer.errors.js';
import type { Mailer, MailMessage, SendResult } from './mailer.types.js';

/**
 * Implementación real de `Mailer` sobre el transporte SMTP de nodemailer
 * (spec mailer). Se construye una sola vez (`worker.ts`); `MAIL_FROM` se
 * agrega acá al llamar a `sendMail`, nunca lo pasa el caller: el contrato
 * `Mailer.send()` (`mailer.types.ts`) no expone `from`.
 */

const SMTPS_PORT = 465;
const CONNECTION_TIMEOUT_MS = 10000;
const SOCKET_TIMEOUT_MS = 10000;

export type SmtpMailerConfig = Pick<
  Config,
  'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_USER' | 'SMTP_PASS' | 'MAIL_FROM'
>;

/**
 * Crea el `Mailer` real. Config-inyectado (mismo patrón que
 * `createCoinGeckoClient`), con el `config` real como valor por defecto.
 *
 * Mailpit (desarrollo local) no exige autenticación: `auth` queda
 * `undefined` (nunca un objeto con `user`/`pass` en string vacío) cuando
 * `SMTP_USER`/`SMTP_PASS` están ambos ausentes.
 */
export function createSmtpMailer(cfg: SmtpMailerConfig = defaultConfig): Mailer {
  const auth =
    cfg.SMTP_USER && cfg.SMTP_PASS ? { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS } : undefined;

  const transporter = nodemailer.createTransport({
    host: cfg.SMTP_HOST,
    port: cfg.SMTP_PORT,
    secure: cfg.SMTP_PORT === SMTPS_PORT,
    auth,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
  });

  return {
    async send(msg: MailMessage): Promise<SendResult> {
      try {
        const info = await transporter.sendMail({
          from: cfg.MAIL_FROM,
          to: msg.to,
          subject: msg.subject,
          text: msg.text,
          html: msg.html,
        });
        return { messageId: info.messageId };
      } catch (error) {
        throw classifyMailError(error);
      }
    },

    async verify(): Promise<void> {
      try {
        await transporter.verify();
      } catch (error) {
        throw classifyMailError(error);
      }
    },
  };
}

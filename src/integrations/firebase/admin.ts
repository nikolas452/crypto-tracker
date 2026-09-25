import { cert, getApps, initializeApp, type App, type AppOptions } from 'firebase-admin/app';
import type { Logger } from 'pino';
import { config, type Config } from '../../config/env.js';
import { logger as defaultLogger } from '../../lib/logger.js';

/**
 * Inicialización única de la app de Firebase Admin (spec
 * firebase-admin-init). Usa los entry points modulares `firebase-admin/app`
 * y `firebase-admin/auth`, reutiliza la app existente si ya hay una
 * inicializada en el proceso, normaliza el newline escapado de
 * `FIREBASE_PRIVATE_KEY`, y aplica la guarda dura contra usar el emulador de
 * Auth en producción.
 */

/**
 * Reemplaza las secuencias `\n` literales por saltos de línea reales, para
 * que `FIREBASE_PRIVATE_KEY` pueda cargarse desde una variable de entorno de
 * una sola línea. Función pura, sin efectos secundarios — testeable
 * unitariamente sin tocar `firebase-admin`.
 */
export function normalizePrivateKey(rawPrivateKey: string): string {
  return rawPrivateKey.replace(/\\n/g, '\n');
}

/**
 * Inicializa (o reutiliza) la app de Firebase Admin del proceso.
 *
 * - Si `FIREBASE_AUTH_EMULATOR_HOST` está definida y `NODE_ENV=production`,
 *   termina el proceso con código 1 antes de inicializar nada: un proceso de
 *   producción apuntado a un emulador aceptaría tokens sin firmar (E3-13).
 * - Si está definida fuera de producción, loguea un `warn` anunciando su uso
 *   (el propio SDK de `firebase-admin` toma el host del emulador de la
 *   variable de entorno homónima, ya presente en `process.env` porque el
 *   proceso la heredó de su entorno real).
 * - Cuando las tres credenciales de cuenta de servicio están presentes, se
 *   arma un `Credential` explícito con `cert()`. Si no (flujo de emulador sin
 *   cuenta de servicio real), se inicializa solo con `projectId`, que es
 *   suficiente para hablar con el emulador.
 */
export function initializeFirebaseAdmin(cfg: Config = config, log: Logger = defaultLogger): App {
  const existingApps = getApps();
  if (existingApps.length > 0) {
    return existingApps[0]!;
  }

  const isProduction = cfg.NODE_ENV === 'production';

  if (cfg.FIREBASE_AUTH_EMULATOR_HOST) {
    if (isProduction) {
      log.fatal(
        { emulatorHost: cfg.FIREBASE_AUTH_EMULATOR_HOST },
        'FIREBASE_AUTH_EMULATOR_HOST is set while NODE_ENV=production; refusing to start against an emulator in production.',
      );
      process.exit(1);
    }

    log.warn(
      { emulatorHost: cfg.FIREBASE_AUTH_EMULATOR_HOST },
      'Using the Firebase Auth emulator instead of a real Firebase project.',
    );
  }

  const hasFullServiceAccount = Boolean(
    cfg.FIREBASE_PROJECT_ID && cfg.FIREBASE_CLIENT_EMAIL && cfg.FIREBASE_PRIVATE_KEY,
  );

  const appOptions: AppOptions = {
    ...(cfg.FIREBASE_PROJECT_ID ? { projectId: cfg.FIREBASE_PROJECT_ID } : {}),
    ...(hasFullServiceAccount
      ? {
          credential: cert({
            projectId: cfg.FIREBASE_PROJECT_ID,
            clientEmail: cfg.FIREBASE_CLIENT_EMAIL,
            privateKey: normalizePrivateKey(cfg.FIREBASE_PRIVATE_KEY as string),
          }),
        }
      : {}),
  };

  return initializeApp(appOptions);
}

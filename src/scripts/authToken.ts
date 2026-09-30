import { fileURLToPath } from 'node:url';
import { assertNotProduction, config } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { buildSignInUrl, parseAuthTokenArgs, signInWithPassword } from './support/utils.js';

/**
 * Script `auth:token` (spec auth-dev-scripts, tarea 9.2): inicia sesión con
 * email/password contra el REST API de Identity Toolkit
 * (`accounts:signInWithPassword`) y **solo** imprime el ID token resultante
 * en stdout, para poder capturarlo directamente en una variable de shell
 * (por ejemplo, `TOKEN=$(npm run auth:token -- --email ... --password ... --silent)`).
 * Cualquier otro mensaje (progreso, errores) va a stderr o se corta el
 * proceso antes de imprimir nada en stdout.
 *
 * Usa la URL real de Google salvo que `FIREBASE_AUTH_EMULATOR_HOST` esté
 * configurada, en cuyo caso apunta al mismo emulador que usa `firebase-admin`
 * (spec: "el emulador se usa cuando está configurado"). El emulador no valida
 * el query param `key`, así que se usa un placeholder cuando
 * `FIREBASE_WEB_API_KEY` no está definida.
 *
 * Se niega a correr en producción (tarea 9.4, `assertNotProduction`): emitir
 * tokens de acceso completo contra un proyecto real no debería ser posible
 * desde un script de desarrollo.
 */

async function main(): Promise<void> {
  assertNotProduction(config, logger, 'auth:token');

  const args = parseAuthTokenArgs(process.argv.slice(2));
  const url = buildSignInUrl(config);
  const idToken = await signInWithPassword(url, args.email, args.password);

  // Única línea en stdout, sin ningún otro texto: pensada para
  // `TOKEN=$(npm run auth:token -- ...)` (spec auth-dev-scripts).
  process.stdout.write(`${idToken}\n`);
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  main().catch((err: unknown) => {
    logger.fatal({ err }, 'auth:token failed');
    process.exitCode = 1;
  });
}

import { fileURLToPath } from 'node:url';
import { assertNotProduction, config, type Config } from '../config/env.js';
import { logger } from '../lib/logger.js';

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

export interface AuthTokenArgs {
  readonly email: string;
  readonly password: string;
}

const USAGE = 'Usage: npm run auth:token -- --email <email> --password <password>';

/** Parsea `--email <email> --password <password>`. Lanza con un mensaje de uso ante una entrada inválida. */
export function parseArgs(argv: readonly string[]): AuthTokenArgs {
  let email: string | undefined;
  let password: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--email') {
      i += 1;
      email = argv[i];
    } else if (arg === '--password') {
      i += 1;
      password = argv[i];
    }
  }

  if (!email || !password) {
    throw new Error(USAGE);
  }

  return { email, password };
}

const PRODUCTION_IDENTITY_TOOLKIT_HOST = 'identitytoolkit.googleapis.com';
/** El emulador de Auth no valida el valor de `key`, solo que el parámetro esté presente. */
const EMULATOR_PLACEHOLDER_KEY = 'fake-api-key-for-emulator';

/**
 * Arma la URL de `accounts:signInWithPassword`: contra el emulador cuando
 * `FIREBASE_AUTH_EMULATOR_HOST` está configurada, o contra el endpoint real
 * de Google en caso contrario. Función pura, testeable sin red.
 */
export function buildSignInUrl(
  cfg: Pick<Config, 'FIREBASE_AUTH_EMULATOR_HOST' | 'FIREBASE_WEB_API_KEY'>,
): string {
  const apiKey = cfg.FIREBASE_WEB_API_KEY ?? EMULATOR_PLACEHOLDER_KEY;

  if (cfg.FIREBASE_AUTH_EMULATOR_HOST) {
    return `http://${cfg.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`;
  }

  if (!cfg.FIREBASE_WEB_API_KEY) {
    throw new Error(
      'FIREBASE_WEB_API_KEY is required to call the real Identity Toolkit endpoint ' +
        '(only FIREBASE_AUTH_EMULATOR_HOST makes it optional).',
    );
  }

  return `https://${PRODUCTION_IDENTITY_TOOLKIT_HOST}/v1/accounts:signInWithPassword?key=${apiKey}`;
}

interface SignInWithPasswordResponse {
  readonly idToken: string;
}

/**
 * Llama a `accounts:signInWithPassword` y devuelve solo el ID token. Traduce
 * un rechazo del endpoint (credenciales inválidas, usuario deshabilitado,
 * etc.) a un `Error` con el mensaje que el propio endpoint reportó, nunca con
 * la contraseña enviada.
 */
export async function signInWithPassword(
  url: string,
  email: string,
  password: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });

  const json: unknown = await response.json();

  if (!response.ok) {
    const message =
      typeof json === 'object' && json !== null && 'error' in json
        ? ((json as { error?: { message?: string } }).error?.message ?? 'sign-in failed')
        : 'sign-in failed';
    throw new Error(`auth:token: ${message} (status ${response.status})`);
  }

  const parsed = json as Partial<SignInWithPasswordResponse>;
  if (typeof parsed.idToken !== 'string' || parsed.idToken.length === 0) {
    throw new Error('auth:token: response did not include an idToken');
  }

  return parsed.idToken;
}

async function main(): Promise<void> {
  assertNotProduction(config, logger, 'auth:token');

  const args = parseArgs(process.argv.slice(2));
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

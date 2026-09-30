import pino from 'pino';
import type { Logger } from 'pino';
import { z } from 'zod';
import { CONSTANTS } from './constants.js';
import type { LogLevel, NodeEnv } from './constants.js';

/**
 * `src/config/env.ts` es el ÚNICO módulo en `src/` autorizado a leer
 * `process.env` (impuesto por la regla de ESLint `no-restricted-properties`).
 * Todo otro módulo debe importar el objeto `config` congelado exportado más
 * abajo.
 *
 * Los valores no sensibles viven en `src/config/constants.ts`; acá solo se
 * validan los secretos y los overrides opcionales de despliegue, y se combinan
 * con esas constantes para armar `config`. Este archivo no define defaults
 * propios.
 */

const PINO_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const envSchema = z
  .object({
    // --- secretos (siempre vienen de .env) ---
    MONGODB_URI: z
      .string()
      .min(1, 'MONGODB_URI is required')
      .refine(
        (value) => value.startsWith('mongodb://') || value.startsWith('mongodb+srv://'),
        'MONGODB_URI must start with mongodb:// or mongodb+srv://',
      ),
    // Opcional a nivel de schema (aunque, desde watchlists, TODO entrypoint la
    // exige en la práctica) para que `parseEnv` siga siendo testeable sin ella
    // y para reutilizar el mismo mecanismo de guarda de fallo rápido. Los
    // entrypoints que la necesitan (worker, script de seed, script de
    // ejecución manual, y ahora también la API — RF-4.8: los endpoints de
    // administración de monedas llaman a CoinGecko) llaman a
    // `assertCoinGeckoApiKey()` justo después de cargar la config para fallar
    // rápido.
    COINGECKO_API_KEY: z.string().min(1).optional(),
    // Las tres variables de la cuenta de servicio de Firebase son opcionales a
    // nivel de schema (igual que COINGECKO_API_KEY) para que el proceso pueda
    // arrancar sin ellas cuando se usa el emulador de Auth;
    // `assertFirebaseCredentials()` exige las tres salvo que
    // FIREBASE_AUTH_EMULATOR_HOST esté configurado.
    FIREBASE_PROJECT_ID: z.string().min(1).optional(),
    FIREBASE_CLIENT_EMAIL: z.string().min(1).optional(),
    FIREBASE_PRIVATE_KEY: z.string().min(1).optional(),
    // Solo la usan los scripts de desarrollo (auth:token) para llamar al REST
    // API de Identity Toolkit; el proceso de la API nunca la necesita.
    FIREBASE_WEB_API_KEY: z.string().min(1).optional(),
    // Mailpit local no requiere autenticación, por eso quedan opcionales.
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASS: z.string().min(1).optional(),

    // --- overrides opcionales de despliegue (el default está en CONSTANTS) ---
    NODE_ENV: z.enum(['development', 'test', 'production']).optional(),
    PORT: z.coerce.number().int().min(1).max(65535).optional(),
    LOG_LEVEL: z.enum(PINO_LEVELS).optional(),
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    MAIL_FROM: z.string().min(1).optional(),
    // Host:puerto del emulador local de Firebase Auth (por ejemplo
    // 127.0.0.1:9099). Solo para desarrollo — ver assertFirebaseCredentials()
    // y el guard de producción en src/integrations/firebase/admin.ts. Sin
    // default: su ausencia significa "no usar emulador".
    FIREBASE_AUTH_EMULATOR_HOST: z.string().min(1).optional(),
    // Cantidad de saltos de proxy reverso en los que confiar (Express "trust
    // proxy"). Su default (0 fuera de producción, 1 en producción) depende de
    // NODE_ENV, por eso se resuelve en `parseEnv`, no acá.
    TRUST_PROXY: z.coerce.number().int().min(0).optional(),
  });

/** Ensancha los literales de `as const` (3000 -> number, 'x' -> string, false -> boolean). */
type Widen<T> = {
  -readonly [K in keyof T]: T[K] extends number
    ? number
    : T[K] extends boolean
      ? boolean
      : T[K] extends string
        ? string
        : T[K];
};

type ValidatedEnv = z.infer<typeof envSchema>;

export type Config = Readonly<
  Widen<Omit<typeof CONSTANTS, 'NODE_ENV' | 'LOG_LEVEL'>> & {
    NODE_ENV: NodeEnv;
    LOG_LEVEL: LogLevel;
    TRUST_PROXY: number;
    FIREBASE_AUTH_EMULATOR_HOST?: string;
  } & Pick<
      ValidatedEnv,
      | 'MONGODB_URI'
      | 'COINGECKO_API_KEY'
      | 'FIREBASE_PROJECT_ID'
      | 'FIREBASE_CLIENT_EMAIL'
      | 'FIREBASE_PRIVATE_KEY'
      | 'FIREBASE_WEB_API_KEY'
      | 'SMTP_USER'
      | 'SMTP_PASS'
    >
>;


export interface EnvIssue {
  readonly variable: string;
  readonly reason: string;
}

/** Lanzado por {@link parseEnv} cuando el objeto de origen falla la validación del schema. */
export class EnvValidationError extends Error {
  readonly issues: readonly EnvIssue[];

  constructor(issues: readonly EnvIssue[]) {
    super('Invalid environment configuration');
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

/**
 * Parser de entorno puro y sin efectos secundarios. Recibe el origen del
 * entorno como parámetro (en lugar de leer `process.env` directamente) para
 * poder testearlo unitariamente sin tocar el entorno real del proceso.
 *
 * @throws {EnvValidationError} cuando `source` falla la validación del
 * schema. El error nunca lleva los valores ofensivos, solo los nombres de
 * las variables y sus razones.
 */
export function parseEnv(source: Record<string, string | undefined>): Config {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const issues: EnvIssue[] = result.error.issues.map((issue) => ({
      variable: issue.path.length > 0 ? issue.path.join('.') : '(unknown)',
      reason: issue.message,
    }));
    throw new EnvValidationError(issues);
  }

  // Las claves opcionales ausentes (o explícitamente undefined) no deben pisar
  // el valor de CONSTANTS al hacer el spread.
  const validated = Object.fromEntries(
    Object.entries(result.data).filter(([, value]) => value !== undefined),
  ) as Partial<ValidatedEnv> & Pick<ValidatedEnv, 'MONGODB_URI'>;

  const nodeEnv = validated.NODE_ENV ?? CONSTANTS.NODE_ENV;

  return Object.freeze({
    ...CONSTANTS,
    ...validated,
    NODE_ENV: nodeEnv,
    LOG_LEVEL: validated.LOG_LEVEL ?? CONSTANTS.LOG_LEVEL,
    // El default de TRUST_PROXY depende de NODE_ENV, ya resuelto arriba.
    TRUST_PROXY: validated.TRUST_PROXY ?? (nodeEnv === 'production' ? 1 : 0),
  } as Config);
}

/**
 * Bootstrap de fallo rápido: valida `source` y, si falla, loguea (en
 * `fatal`) la lista de *nombres* de variables inválidas/faltantes (nunca sus
 * valores) y termina el proceso con código 1, antes de que arranque
 * cualquier servidor o conexión a la DB.
 *
 * Usa un logger de bootstrap independiente en lugar de `src/lib/logger.ts`
 * porque la configuración de ese logger (nivel, redacción) depende de un
 * `config` válido — que es justamente lo que puede no existir todavía en
 * este punto.
 */
function loadConfig(source: Record<string, string | undefined>): Config {
  try {
    return parseEnv(source);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      const bootstrapLogger = pino({ level: 'fatal' });
      bootstrapLogger.fatal(
        {
          invalidVariables: error.issues.map((issue) => issue.variable),
          reasons: error.issues.map((issue) => ({
            variable: issue.variable,
            reason: issue.reason,
          })),
        },
        'Invalid environment configuration; refusing to start.',
      );
      process.exit(1);
    }
    throw error;
  }
}

export const config: Config = loadConfig(process.env);

/**
 * Guarda de fallo rápido usada por todo entrypoint que realmente necesita
 * CoinGecko: `worker.ts`, `scripts/seedCoins.ts`, `scripts/pollPricesOnce.ts`
 * y, desde watchlists (RF-4.8), también `server.ts` — los endpoints de
 * administración de monedas llaman a CoinGecko para validar `coingeckoId`.
 *
 * `COINGECKO_API_KEY` sigue siendo opcional a nivel de schema (para que
 * `parseEnv` no la exija donde no corresponde, por ejemplo en tests
 * unitarios de config); cada entrypoint que sí la necesita llama a esto
 * inmediatamente después de cargar la config y falla rápido (log fatal +
 * exit 1) si falta, usando el mismo patrón de log-fatal-y-exit-1 que
 * {@link loadConfig}.
 */
export function assertCoinGeckoApiKey(
  cfg: Config,
  bootstrapLogger: Pick<Logger, 'fatal'>,
): asserts cfg is Config & { COINGECKO_API_KEY: string } {
  if (!cfg.COINGECKO_API_KEY) {
    bootstrapLogger.fatal(
      { invalidVariables: ['COINGECKO_API_KEY'] },
      'Missing required environment variable COINGECKO_API_KEY for this entrypoint; refusing to start.',
    );
    process.exit(1);
  }
}

/**
 * Guarda de fallo rápido para las credenciales de la cuenta de servicio de
 * Firebase (`firebase-admin-init`, tarea 1.2). Las tres variables son
 * opcionales a nivel de schema para permitir el flujo con el emulador de
 * Auth: cuando `FIREBASE_AUTH_EMULATOR_HOST` está configurado, esta guarda no
 * exige nada. Cuando no lo está, exige las tres y falla rápido (log fatal +
 * exit 1) listando por nombre las que falten, nunca sus valores — mismo
 * patrón que {@link assertCoinGeckoApiKey}.
 */
export function assertFirebaseCredentials(
  cfg: Config,
  bootstrapLogger: Pick<Logger, 'fatal'>,
): asserts cfg is Config & {
  FIREBASE_PROJECT_ID: string;
  FIREBASE_CLIENT_EMAIL: string;
  FIREBASE_PRIVATE_KEY: string;
} {
  if (cfg.FIREBASE_AUTH_EMULATOR_HOST) {
    return;
  }

  const requiredVariables = [
    'FIREBASE_PROJECT_ID',
    'FIREBASE_CLIENT_EMAIL',
    'FIREBASE_PRIVATE_KEY',
  ] as const;
  const missing = requiredVariables.filter((variable) => !cfg[variable]);

  if (missing.length > 0) {
    bootstrapLogger.fatal(
      { invalidVariables: missing },
      'Missing required Firebase service account credentials and no ' +
        'FIREBASE_AUTH_EMULATOR_HOST configured; refusing to start.',
    );
    process.exit(1);
  }
}

/**
 * Guarda de fallo rápido para el envío de correo (spec mailer, tarea 2.2):
 * `SMTP_HOST` y `MAIL_FROM` son opcionales a nivel de schema para que
 * `parseEnv` siga siendo testeable sin ellas; el worker (único entrypoint que
 * corre `send-notifications`) las exige llamando a esto inmediatamente
 * después de cargar la config, mismo patrón de log-fatal-y-exit-1 que
 * {@link assertCoinGeckoApiKey} y {@link assertFirebaseCredentials}.
 */
export function assertSmtpCredentials(
  cfg: Config,
  bootstrapLogger: Pick<Logger, 'fatal'>,
): asserts cfg is Config & { SMTP_HOST: string; MAIL_FROM: string } {
  const requiredVariables = ['SMTP_HOST', 'MAIL_FROM'] as const;
  const missing = requiredVariables.filter((variable) => !cfg[variable]);

  if (missing.length > 0) {
    bootstrapLogger.fatal(
      { invalidVariables: missing },
      'Missing required environment variables for outgoing mail; refusing to start.',
    );
    process.exit(1);
  }
}

/**
 * Guarda de fallo rápido compartida por los scripts de desarrollo de
 * auth-firebase que jamás deben correr contra un proyecto real (spec
 * auth-dev-scripts, tarea 9.4): `auth:create-test-user` (crea cuentas con
 * contraseñas conocidas) y `auth:token` (emite tokens de acceso completo).
 * Mismo patrón de log-fatal-y-exit-1 que {@link assertCoinGeckoApiKey} y
 * {@link assertFirebaseCredentials}.
 */
export function assertNotProduction(
  cfg: Pick<Config, 'NODE_ENV'>,
  bootstrapLogger: Pick<Logger, 'fatal'>,
  scriptName: string,
): void {
  if (cfg.NODE_ENV === 'production') {
    bootstrapLogger.fatal(
      { script: scriptName },
      `Refusing to run ${scriptName} with NODE_ENV=production.`,
    );
    process.exit(1);
  }
}

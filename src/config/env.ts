import pino from 'pino';
import type { Logger } from 'pino';
import { z } from 'zod';

/**
 * `src/config/env.ts` es el ÚNICO módulo en `src/` autorizado a leer
 * `process.env` (impuesto por la regla de ESLint `no-restricted-properties`).
 * Todo otro módulo debe importar el objeto `config` congelado exportado más
 * abajo.
 */

const PINO_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MONGODB_URI: z
    .string()
    .min(1, 'MONGODB_URI is required')
    .refine(
      (value) => value.startsWith('mongodb://') || value.startsWith('mongodb+srv://'),
      'MONGODB_URI must start with mongodb:// or mongodb+srv://',
    ),
  MONGODB_DB_NAME: z.string().min(1, 'MONGODB_DB_NAME must not be empty').default('crypto_tracker'),
  LOG_LEVEL: z.enum(PINO_LEVELS).default('info'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10000),

  // --- primer-job: cliente de CoinGecko ---
  // Opcional a nivel de schema para que el proceso de la API (que no
  // necesita CoinGecko hasta una etapa posterior) pueda arrancar sin ella.
  // Los entrypoints que sí la necesitan (worker, script de seed, script de
  // ejecución manual) llaman a `assertCoinGeckoApiKey()` justo después de
  // cargar la config para fallar rápido.
  COINGECKO_API_KEY: z.string().min(1).optional(),
  COINGECKO_BASE_URL: z.string().min(1).default('https://api.coingecko.com/api/v3'),
  COINGECKO_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  COINGECKO_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  COINGECKO_MAX_IDS_PER_CALL: z.coerce.number().int().min(1).max(250).default(50),

  // --- primer-job: job y worker de poll-prices ---
  POLL_PRICES_CRON: z.string().min(1).default('*/10 * * * *'),
  POLL_PRICES_RUN_ON_START: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  // Un string vacío significa "sin expiración"; si no está definida, cae al
  // valor por defecto de 90 días. Una vez resuelto, `null` significa sin
  // expiración.
  SNAPSHOT_RETENTION_DAYS: z.preprocess(
    (value) => {
      if (value === undefined) return 90;
      if (typeof value === 'string' && value.trim() === '') return null;
      return value;
    },
    z.union([z.coerce.number().int().positive(), z.null()]),
  ),
  JOB_RUNS_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  STALE_RUN_THRESHOLD_MIN: z.coerce.number().int().positive().default(15),
  WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30000),

  // --- api-rest: rate limiting, confianza en el proxy, superficie de admin ---
  // TRUST_PROXY no tiene valor por defecto a nivel de schema: su default (0
  // en desarrollo, 1 en producción) depende de NODE_ENV, que no se conoce
  // hasta que se parsea el objeto completo — se resuelve más abajo vía
  // `.transform()` sobre el schema completo.
  TRUST_PROXY: z.coerce.number().int().min(0).optional(),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW_MIN: z.coerce.number().int().positive().default(15),
  STALE_POLL_THRESHOLD_MIN: z.coerce.number().int().positive().default(30),
  // Opcional: la API arranca sin ella (las rutas de admin devuelven 404 —
  // ver `requireAdminKey`). Cuando está presente debe ser lo suficientemente
  // larga como para que forzar el header por fuerza bruta sea impracticable.
  ADMIN_API_KEY: z.string().min(32, 'ADMIN_API_KEY must be at least 32 characters').optional(),
});

// El valor por defecto de TRUST_PROXY, dependiente de NODE_ENV, se aplica
// acá, después de que el objeto base (y por lo tanto NODE_ENV) ya fue
// validado/resuelto.
const envSchema = baseEnvSchema.transform((data) => ({
  ...data,
  TRUST_PROXY: data.TRUST_PROXY ?? (data.NODE_ENV === 'production' ? 1 : 0),
}));

export type Config = Readonly<z.infer<typeof envSchema>>;

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

  return Object.freeze(result.data);
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
 * Guarda de fallo rápido usada solo por los entrypoints que realmente
 * necesitan CoinGecko (`worker.ts`, `scripts/seedCoins.ts`,
 * `scripts/pollPricesOnce.ts`).
 *
 * `COINGECKO_API_KEY` es opcional a nivel de schema para que el proceso de
 * la API (que no la necesita hasta una etapa posterior) pueda arrancar sin
 * ella; cada entrypoint que sí la necesita llama a esto inmediatamente
 * después de cargar la config y falla rápido (log fatal + exit 1) si falta,
 * usando el mismo patrón de log-fatal-y-exit-1 que {@link loadConfig}.
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

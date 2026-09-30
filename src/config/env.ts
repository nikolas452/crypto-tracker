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
  // Tamaño máximo del pool de conexiones de Mongoose (spec db-connection,
  // deploy-render tarea 2.1): explícito en vez de depender del default del
  // driver, para que un deployment no se acerque al límite de conexiones del
  // cluster (por ejemplo, 500 en un Atlas M0).
  MONGODB_MAX_POOL_SIZE: z.coerce.number().int().positive().default(10),
  LOG_LEVEL: z.enum(PINO_LEVELS).default('info'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10000),

  // --- primer-job: cliente de CoinGecko ---
  // Opcional a nivel de schema (aunque, desde watchlists, TODO entrypoint la
  // exige en la práctica) para que `parseEnv` siga siendo testeable sin ella
  // y para reutilizar el mismo mecanismo de guarda de fallo rápido. Los
  // entrypoints que la necesitan (worker, script de seed, script de
  // ejecución manual, y ahora también la API — RF-4.8: los endpoints de
  // administración de monedas llaman a CoinGecko) llaman a
  // `assertCoinGeckoApiKey()` justo después de cargar la config para fallar
  // rápido.
  COINGECKO_API_KEY: z.string().min(1).optional(),
  COINGECKO_BASE_URL: z.string().min(1).default('https://api.coingecko.com/api/v3'),
  COINGECKO_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  COINGECKO_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  COINGECKO_MAX_IDS_PER_CALL: z.coerce.number().int().min(1).max(250).default(50),
  // Chequeo de disponibilidad opcional `coingecko` de `/health/ready`
  // (spec health-checks / RF-4.8), deshabilitado por defecto: si CoinGecko
  // se cae, la API no debería salir de rotación en el balanceador — el
  // chequeo existe solo para diagnóstico manual.
  COINGECKO_READINESS_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

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

  // --- auth-firebase: Firebase Admin, verificación de tokens y perfiles de usuario ---
  // Las tres variables de la cuenta de servicio son opcionales a nivel de
  // schema (igual que COINGECKO_API_KEY) para que el proceso pueda arrancar
  // sin ellas cuando se usa el emulador de Auth; `assertFirebaseCredentials()`
  // exige las tres salvo que FIREBASE_AUTH_EMULATOR_HOST esté configurado.
  FIREBASE_PROJECT_ID: z.string().min(1).optional(),
  FIREBASE_CLIENT_EMAIL: z.string().min(1).optional(),
  FIREBASE_PRIVATE_KEY: z.string().min(1).optional(),
  // Solo la usan los scripts de desarrollo (auth:token) para llamar al REST
  // API de Identity Toolkit; el proceso de la API nunca la necesita.
  FIREBASE_WEB_API_KEY: z.string().min(1).optional(),
  // Host:puerto del emulador local de Firebase Auth (por ejemplo
  // 127.0.0.1:9099). Solo para desarrollo — ver assertFirebaseCredentials()
  // y el guard de producción en src/integrations/firebase/admin.ts.
  FIREBASE_AUTH_EMULATOR_HOST: z.string().min(1).optional(),
  // Límite de requests por minuto por uid autenticado (limitador de tasa
  // por usuario, además del límite global por IP). Default 120.
  USER_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(120),
  // Minutos de antigüedad de `lastSeenAt` antes de refrescarlo en un request
  // autenticado (spec user-profile). Default 5.
  LAST_SEEN_THROTTLE_MIN: z.coerce.number().int().positive().default(5),

  // --- watchlists: límite de ítems por usuario (spec watchlist-store) ---
  WATCHLIST_MAX_ITEMS: z.coerce.number().int().positive().default(50),

  // --- alertas-email: SMTP, plantilla de correo y jobs de alertas/notificaciones ---
  // SMTP_HOST y MAIL_FROM son opcionales a nivel de schema (mismo motivo que
  // las credenciales de Firebase) para que `parseEnv` siga siendo testeable
  // sin ellas; `assertSmtpCredentials()` las exige en el worker, que es el
  // único entrypoint que efectivamente envía correo.
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  // Mailpit local no requiere autenticación, por eso quedan opcionales.
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASS: z.string().min(1).optional(),
  MAIL_FROM: z.string().min(1).optional(),
  // Zona horaria de referencia mostrada en el cuerpo del email (spec
  // email-templates), separada de la marca de tiempo UTC que siempre se
  // incluye también.
  MAIL_DISPLAY_TIMEZONE: z.string().min(1).default('America/Argentina/Buenos_Aires'),
  MAIL_MAX_PER_MINUTE: z.coerce.number().int().positive().default(30),
  // Tope de alertas activas (armed + triggered) por usuario (spec alert-store).
  ALERTS_MAX_ACTIVE: z.coerce.number().int().positive().default(20),
  SEND_NOTIFICATIONS_CRON: z.string().min(1).default('* * * * *'),
  NOTIFY_BATCH_SIZE: z.coerce.number().int().positive().default(20),
  NOTIFY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  NOTIFY_LOCK_TIMEOUT_MIN: z.coerce.number().int().positive().default(10),
  NOTIFICATIONS_RETENTION_DAYS: z.coerce.number().int().positive().default(90),

  // --- agenda: scheduler (reemplaza node-cron) ---
  // Punto de extensión documentado a futuro (spec agenda-scheduler / design.md
  // "Decisions"): hoy el único valor soportado es "agenda"; node-cron se
  // elimina en esta etapa en lugar de mantenerse detrás de un switch
  // SCHEDULER=cron.
  // Verificación de versión de driver (design.md "Risks"): `npm ls mongodb`
  // resuelve mongoose 9.10.1 -> mongodb@7.6.0, que satisface el peer
  // dependency de `@agendajs/mongo-backend@4.0.3` (`^6.0.0 || ^7.0.0`, junto
  // con `agenda@6.2.6` exacto). No hay mismatch: Agenda comparte la conexión
  // existente de Mongoose en lugar de abrir una segunda.
  SCHEDULER: z.string().min(1).default('agenda'),
  // Frecuencia con la que Agenda revisa la colección `agenda_jobs` en busca
  // de trabajo vencido. Ver design.md "Risks": introduce latencia de
  // programación de hasta este valor.
  AGENDA_PROCESS_EVERY: z.string().min(1).default('10 seconds'),
  AGENDA_MAX_CONCURRENCY: z.coerce.number().int().positive().default(5),
  // Días que se conservan los documentos de `agenda_jobs` NO recurrentes
  // (creados por `agenda.now()`) después de finalizar, antes de que el job
  // `maintenance` los elimine.
  AGENDA_ONE_OFF_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  MAINTENANCE_CRON: z.string().min(1).default('15 3 * * *'),
  // TTL en milisegundos del lease de `poll-prices` (src/lib/lease-lock.ts).
  POLL_LOCK_TTL_MS: z.coerce.number().int().positive().default(300000),
  // Reintentos adicionales permitidos tras un fallo transitorio de
  // poll-prices (spec job-retry-policy), antes de dejar de reintentar.
  POLL_MAX_JOB_RETRIES: z.coerce.number().int().min(0).default(1),
});

/**
 * Variables de Firebase adicionalmente exigidas en producción por
 * {@link productionValidation} (spec production-config, deploy-render tarea
 * 2.2) — mismas tres que {@link assertFirebaseCredentials} exige por
 * entrypoint, pero acá se aplican incondicionalmente al arrancar en
 * producción, sin la salida del emulador.
 */
const PRODUCTION_REQUIRED_FIREBASE_VARIABLES = [
  'FIREBASE_PROJECT_ID',
  'FIREBASE_CLIENT_EMAIL',
  'FIREBASE_PRIVATE_KEY',
] as const;

/**
 * Validación adicional aplicada solo cuando `NODE_ENV=production` (spec
 * production-config, deploy-render tareas 2.2/2.3): exige `TRUST_PROXY` (y
 * que sea >= 1, ya que la app corre detrás del proxy inverso de la
 * plataforma) y las tres credenciales de Firebase, y prohíbe
 * `FIREBASE_AUTH_EMULATOR_HOST`/`FIREBASE_WEB_API_KEY` (variables de solo
 * desarrollo). Se ejecuta antes del `.transform()` de abajo, así que un
 * fallo acá impide que `TRUST_PROXY` reciba su default silencioso.
 */
type ProductionValidationCtx = Parameters<
  Parameters<(typeof baseEnvSchema)['superRefine']>[0]
>[1];

function productionValidation(
  data: z.infer<typeof baseEnvSchema>,
  ctx: ProductionValidationCtx,
): void {
  if (data.NODE_ENV !== 'production') {
    return;
  }

  if (data.TRUST_PROXY === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['TRUST_PROXY'],
      message: 'TRUST_PROXY is required when NODE_ENV=production',
    });
  } else if (data.TRUST_PROXY < 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['TRUST_PROXY'],
      message: 'TRUST_PROXY must be at least 1 when NODE_ENV=production',
    });
  }

  for (const variable of PRODUCTION_REQUIRED_FIREBASE_VARIABLES) {
    if (!data[variable]) {
      ctx.addIssue({
        code: 'custom',
        path: [variable],
        message: `${variable} is required when NODE_ENV=production`,
      });
    }
  }

  if (data.FIREBASE_AUTH_EMULATOR_HOST) {
    ctx.addIssue({
      code: 'custom',
      path: ['FIREBASE_AUTH_EMULATOR_HOST'],
      message: 'FIREBASE_AUTH_EMULATOR_HOST must not be set when NODE_ENV=production',
    });
  }

  if (data.FIREBASE_WEB_API_KEY) {
    ctx.addIssue({
      code: 'custom',
      path: ['FIREBASE_WEB_API_KEY'],
      message: 'FIREBASE_WEB_API_KEY must not be set when NODE_ENV=production',
    });
  }
}

// El valor por defecto de TRUST_PROXY, dependiente de NODE_ENV, se aplica
// acá, después de que el objeto base (y por lo tanto NODE_ENV) ya fue
// validado/resuelto.
const envSchema = baseEnvSchema
  .superRefine(productionValidation)
  .transform((data) => ({
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

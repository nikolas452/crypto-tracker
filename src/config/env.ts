import pino from 'pino';
import { z } from 'zod';

/**
 * `src/config/env.ts` is the ONLY module in `src/` allowed to read
 * `process.env` (enforced by the `no-restricted-properties` ESLint rule).
 * Every other module must import the frozen `config` object exported below.
 */

const PINO_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const envSchema = z.object({
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
});

export type Config = Readonly<z.infer<typeof envSchema>>;

export interface EnvIssue {
  readonly variable: string;
  readonly reason: string;
}

/** Thrown by {@link parseEnv} when the source object fails schema validation. */
export class EnvValidationError extends Error {
  readonly issues: readonly EnvIssue[];

  constructor(issues: readonly EnvIssue[]) {
    super('Invalid environment configuration');
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

/**
 * Pure, side-effect-free environment parser. Accepts the environment source
 * as a parameter (instead of reading `process.env` itself) so it can be unit
 * tested without touching the real process environment.
 *
 * @throws {EnvValidationError} when `source` fails schema validation. The
 * error never carries the offending values, only variable names and reasons.
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
 * Fail-fast bootstrap: validates `source`, and on failure logs (at `fatal`)
 * the list of invalid/missing variable *names* (never their values) and
 * exits the process with code 1, before any server or DB connection starts.
 *
 * Uses a standalone bootstrap logger instead of `src/lib/logger.ts` because
 * that logger's own configuration (level, redaction) depends on a valid
 * `config` — which is exactly what may not exist yet at this point.
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
          reasons: error.issues.map((issue) => ({ variable: issue.variable, reason: issue.reason })),
        },
        'Invalid environment configuration; refusing to start.',
      );
      process.exit(1);
    }
    throw error;
  }
}

export const config: Config = loadConfig(process.env);

/**
 * Constantes y funciones utilitarias de los scripts de `src/scripts`,
 * agrupadas por script. Los scripts conservan solo su flujo; los helpers
 * (parseo de argumentos, formateo de salida, cálculo de estadísticas, etc.)
 * viven acá. No importa dependencias de desarrollo (supertest,
 * mongodb-memory-server) para que el build de producción compile.
 */
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline/promises';
import type { Config } from '../../config/env.js';
import { COINGECKO_ID_PATTERN } from '../../modules/coins/coins.model.js';
import { USER_ROLES, type UserRole } from '../../modules/users/users.model.js';
import type { JobRunResult } from '../../jobs/pollPrices.js';
import type {
  AuthTokenArgs,
  BackfillArgs,
  BackfillHistorySummary,
  CreateTestUserArgs,
  LatencyStats,
  RebuildLatestSummary,
  SeedSummary,
  SetRoleArgs,
  SignInWithPasswordResponse,
} from './types.js';

// ---------------------------------------------------------------------------
// seedCoins
// ---------------------------------------------------------------------------

/** Lista de monedas por defecto de RF-1.3, usada cuando `seed:coins` corre sin argumentos. */
export const DEFAULT_COIN_IDS: readonly string[] = [
  'bitcoin',
  'ethereum',
  'solana',
  'cardano',
  'ripple',
  'dogecoin',
  'polkadot',
  'chainlink',
  'litecoin',
  'avalanche-2',
];

/** Recorta espacios, pasa a minúsculas y elimina duplicados de los ids, preservando el orden de primera aparición. */
export function normalizeIds(rawIds: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const raw of rawIds) {
    const normalized = raw.trim().toLowerCase();
    if (normalized.length > 0) {
      seen.add(normalized);
    }
  }
  return [...seen];
}

export function printSeedCoinsSummary(summary: SeedSummary): void {
  console.log(
    `seed:coins summary: created=${summary.created.length} updated=${summary.updated.length} invalid=${summary.invalid.length}`,
  );
  if (summary.invalid.length > 0) {
    console.log(`Invalid ids (not returned by CoinGecko): ${summary.invalid.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// rebuildLatest
// ---------------------------------------------------------------------------

export function printRebuildLatestSummary(summary: RebuildLatestSummary): void {
  console.log(
    `coins:rebuild-latest summary: updated=${summary.updated} noSnapshots=${summary.noSnapshots.length}`,
  );
  if (summary.noSnapshots.length > 0) {
    console.log(`Coins with no snapshots: ${summary.noSnapshots.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// backfillHistory
// ---------------------------------------------------------------------------

/**
 * `backfill:history` consume exactamente una llamada a CoinGecko por
 * invocación: `/coins/{id}/market_chart` nunca se fracciona (a diferencia de
 * `/simple/price` o `/coins/markets`, que se agrupan por `maxIdsPerCall`),
 * porque solo acepta un único id de moneda.
 */
export const UPSTREAM_CALLS_PER_RUN = 1;

/** Parsea `<coingeckoId> --days <n> [--yes|--force]`. Lanza con un mensaje de uso ante una entrada inválida. */
export function parseBackfillArgs(argv: readonly string[]): BackfillArgs {
  const positional: string[] = [];
  let daysArg: string | undefined;
  let skipConfirm = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--days') {
      i += 1;
      daysArg = argv[i];
    } else if (arg === '--yes' || arg === '--force') {
      skipConfirm = true;
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }

  const coingeckoId = positional[0]?.trim().toLowerCase();
  const days = daysArg !== undefined ? Number(daysArg) : NaN;

  if (!coingeckoId || !COINGECKO_ID_PATTERN.test(coingeckoId)) {
    throw new Error('Usage: npm run backfill:history -- <coingeckoId> --days <n> [--yes|--force]');
  }
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error(
      '--days must be a positive integer. Usage: npm run backfill:history -- <coingeckoId> --days <n> [--yes|--force]',
    );
  }

  return { coingeckoId, days, skipConfirm };
}

export async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${message} [y/N] `);
    return ['y', 'yes'].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

export function printBackfillHistorySummary(summary: BackfillHistorySummary): void {
  console.log(`backfill:history summary: imported=${summary.imported} skipped=${summary.skipped}`);
}

// ---------------------------------------------------------------------------
// pollPricesOnce
// ---------------------------------------------------------------------------

/** Código de salida del proceso según el estado del run: `failed` es 1, cualquier otro estado es 0. */
export function exitCodeFor(status: JobRunResult['status']): 0 | 1 {
  return status === 'failed' ? 1 : 0;
}

export function printPollPricesResult(result: JobRunResult): void {
  console.log(
    `job:poll-prices result: status=${result.status}${result.skipReason ? ` skipReason=${result.skipReason}` : ''} durationMs=${result.durationMs}`,
  );
  console.log(`stats: ${JSON.stringify(result.stats)}`);
  if (result.error) {
    console.log(`error: ${result.error.code} - ${result.error.message}`);
  }
}

// ---------------------------------------------------------------------------
// authToken
// ---------------------------------------------------------------------------

const AUTH_TOKEN_USAGE = 'Usage: npm run auth:token -- --email <email> --password <password>';

/** Parsea `--email <email> --password <password>`. Lanza con un mensaje de uso ante una entrada inválida. */
export function parseAuthTokenArgs(argv: readonly string[]): AuthTokenArgs {
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
    throw new Error(AUTH_TOKEN_USAGE);
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

// ---------------------------------------------------------------------------
// createTestUser
// ---------------------------------------------------------------------------

const CREATE_TEST_USER_USAGE =
  'Usage: npm run auth:create-test-user -- --email <email> --password <password> [--admin]';

/** Parsea `--email <email> --password <password> [--admin]`. Lanza con un mensaje de uso ante una entrada inválida. */
export function parseCreateTestUserArgs(argv: readonly string[]): CreateTestUserArgs {
  let email: string | undefined;
  let password: string | undefined;
  let admin = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--email') {
      i += 1;
      email = argv[i];
    } else if (arg === '--password') {
      i += 1;
      password = argv[i];
    } else if (arg === '--admin') {
      admin = true;
    }
  }

  if (!email || !password) {
    throw new Error(CREATE_TEST_USER_USAGE);
  }

  return { email, password, admin };
}

// ---------------------------------------------------------------------------
// setRole
// ---------------------------------------------------------------------------

const SET_ROLE_USAGE = `Usage: npm run user:set-role -- --email <email> --role <${USER_ROLES.join('|')}>`;

function isUserRole(value: string): value is UserRole {
  return (USER_ROLES as readonly string[]).includes(value);
}

/** Parsea `--email <email> --role <role>`. Lanza con un mensaje de uso ante una entrada inválida. */
export function parseSetRoleArgs(argv: readonly string[]): SetRoleArgs {
  let email: string | undefined;
  let role: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--email') {
      i += 1;
      email = argv[i];
    } else if (arg === '--role') {
      i += 1;
      role = argv[i];
    }
  }

  if (!email || !role || !isUserRole(role)) {
    throw new Error(SET_ROLE_USAGE);
  }

  return { email, role };
}

// ---------------------------------------------------------------------------
// perf (compartido)
// ---------------------------------------------------------------------------

export const WARMUP_REQUESTS = 10;
export const MEASURED_REQUESTS = 100;

export function percentile(sortedMs: readonly number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  const index = Math.min(sortedMs.length - 1, Math.floor(p * sortedMs.length));
  return sortedMs[index] ?? 0;
}

export function computeStats(samplesMs: readonly number[]): LatencyStats {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

/** Recibe la request como función genérica para no depender de supertest (dependencia de desarrollo). */
export async function timeRequests(run: () => Promise<unknown>, count: number): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = performance.now();
    await run();
    samples.push(performance.now() - start);
  }
  return samples;
}

/** `rnfLabel` identifica el requisito no funcional que fija el presupuesto (p. ej. `RNF-2.1`). */
export function formatRow(
  name: string,
  stats: LatencyStats,
  targetP95Ms: number,
  rnfLabel: string,
): string {
  const verdict = stats.p95 < targetP95Ms ? 'PASS' : 'FAIL';
  return (
    `${name}: p50=${stats.p50.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms ` +
    `p99=${stats.p99.toFixed(2)}ms max=${stats.max.toFixed(2)}ms ` +
    `(${rnfLabel} target: p95 < ${targetP95Ms}ms) [${verdict}]`
  );
}

// ---------------------------------------------------------------------------
// perf/coinsListPerf
// ---------------------------------------------------------------------------

export const COINS_LIST_COIN_COUNT = 10;
export const HISTORY_DAYS = 90;
export const POLL_INTERVAL_MIN = 10;
export const POINTS_PER_COIN = Math.floor((HISTORY_DAYS * 24 * 60) / POLL_INTERVAL_MIN); // ≈ 12.960, coincide con el "≈ 13.000 puntos por moneda" de RNF-2.1
export const INSERT_BATCH_SIZE = 5000;

// ---------------------------------------------------------------------------
// perf/watchlistPerf
// ---------------------------------------------------------------------------

export const WATCHLIST_ITEM_COUNT = 50;
export const WATCHLIST_TOKEN = 'perf-watchlist-token';
export const WATCHLIST_IDENTITY = {
  uid: 'perf-watchlist-uid',
  email: 'perf@example.com',
  emailVerified: true,
  name: null,
};

// ---------------------------------------------------------------------------
// perf/alertsEvaluationPerf
// ---------------------------------------------------------------------------

export const ALERTS_COIN_COUNT = 10;
export const ALERTS_PER_COIN = 100;
export const TOTAL_ALERTS = ALERTS_COIN_COUNT * ALERTS_PER_COIN;
export const TARGET_MS = 2000;

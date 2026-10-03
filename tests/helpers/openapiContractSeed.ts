/**
 * Entorno hermético de los tests de contrato OpenAPI: levanta un MongoDB en
 * memoria una sola vez, siembra los datos que necesita cada operación (monedas,
 * historial de precios, usuarios, alertas, notificaciones, ejecuciones de jobs
 * y jobs recurrentes) y construye las apps de Express con un verificador de
 * tokens falso, un CoinGecko falso y un mailer falso, de modo que no hay acceso
 * a red ni a Firebase, CoinGecko o una base real. Reutiliza los mismos patrones
 * de siembra que los tests de integración existentes.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Express } from 'express';
import mongoose from 'mongoose';
import type { Db } from 'mongodb';
import pino from 'pino';
import { createApp } from '../../src/app.js';
import { ensureCollections } from '../../src/db/ensureCollections.js';
import { createFakeTokenVerifier } from '../../src/integrations/firebase/fakeTokenVerifier.js';
import { createFakeMailer } from '../../src/integrations/mailer/fakeMailer.js';
import type { CoinGeckoClient } from '../../src/integrations/coingecko/coingecko.types.js';
import { AlertModel } from '../../src/modules/alerts/alerts.model.js';
import { CoinModel } from '../../src/modules/coins/coins.model.js';
import { JobRunModel } from '../../src/modules/job-runs/job-runs.model.js';
import { NotificationModel } from '../../src/modules/notifications/notifications.model.js';
import { PriceSnapshotModel } from '../../src/modules/snapshots/snapshots.model.js';
import { UserModel } from '../../src/modules/users/users.model.js';
import { WatchlistItemModel } from '../../src/modules/watchlist/watchlist.model.js';
import { createAgenda } from '../../src/scheduler/agenda.js';
import { registerRecurringJobs } from '../../src/scheduler/definitions.js';
import { startInMemoryMongo, stopInMemoryMongo } from './mongoMemory.js';

const silentLogger = pino({ level: 'silent' });

/** Tipos de identidad que los casos pueden usar para autenticarse. */
export type AuthKind = 'user' | 'unverified' | 'admin' | 'adminNoEmail' | 'throwaway';

/** Apps disponibles: la principal y variantes con una dependencia caída. */
export type AppKind = 'main' | 'dbDown' | 'smtpDown' | 'tinyLimits';

export const TOKENS: Readonly<Record<AuthKind, string>> = {
  user: 'contract-user-token',
  unverified: 'contract-unverified-token',
  admin: 'contract-admin-token',
  adminNoEmail: 'contract-admin-no-email-token',
  throwaway: 'contract-throwaway-token',
};

const IDENTITIES = {
  user: { uid: 'contract-user-uid', email: 'user@example.com', emailVerified: true, name: null },
  unverified: {
    uid: 'contract-unverified-uid',
    email: 'unverified@example.com',
    emailVerified: false,
    name: null,
  },
  admin: { uid: 'contract-admin-uid', email: 'admin@example.com', emailVerified: true, name: null },
  adminNoEmail: {
    uid: 'contract-admin-no-email-uid',
    email: null,
    emailVerified: false,
    name: null,
  },
  throwaway: {
    uid: 'contract-throwaway-uid',
    email: 'throwaway@example.com',
    emailVerified: true,
    name: null,
  },
} as const;

/** Identificadores de los documentos sembrados que los casos necesitan como parámetros de ruta. */
export interface SeededIds {
  readonly alertId: string;
  readonly alertToDeleteId: string;
  readonly completedAlertId: string;
  readonly failedNotificationId: string;
  readonly jobRunId: string;
  readonly missingId: string;
}

export interface ContractContext {
  readonly apps: Readonly<Record<AppKind, Express>>;
  readonly ids: SeededIds;
  /** Marca de tiempo fija (ms) usada para sembrar y para armar rangos de consulta. */
  readonly nowMs: number;
}

const COINGECKO_MARKETS: Readonly<Record<string, { symbol: string; name: string }>> = {
  bitcoin: { symbol: 'btc', name: 'Bitcoin' },
  dogecoin: { symbol: 'doge', name: 'Dogecoin' },
  cardano: { symbol: 'ada', name: 'Cardano' },
};

/** CoinGecko falso: resuelve ids conocidos y falla con el id `upstream-down` (simula una caída del proveedor). */
function createFakeCoingecko(): CoinGeckoClient {
  return {
    getMarkets: async (ids: string[]) => {
      if (ids.includes('upstream-down')) {
        throw new Error('CoinGecko unreachable (fake)');
      }
      return ids
        .filter((id) => id in COINGECKO_MARKETS)
        .map((id) => ({
          coingeckoId: id,
          symbol: COINGECKO_MARKETS[id]!.symbol,
          name: COINGECKO_MARKETS[id]!.name,
          priceUsd: 1,
        }));
    },
    getSimplePrices: async () => ({ prices: new Map(), attempts: 1 }),
    ping: async () => undefined,
    getMarketChart: async () => [],
  };
}

/** App con las dependencias falsas del entorno de contrato; `overrides` pisa cualquier valor por defecto. */
export function createContractApp(overrides: Parameters<typeof createApp>[0] = {}): Express {
  return createApp({
    logger: silentLogger,
    tokenVerifier: createFakeTokenVerifier({ identities: IDENTITIES_BY_TOKEN }),
    coingecko: createFakeCoingecko(),
    // Presupuestos amplios: la suite hace cientos de peticiones desde la misma
    // IP y uid, y el límite de tasa no es lo que se prueba aquí.
    rateLimitConfig: { RATE_LIMIT_MAX: 100_000, RATE_LIMIT_WINDOW_MIN: 15 },
    userRateLimitConfig: { USER_RATE_LIMIT_PER_MIN: 100_000 },
    ...overrides,
  });
}

const IDENTITIES_BY_TOKEN = Object.fromEntries(
  (Object.keys(TOKENS) as AuthKind[]).map((kind) => [TOKENS[kind], IDENTITIES[kind]]),
);

let tempDir: string | undefined;

function getDb(): Db {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('no hay conexión a la base de datos');
  }
  return db;
}

async function seedUsers(): Promise<{ userId: mongoose.Types.ObjectId }> {
  const base = { lastSeenAt: new Date() };
  const roles: Record<AuthKind, 'user' | 'admin'> = {
    user: 'user',
    unverified: 'user',
    admin: 'admin',
    adminNoEmail: 'admin',
    throwaway: 'user',
  };
  const created = new Map<AuthKind, mongoose.Types.ObjectId>();
  for (const kind of Object.keys(TOKENS) as AuthKind[]) {
    const identity = IDENTITIES[kind];
    const user = await UserModel.create({
      firebaseUid: identity.uid,
      email: identity.email,
      emailVerified: identity.emailVerified,
      displayName: null,
      role: roles[kind],
      ...base,
    });
    created.set(kind, user._id);
  }
  return { userId: created.get('user')! };
}

/** Siembra los datos mínimos para que toda operación documentada tenga un caso de éxito. */
async function seedData(nowMs: number): Promise<SeededIds> {
  const { userId } = await seedUsers();

  const bitcoin = await CoinModel.create({
    coingeckoId: 'bitcoin',
    symbol: 'btc',
    name: 'Bitcoin',
    isActive: true,
    latest: {
      priceUsd: 64210.12,
      marketCapUsd: 1_265_000_000_000,
      volume24hUsd: 28_500_000_000,
      change24hPct: -1.23,
      capturedAt: new Date(nowMs),
    },
  });
  const ethereum = await CoinModel.create({
    coingeckoId: 'ethereum',
    symbol: 'eth',
    name: 'Ethereum',
    isActive: true,
    latest: null,
  });
  await CoinModel.create({
    coingeckoId: 'solana',
    symbol: 'sol',
    name: 'Solana',
    isActive: true,
    latest: null,
  });
  const dogecoin = await CoinModel.create({
    coingeckoId: 'dogecoin',
    symbol: 'doge',
    name: 'Dogecoin',
    isActive: false,
    latest: null,
  });

  // Historial de bitcoin: unas pocas muestras en las últimas horas, suficientes
  // para puntos `raw`, buckets de 1h con `sma` y estadísticas de 24h.
  const minutesAgo = [150, 100, 70, 40, 10];
  const prices = [63800, 64000, 64150, 64300, 64210.12];
  for (const [index, minutes] of minutesAgo.entries()) {
    await PriceSnapshotModel.create({
      timestamp: new Date(nowMs - minutes * 60_000),
      meta: { coinId: bitcoin._id, coingeckoId: 'bitcoin' },
      priceUsd: prices[index]!,
      marketCapUsd: 1_265_000_000_000,
      volume24hUsd: null,
      change24hPct: -1.23,
      sourceUpdatedAt: null,
    });
  }

  await WatchlistItemModel.create({ userId, coinId: bitcoin._id, note: 'largo plazo' });
  await WatchlistItemModel.create({ userId, coinId: dogecoin._id, note: null });

  const armed = await AlertModel.create({
    userId,
    coinId: bitcoin._id,
    type: 'PRICE_ABOVE',
    threshold: 70000,
    status: 'armed',
  });
  await AlertModel.create({
    userId,
    coinId: bitcoin._id,
    type: 'PRICE_BELOW',
    threshold: 60000,
    mode: 'once',
    status: 'triggered',
    note: 'ya disparó',
    triggerCount: 1,
    lastTriggeredAt: new Date(nowMs - 3_600_000),
    lastTriggeredValue: 59900,
    lastEvaluatedAt: new Date(nowMs - 3_600_000),
  });
  const completed = await AlertModel.create({
    userId,
    coinId: ethereum._id,
    type: 'CHANGE_24H_ABS_GTE',
    threshold: 5,
    status: 'completed',
  });
  const toDelete = await AlertModel.create({
    userId,
    coinId: ethereum._id,
    type: 'PRICE_ABOVE',
    threshold: 5000,
    status: 'armed',
  });

  const failedKey = new mongoose.Types.ObjectId();
  const payload = {
    coingeckoId: 'bitcoin',
    coinName: 'Bitcoin',
    symbol: 'btc',
    alertType: 'PRICE_ABOVE' as const,
    threshold: 50000,
    value: 51000,
    priceUsd: 51000,
    change24hPct: 3.4,
    triggeredAt: new Date(nowMs),
    note: null,
  };
  const failed = await NotificationModel.create({
    userId,
    alertId: failedKey,
    channel: 'email',
    to: 'nicolas@example.com',
    status: 'failed',
    dedupeKey: `${failedKey.toString()}:1`,
    payload,
    attempts: 5,
    maxAttempts: 5,
    nextAttemptAt: new Date(nowMs),
    lockedAt: null,
    lockedBy: 'worker-1',
    lastError: { code: 'SMTP_UNAVAILABLE', message: 'Connection timed out', permanent: false },
    sentAt: null,
    providerMessageId: null,
  });
  const sentKey = new mongoose.Types.ObjectId();
  await NotificationModel.create({
    userId,
    alertId: sentKey,
    channel: 'email',
    to: 'nicolas@example.com',
    status: 'sent',
    dedupeKey: `${sentKey.toString()}:1`,
    payload,
    attempts: 1,
    maxAttempts: 5,
    sentAt: new Date(nowMs),
    providerMessageId: 'provider-1',
  });

  const stats = {
    coinsRequested: 3,
    coinsReturned: 3,
    snapshotsInserted: 3,
    skippedUnchanged: 0,
    missingCoins: [],
    upstreamAttempts: 1,
    latestUpdated: 3,
  };
  const success = await JobRunModel.create({
    jobName: 'poll-prices',
    trigger: 'agenda',
    status: 'success',
    startedAt: new Date(nowMs - 120_000),
    finishedAt: new Date(nowMs - 118_000),
    durationMs: 2000,
    stats,
    error: null,
    workerId: 'worker-1',
    agendaJobId: 'agenda-job-1',
  });
  await JobRunModel.create({
    jobName: 'poll-prices',
    trigger: 'api',
    status: 'failed',
    startedAt: new Date(nowMs - 240_000),
    finishedAt: new Date(nowMs - 239_000),
    durationMs: 1000,
    stats: { ...stats, coinsReturned: 0, missingCoins: ['bitcoin'] },
    error: { code: 'UPSTREAM_ERROR', message: 'CoinGecko no respondió' },
    workerId: 'worker-1',
    attempt: 2,
  });
  await JobRunModel.create({
    jobName: 'send-notifications',
    trigger: 'agenda',
    status: 'skipped',
    skipReason: 'overlap',
    startedAt: new Date(nowMs - 360_000),
    finishedAt: new Date(nowMs - 360_000),
    durationMs: 0,
    stats,
    error: null,
    workerId: 'worker-2',
  });
  await JobRunModel.create({
    jobName: 'maintenance',
    trigger: 'startup',
    status: 'running',
    startedAt: new Date(nowMs - 1000),
    finishedAt: null,
    durationMs: null,
    stats,
    error: null,
    workerId: 'worker-2',
  });

  // Registra los tres jobs recurrentes (como haría el worker al arrancar) para
  // que el listado de jobs y el estado público tengan documentos reales.
  const bootstrapAgenda = createAgenda({ db: getDb(), role: 'worker' });
  await registerRecurringJobs(bootstrapAgenda, getDb());

  return {
    alertId: armed._id.toString(),
    alertToDeleteId: toDelete._id.toString(),
    completedAlertId: completed._id.toString(),
    failedNotificationId: failed._id.toString(),
    jobRunId: success._id.toString(),
    missingId: new mongoose.Types.ObjectId().toString(),
  };
}

/**
 * Arranca el entorno de contrato: Mongo en memoria con los datos sembrados y
 * las apps de Express. `document` se escribe a un archivo temporal para que
 * `GET /api/v1/openapi.json` sirva el mismo documento que se está validando.
 */
export async function startContractEnvironment(document: unknown): Promise<ContractContext> {
  await startInMemoryMongo();
  await ensureCollections(silentLogger);

  const nowMs = Date.now();
  const ids = await seedData(nowMs);

  tempDir = mkdtempSync(join(tmpdir(), 'openapi-contract-'));
  const openapiFilePath = join(tempDir, 'openapi.json');
  writeFileSync(openapiFilePath, JSON.stringify(document), 'utf8');

  const apps = {
    main: createContractApp({ mailer: createFakeMailer(), openapiFilePath }),
    // Readiness con la base "caída": no desconecta Mongo, solo falla el chequeo.
    dbDown: createContractApp({
      openapiFilePath,
      readinessChecks: [
        {
          name: 'mongo',
          check: async () => {
            throw new Error('mongo down (simulado)');
          },
        },
      ],
    }),
    // Mailer cuyo próximo envío falla, para el 502 de `test-email`.
    smtpDown: createContractApp({
      openapiFilePath,
      mailer: createFakeMailer({ failNextSends: 1, failWith: 'SMTP_UNAVAILABLE' }),
    }),
    // Topes mínimos para provocar `LIMIT_REACHED` sin sembrar decenas de datos.
    tinyLimits: createContractApp({
      openapiFilePath,
      watchlistConfig: { WATCHLIST_MAX_ITEMS: 2 },
      alertsConfig: { ALERTS_MAX_ACTIVE: 1 },
    }),
  };

  return { apps, ids, nowMs };
}

/** Detiene Mongo en memoria y borra el directorio temporal. */
export async function stopContractEnvironment(): Promise<void> {
  await stopInMemoryMongo();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
}

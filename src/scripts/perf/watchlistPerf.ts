import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import pino from 'pino';
import { logger } from '../../lib/logger.js';
import { connectDb, disconnectDb } from '../../db/connect.js';
import { ensureCollections } from '../../db/ensureCollections.js';
import { createApp } from '../../app.js';
import { CoinModel } from '../../modules/coins/coins.model.js';
import { UserModel } from '../../modules/users/users.model.js';
import { WatchlistItemModel } from '../../modules/watchlist/watchlist.model.js';
import { createFakeTokenVerifier } from '../../integrations/firebase/fakeTokenVerifier.js';

/**
 * `npm run perf:watchlist` (tarea 8.4 / RNF-4.1): siembra un usuario con
 * `WATCHLIST_MAX_ITEMS` (50) ítems y mide la latencia p50/p95/p99 de
 * `GET /api/v1/me/watchlist`, el único presupuesto de latencia explícito de
 * esta etapa (p95 < 50ms local). Mismo enfoque que `perf:coins-list`
 * (`coinsListPerf.ts`): `mongodb-memory-server` + `supertest` en el mismo
 * proceso, sin servidor real ni dependencias nuevas — ver el comentario de
 * ese script para el razonamiento completo. Herramienta de verificación
 * manual/local, sin aserciones; el README registra los números de una
 * corrida real.
 */

const ITEM_COUNT = 50;
const WARMUP_REQUESTS = 10;
const MEASURED_REQUESTS = 100;

interface LatencyStats {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

function percentile(sortedMs: readonly number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  const index = Math.min(sortedMs.length - 1, Math.floor(p * sortedMs.length));
  return sortedMs[index] ?? 0;
}

function computeStats(samplesMs: readonly number[]): LatencyStats {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

async function timeRequests(run: () => Promise<unknown>, count: number): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = performance.now();
    await run();
    samples.push(performance.now() - start);
  }
  return samples;
}

function formatRow(name: string, stats: LatencyStats, targetP95Ms: number): string {
  const verdict = stats.p95 < targetP95Ms ? 'PASS' : 'FAIL';
  return (
    `${name}: p50=${stats.p50.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms ` +
    `p99=${stats.p99.toFixed(2)}ms max=${stats.max.toFixed(2)}ms ` +
    `(RNF-4.1 target: p95 < ${targetP95Ms}ms) [${verdict}]`
  );
}

const TOKEN = 'perf-watchlist-token';
const IDENTITY = {
  uid: 'perf-watchlist-uid',
  email: 'perf@example.com',
  emailVerified: true,
  name: null,
};

/** Crea `ITEM_COUNT` monedas activas con `latest` y las agrega todas a la watchlist del usuario de perf. */
async function seed(): Promise<void> {
  const user = await UserModel.create({
    firebaseUid: IDENTITY.uid,
    email: IDENTITY.email,
    emailVerified: true,
    displayName: null,
    role: 'user',
    lastSeenAt: new Date(),
  });

  for (let i = 0; i < ITEM_COUNT; i += 1) {
    const coingeckoId = `perf-watchlist-coin-${i}`;
    const coin = await CoinModel.create({
      coingeckoId,
      symbol: `pw${i}`,
      name: `Perf Watchlist Coin ${i}`,
      isActive: true,
      latest: {
        priceUsd: 100 + i,
        marketCapUsd: (100 + i) * 1_000_000,
        volume24hUsd: (100 + i) * 10_000,
        change24hPct: 0.5,
        capturedAt: new Date(),
      },
    });
    await WatchlistItemModel.create({ userId: user._id, coinId: coin._id, note: null });
  }
}

async function main(): Promise<void> {
  console.log(`Seeding one user with ${ITEM_COUNT} watchlist items...`);

  const mongod = await MongoMemoryServer.create();

  try {
    await connectDb(mongod.getUri(), 'crypto_tracker_perf_watchlist', logger);
    await ensureCollections(logger);

    const seedStart = performance.now();
    await seed();
    console.log(`Seed complete in ${((performance.now() - seedStart) / 1000).toFixed(1)}s.`);

    const app = createApp({
      logger: pino({ level: 'silent' }),
      rateLimitConfig: { RATE_LIMIT_MAX: 1_000_000, RATE_LIMIT_WINDOW_MIN: 15 },
      tokenVerifier: createFakeTokenVerifier({ identities: { [TOKEN]: IDENTITY } }),
    });

    const doRequest = () =>
      request(app).get('/api/v1/me/watchlist').set('Authorization', `Bearer ${TOKEN}`);

    // Warm-up: excluido de las muestras medidas.
    await timeRequests(doRequest, WARMUP_REQUESTS);

    console.log(`\nMeasuring ${MEASURED_REQUESTS} requests...`);
    const samples = await timeRequests(doRequest, MEASURED_REQUESTS);

    console.log('\nRNF-4.1 results:');
    console.log('  ' + formatRow('GET /api/v1/me/watchlist (50 items)', computeStats(samples), 50));
  } finally {
    await disconnectDb();
    await mongod.stop();
  }
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  main().catch((err: unknown) => {
    logger.fatal({ err }, 'perf:watchlist failed');
    process.exitCode = 1;
  });
}

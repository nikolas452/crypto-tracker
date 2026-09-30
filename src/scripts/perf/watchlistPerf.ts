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
import {
  MEASURED_REQUESTS,
  WARMUP_REQUESTS,
  WATCHLIST_IDENTITY,
  WATCHLIST_ITEM_COUNT,
  WATCHLIST_TOKEN,
  computeStats,
  formatRow,
  timeRequests,
} from '../support/utils.js';

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

/** Crea `WATCHLIST_ITEM_COUNT` monedas activas con `latest` y las agrega todas a la watchlist del usuario de perf. */
async function seed(): Promise<void> {
  const user = await UserModel.create({
    firebaseUid: WATCHLIST_IDENTITY.uid,
    email: WATCHLIST_IDENTITY.email,
    emailVerified: true,
    displayName: null,
    role: 'user',
    lastSeenAt: new Date(),
  });

  for (let i = 0; i < WATCHLIST_ITEM_COUNT; i += 1) {
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
  console.log(`Seeding one user with ${WATCHLIST_ITEM_COUNT} watchlist items...`);

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
      tokenVerifier: createFakeTokenVerifier({ identities: { [WATCHLIST_TOKEN]: WATCHLIST_IDENTITY } }),
    });

    const doRequest = () =>
      request(app).get('/api/v1/me/watchlist').set('Authorization', `Bearer ${WATCHLIST_TOKEN}`);

    // Warm-up: excluido de las muestras medidas.
    await timeRequests(doRequest, WARMUP_REQUESTS);

    console.log(`\nMeasuring ${MEASURED_REQUESTS} requests...`);
    const samples = await timeRequests(doRequest, MEASURED_REQUESTS);

    console.log('\nRNF-4.1 results:');
    console.log('  ' + formatRow('GET /api/v1/me/watchlist (50 items)', computeStats(samples), 50, 'RNF-4.1'));
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

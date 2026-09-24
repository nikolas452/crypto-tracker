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
import { PriceSnapshotModel } from '../../modules/snapshots/snapshots.model.js';

/**
 * `npm run perf:coins-list` (12.4 / Definition of Done): siembra un dataset
 * con la forma de los propios números de RNF-2.1 ("10 monedas y 90 días de
 * datos cada 10 min (≈ 13.000 puntos por moneda)") y mide la latencia
 * p50/p95/p99 de los tres endpoints para los que RNF-2.1 fija un
 * presupuesto: `GET /api/v1/coins` (p95 < 50ms), `GET /.../history?interval=1h`
 * sobre 30 días (p95 < 200ms) y `GET /.../stats?range=90d` (p95 < 200ms).
 *
 * Usa `mongodb-memory-server` + `supertest` — exactamente el mismo stack
 * sobre el que ya corre la suite de integración — en lugar de `autocannon`
 * (no es una dependencia existente) o un servidor real escuchando por
 * separado: la restricción a nivel de proyecto de design.md es que este
 * proyecto cuesta $0 y su servidor "se arranca solo para testear, nunca se
 * deja corriendo". Un script autocontenido que levanta un Mongo efímero,
 * mide en el mismo proceso, y apaga ambos al final satisface eso
 * directamente, sin ninguna dependencia nueva ni el paso manual de "arrancar
 * el servidor y después correr una herramienta de carga separada contra él".
 *
 * Esta es una herramienta de verificación manual/local (como la sección
 * "Manual verification steps" del README), no forma parte de la suite de
 * tests automatizada — acá no hay ninguna aserción, solo un reporte
 * impreso; la sección de la Etapa 2 del README registra los números que
 * produjo una corrida real.
 */

const COIN_COUNT = 10;
const HISTORY_DAYS = 90;
const POLL_INTERVAL_MIN = 10;
const POINTS_PER_COIN = Math.floor((HISTORY_DAYS * 24 * 60) / POLL_INTERVAL_MIN); // ≈ 12.960, coincide con el "≈ 13.000 puntos por moneda" de RNF-2.1
const INSERT_BATCH_SIZE = 5000;
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

interface SnapshotSeed {
  readonly timestamp: Date;
  readonly meta: { readonly coinId: unknown; readonly coingeckoId: string };
  readonly priceUsd: number;
  readonly marketCapUsd: number;
  readonly volume24hUsd: number;
  readonly change24hPct: null;
  readonly sourceUpdatedAt: Date;
}

/** Siembra `COIN_COUNT` monedas, cada una con `POINTS_PER_COIN` snapshots espaciados por `POLL_INTERVAL_MIN`, terminando cerca de "ahora". */
async function seed(): Promise<{ coingeckoIds: string[] }> {
  const coingeckoIds: string[] = [];
  const now = new Date();

  for (let c = 0; c < COIN_COUNT; c += 1) {
    const coingeckoId = `perf-coin-${c}`;
    coingeckoIds.push(coingeckoId);

    const coin = await CoinModel.create({
      coingeckoId,
      symbol: `pc${c}`,
      name: `Perf Coin ${c}`,
      isActive: true,
    });

    let batch: SnapshotSeed[] = [];
    let lastPriceUsd = 0;
    let lastTimestamp = now;

    for (let i = 0; i < POINTS_PER_COIN; i += 1) {
      const timestamp = new Date(
        now.getTime() - (POINTS_PER_COIN - i) * POLL_INTERVAL_MIN * 60_000,
      );
      const priceUsd = 100 + (c + 1) * 10 + Math.sin(i / 50) * 5;
      lastPriceUsd = priceUsd;
      lastTimestamp = timestamp;

      batch.push({
        timestamp,
        meta: { coinId: coin._id, coingeckoId },
        priceUsd,
        marketCapUsd: priceUsd * 1_000_000,
        volume24hUsd: priceUsd * 10_000,
        change24hPct: null,
        sourceUpdatedAt: timestamp,
      });

      if (batch.length >= INSERT_BATCH_SIZE) {
        await PriceSnapshotModel.insertMany(batch, { ordered: false });
        batch = [];
      }
    }
    if (batch.length > 0) {
      await PriceSnapshotModel.insertMany(batch, { ordered: false });
    }

    await CoinModel.updateOne(
      { _id: coin._id },
      {
        $set: {
          latest: {
            priceUsd: lastPriceUsd,
            marketCapUsd: lastPriceUsd * 1_000_000,
            volume24hUsd: lastPriceUsd * 10_000,
            change24hPct: null,
            capturedAt: lastTimestamp,
            sourceUpdatedAt: lastTimestamp,
          },
        },
      },
    );
  }

  return { coingeckoIds };
}

function formatRow(name: string, stats: LatencyStats, targetP95Ms: number): string {
  const verdict = stats.p95 < targetP95Ms ? 'PASS' : 'FAIL';
  return (
    `${name}: p50=${stats.p50.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms ` +
    `p99=${stats.p99.toFixed(2)}ms max=${stats.max.toFixed(2)}ms ` +
    `(RNF-2.1 target: p95 < ${targetP95Ms}ms) [${verdict}]`
  );
}

async function main(): Promise<void> {
  console.log(
    `Seeding ${COIN_COUNT} coins x ~${POINTS_PER_COIN} points each ` +
      `(${HISTORY_DAYS} days @ every ${POLL_INTERVAL_MIN}min)...`,
  );

  const mongod = await MongoMemoryServer.create();

  try {
    await connectDb(mongod.getUri(), 'crypto_tracker_perf', logger);
    await ensureCollections(logger);

    const seedStart = performance.now();
    const { coingeckoIds } = await seed();
    console.log(`Seed complete in ${((performance.now() - seedStart) / 1000).toFixed(1)}s.`);

    const targetCoingeckoId = coingeckoIds[0];
    if (!targetCoingeckoId) {
      throw new Error('Seeding produced no coins.');
    }

    // `WARMUP_REQUESTS + 3 * MEASURED_REQUESTS` requests golpean `/api` en
    // pocos segundos, cómodamente por encima del `RATE_LIMIT_MAX` real por
    // defecto (300) — ese limitador es correcto y se ejerce en su propio
    // test de integración (E2-15); este script mide la latencia de los
    // endpoints, no el limitador, así que el presupuesto se eleva para esta
    // corrida, y `logger` se silencia para que el log de acceso por request
    // de pino no ahogue el reporte impreso.
    const app = createApp({
      logger: pino({ level: 'silent' }),
      rateLimitConfig: { RATE_LIMIT_MAX: 1_000_000, RATE_LIMIT_WINDOW_MIN: 15 },
    });

    const historyFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const historyTo = new Date().toISOString();

    // Warm-up: excluido de las muestras medidas (overhead de JIT/conexión del primer request).
    await timeRequests(() => request(app).get('/api/v1/coins?limit=20'), WARMUP_REQUESTS);

    console.log(`\nMeasuring ${MEASURED_REQUESTS} requests per endpoint...`);

    const coinsListSamples = await timeRequests(
      () => request(app).get('/api/v1/coins?limit=20'),
      MEASURED_REQUESTS,
    );
    const historySamples = await timeRequests(
      () =>
        request(app).get(
          `/api/v1/coins/${targetCoingeckoId}/history?interval=1h&from=${historyFrom}&to=${historyTo}`,
        ),
      MEASURED_REQUESTS,
    );
    const statsSamples = await timeRequests(
      () => request(app).get(`/api/v1/coins/${targetCoingeckoId}/stats?range=90d`),
      MEASURED_REQUESTS,
    );

    console.log('\nRNF-2.1 results:');
    console.log('  ' + formatRow('GET /api/v1/coins', computeStats(coinsListSamples), 50));
    console.log(
      '  ' +
        formatRow(
          'GET /api/v1/coins/:id/history?interval=1h (30d)',
          computeStats(historySamples),
          200,
        ),
    );
    console.log(
      '  ' + formatRow('GET /api/v1/coins/:id/stats?range=90d', computeStats(statsSamples), 200),
    );
  } finally {
    await disconnectDb();
    await mongod.stop();
  }
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  main().catch((err: unknown) => {
    logger.fatal({ err }, 'perf:coins-list failed');
    process.exitCode = 1;
  });
}

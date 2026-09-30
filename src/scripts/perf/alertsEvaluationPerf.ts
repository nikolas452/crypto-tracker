import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Types } from 'mongoose';
import pino from 'pino';
import { logger } from '../../lib/logger.js';
import { connectDb, disconnectDb } from '../../db/connect.js';
import { ensureCollections } from '../../db/ensureCollections.js';
import { AlertModel } from '../../modules/alerts/alerts.model.js';
import { evaluateAlerts, type CoinInfoEntry, type CoinValueEntry } from '../../jobs/alertEvaluation.js';
import { ALERTS_COIN_COUNT, ALERTS_PER_COIN, TARGET_MS, TOTAL_ALERTS } from '../support/utils.js';

/**
 * `npm run perf:alerts-evaluation` (tarea 12.6 / RNF-5.1): siembra 1.000
 * alertas `armed` repartidas en 10 monedas y mide cuánto tarda una corrida
 * del paso de evaluación (`evaluateAlerts`, spec alert-evaluation) cuando
 * NINGUNA dispara — el presupuesto explícito de RNF-5.1 es "menos de 2
 * segundos localmente cuando nada dispara". Usa `MongoMemoryReplSet` (no
 * `MongoMemoryServer`) porque una alerta que sí disparara ejercitaría
 * `session.withTransaction()`, que exige un replica set — este script no
 * dispara ninguna a propósito (ver `seed`), pero levantar el mismo tipo de
 * instancia que producción usa es lo que hace la medición representativa.
 * Herramienta de verificación manual/local, sin aserciones automatizadas más
 * allá del veredicto impreso; el README registra los números de una corrida
 * real (tarea 12.6).
 */

async function seed(): Promise<{
  coinValueMap: Map<string, CoinValueEntry>;
  coinInfoMap: Map<string, CoinInfoEntry>;
}> {
  const coinValueMap = new Map<string, CoinValueEntry>();
  const coinInfoMap = new Map<string, CoinInfoEntry>();
  const userId = new Types.ObjectId();

  for (let c = 0; c < ALERTS_COIN_COUNT; c += 1) {
    const coinId = new Types.ObjectId();
    const coingeckoId = `perf-alert-coin-${c}`;

    // Precio de la corrida muy por encima del threshold de cada alerta
    // PRICE_BELOW (ver abajo), así ninguna dispara: RNF-5.1 mide
    // explícitamente el caso "nothing triggers", el camino NOOP de decide().
    coinValueMap.set(coinId.toString(), { priceUsd: 100_000, change24hPct: 1.5 });
    coinInfoMap.set(coinId.toString(), {
      coingeckoId,
      name: `Perf Alert Coin ${c}`,
      symbol: `pa${c}`,
    });

    const alerts = Array.from({ length: ALERTS_PER_COIN }, (_unused, i) => ({
      userId,
      coinId,
      type: 'PRICE_BELOW' as const,
      // Muy por debajo de los 100.000 fijados arriba: la condición de
      // disparo (`priceUsd <= threshold`) nunca se cumple.
      threshold: 1 + i,
      status: 'armed' as const,
    }));
    await AlertModel.insertMany(alerts);
  }

  return { coinValueMap, coinInfoMap };
}

async function main(): Promise<void> {
  console.log(`Seeding ${TOTAL_ALERTS} alerts across ${ALERTS_COIN_COUNT} coins...`);

  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await replSet.waitUntilRunning();

  try {
    await connectDb(replSet.getUri(), 'crypto_tracker_perf_alerts', logger);
    await ensureCollections(logger);

    const seedStart = performance.now();
    const { coinValueMap, coinInfoMap } = await seed();
    console.log(`Seed complete in ${((performance.now() - seedStart) / 1000).toFixed(1)}s.`);

    const silentLogger = pino({ level: 'silent' });

    // Una corrida de calentamiento (fuera de la muestra medida), igual que
    // `watchlistPerf.ts`.
    await evaluateAlerts({ coinValueMap, coinInfoMap, now: new Date(), logger: silentLogger });

    const start = performance.now();
    const { stats } = await evaluateAlerts({
      coinValueMap,
      coinInfoMap,
      now: new Date(),
      logger: silentLogger,
    });
    const durationMs = performance.now() - start;

    const verdict = durationMs < TARGET_MS ? 'PASS' : 'FAIL';
    console.log('\nRNF-5.1 results:');
    console.log(
      `  evaluateAlerts (${stats.alertsEvaluated} alerts, ${ALERTS_COIN_COUNT} coins, nothing triggers): ` +
        `${durationMs.toFixed(2)}ms (target: < ${TARGET_MS}ms) [${verdict}]`,
    );
    console.log(
      `  stats: evaluated=${stats.alertsEvaluated} triggered=${stats.alertsTriggered} ` +
        `rearmed=${stats.alertsRearmed} cooldown=${stats.alertsInCooldown} conflicts=${stats.triggerConflicts}`,
    );
  } finally {
    await disconnectDb();
    await replSet.stop();
  }
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  main().catch((err: unknown) => {
    logger.fatal({ err }, 'perf:alerts-evaluation failed');
    process.exitCode = 1;
  });
}

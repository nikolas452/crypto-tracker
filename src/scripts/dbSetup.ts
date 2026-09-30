import { fileURLToPath } from 'node:url';
import type { Model } from 'mongoose';
import type { Logger } from 'pino';
import { config } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { connectDb, disconnectDb } from '../db/connect.js';
import { ensureCollections } from '../db/ensureCollections.js';
import { AlertModel } from '../modules/alerts/alerts.model.js';
import { CoinModel } from '../modules/coins/coins.model.js';
import { JobRunModel } from '../modules/job-runs/job-runs.model.js';
import { NotificationModel } from '../modules/notifications/notifications.model.js';
import { UserModel } from '../modules/users/users.model.js';
import { WatchlistItemModel } from '../modules/watchlist/watchlist.model.js';

/**
 * Script `db:setup` (spec db-setup-script, deploy-render tarea 5.1): corre
 * `ensureCollections()` y luego `syncIndexes()` por modelo, de forma
 * idempotente. Reemplaza, para el propósito de sincronizar índices, al
 * `autoIndex` de Mongoose (deshabilitado en producción, ver `connectDb`):
 * separa "el código está desplegado" de "el schema cambió" en dos pasos
 * deliberados en vez de dejar que la construcción de índices sea un efecto
 * colateral del arranque del proceso.
 *
 * Deliberadamente NO incluye `PriceSnapshotModel`: `price_snapshots` es una
 * colección de series temporales cuyo único índice secundario lo crea a mano
 * `ensureCollections()` (nunca declarado en el schema, que tiene `autoIndex:
 * false`) — correr `syncIndexes()` sobre ese modelo lo borraría por
 * "no declarado en el schema", exactamente lo que este script existe para
 * evitar en el resto de las colecciones.
 */

// `Model<unknown>` no es asignable desde cada modelo concreto (genéricos
// invariantes de Mongoose), así que esta lista heterogénea de modelos de
// distintos schemas necesita `any` acá.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModel = Model<any>;

const MODELS: readonly AnyModel[] = [
  CoinModel,
  JobRunModel,
  UserModel,
  WatchlistItemModel,
  AlertModel,
  NotificationModel,
];

interface ModelIndexDiff {
  readonly modelName: string;
  readonly toCreate: readonly unknown[];
  readonly toDrop: readonly unknown[];
}

/** Calcula, sin modificar nada, qué índices se crearían/borrarían por modelo (spec: el diff se loguea antes de aplicarse). */
export async function computeIndexDiffs(
  models: readonly AnyModel[] = MODELS,
): Promise<ModelIndexDiff[]> {
  const diffs: ModelIndexDiff[] = [];
  for (const model of models) {
    const { toCreate, toDrop } = await model.diffIndexes();
    diffs.push({ modelName: model.modelName, toCreate, toDrop });
  }
  return diffs;
}

/** Loguea el diff de índices pendientes, uno por modelo, antes de que se aplique nada. */
function logIndexDiffs(diffs: readonly ModelIndexDiff[], log: Pick<Logger, 'info'>): void {
  const pending = diffs.filter((diff) => diff.toCreate.length > 0 || diff.toDrop.length > 0);

  if (pending.length === 0) {
    log.info('db:setup: no pending index changes');
    return;
  }

  for (const diff of pending) {
    log.info(
      { model: diff.modelName, toCreate: diff.toCreate, toDrop: diff.toDrop },
      'db:setup: pending index changes',
    );
  }
}

/**
 * Lógica pura de `db:setup`: calcula y loguea el diff de índices por modelo
 * y, salvo `dryRun`, aplica `syncIndexes()` por modelo — que crea los
 * índices declarados en el schema que falten y borra los que ya no estén
 * declarados. Separada del entrypoint de CLI de abajo para poder testearla
 * sin lanzar un proceso, mismo patrón que `runSeedCoins`.
 */
export async function runDbSetup(
  options: { readonly dryRun: boolean; readonly logger: Pick<Logger, 'info'> },
  models: readonly AnyModel[] = MODELS,
): Promise<void> {
  const diffs = await computeIndexDiffs(models);
  logIndexDiffs(diffs, options.logger);

  if (options.dryRun) {
    options.logger.info('db:setup --dry-run: no changes applied');
    return;
  }

  for (const model of models) {
    await model.syncIndexes();
  }
  options.logger.info('db:setup: indexes synchronized');
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  await connectDb(config.MONGODB_URI, config.MONGODB_DB_NAME, logger, {
    isProduction: config.NODE_ENV === 'production',
    maxPoolSize: config.MONGODB_MAX_POOL_SIZE,
  });
  // Crea/valida price_snapshots como colección de series temporales y su
  // índice secundario antes de tocar los índices del resto de los modelos.
  await ensureCollections(logger);

  await runDbSetup({ dryRun, logger });

  await disconnectDb();
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  main().catch((err: unknown) => {
    logger.fatal({ err }, 'db:setup failed');
    process.exitCode = 1;
  });
}

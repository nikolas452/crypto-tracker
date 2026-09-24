import mongoose from 'mongoose';
import type { Logger } from 'pino';
import { config, type Config } from '../config/env.js';
import { CoinModel } from '../modules/coins/coins.model.js';
import { JobRunModel } from '../modules/job-runs/job-runs.model.js';

/**
 * Garantiza, al arrancar, que las colecciones de Mongo tengan la forma
 * esperada: crea `price_snapshots` como colección de series temporales si
 * hace falta y construye los índices de dominio explícitamente.
 */

const PRICE_SNAPSHOTS_COLLECTION = 'price_snapshots';
const TIME_FIELD = 'timestamp';
const META_FIELD = 'meta';
const GRANULARITY = 'minutes';
const SECONDS_PER_DAY = 86400;

interface TimeseriesOptions {
  readonly timeField?: string;
  readonly metaField?: string;
  readonly granularity?: string;
}

interface CollectionInfo {
  readonly name: string;
  readonly options?: {
    readonly timeseries?: TimeseriesOptions;
    readonly expireAfterSeconds?: number;
  };
}

function secondsFromDays(days: number | null): number | undefined {
  return days === null ? undefined : days * SECONDS_PER_DAY;
}

async function findCollectionInfo(
  db: mongoose.mongo.Db,
  name: string,
): Promise<CollectionInfo | undefined> {
  const collections = await db.listCollections({ name }).toArray();
  return collections[0] as CollectionInfo | undefined;
}

/**
 * Crea `price_snapshots` como colección de series temporales si todavía no
 * existe, o valida la forma de una existente — nunca deja que un insert
 * implícito la cree primero como colección normal (RF-1.1 / spec
 * price-snapshot-store).
 */
async function ensurePriceSnapshotsCollection(
  db: mongoose.mongo.Db,
  logger: Logger,
  cfg: Config,
): Promise<void> {
  const desiredExpireAfterSeconds = secondsFromDays(cfg.SNAPSHOT_RETENTION_DAYS);
  const info = await findCollectionInfo(db, PRICE_SNAPSHOTS_COLLECTION);

  if (!info) {
    await db.createCollection(PRICE_SNAPSHOTS_COLLECTION, {
      timeseries: {
        timeField: TIME_FIELD,
        metaField: META_FIELD,
        granularity: GRANULARITY,
      },
      ...(desiredExpireAfterSeconds !== undefined
        ? { expireAfterSeconds: desiredExpireAfterSeconds }
        : {}),
    });
    logger.info(
      { collection: PRICE_SNAPSHOTS_COLLECTION, timeField: TIME_FIELD, metaField: META_FIELD },
      'Created price_snapshots as a time-series collection',
    );
  } else {
    const timeseries = info.options?.timeseries;
    if (timeseries?.timeField !== TIME_FIELD || timeseries?.metaField !== META_FIELD) {
      logger.fatal(
        { collection: PRICE_SNAPSHOTS_COLLECTION, foundOptions: info.options },
        `price_snapshots already exists but is not a time-series collection shaped as ` +
          `{ timeField: "${TIME_FIELD}", metaField: "${META_FIELD}" }. A normal collection can ` +
          'never be converted to time-series: drop it (only if it holds no data you need) and ' +
          'restart so it can be recreated correctly, or migrate its data manually first.',
      );
      process.exit(1);
      // `process.exit` nunca retorna en un proceso real; esto cubre el caso
      // en que un test lo mockea y la ejecución, de lo contrario, seguiría
      // hacia código que asume una colección de series temporales válida.
      return;
    }

    const currentExpireAfterSeconds = info.options?.expireAfterSeconds;
    if (
      desiredExpireAfterSeconds !== undefined &&
      currentExpireAfterSeconds !== desiredExpireAfterSeconds
    ) {
      await db.command({
        collMod: PRICE_SNAPSHOTS_COLLECTION,
        expireAfterSeconds: desiredExpireAfterSeconds,
      });
      logger.info(
        {
          collection: PRICE_SNAPSHOTS_COLLECTION,
          previousExpireAfterSeconds: currentExpireAfterSeconds,
          expireAfterSeconds: desiredExpireAfterSeconds,
        },
        'Updated price_snapshots retention via collMod',
      );
    }
  }

  await db
    .collection(PRICE_SNAPSHOTS_COLLECTION)
    .createIndex({ 'meta.coingeckoId': 1, timestamp: -1 });
}

/**
 * `coins` y `job_runs` son colecciones normales, así que no hay riesgo de
 * "forma incorrecta" — pero `connectDb()` deshabilita el `autoIndex` de
 * Mongoose en producción, así que sus índices (incluido el índice TTL de
 * job_runs) deben construirse explícitamente al arrancar, en lugar de
 * depender de la construcción en segundo plano de Mongoose al conectar.
 */
async function ensureDomainIndexes(): Promise<void> {
  await Promise.all([CoinModel.createIndexes(), JobRunModel.createIndexes()]);
}

/**
 * Se ejecuta al arrancar en todo entrypoint que pueda ser el primero en
 * tocar Mongo (API, worker, script de seed, script de ejecución manual) —
 * siempre inmediatamente después de `connectDb()`, antes de que cualquier
 * otra cosa toque la base de datos.
 */
export async function ensureCollections(
  logger: Logger,
  cfg: Config = config,
  connection: mongoose.Connection = mongoose.connection,
): Promise<void> {
  const db = connection.db;
  if (!db) {
    throw new Error('ensureCollections() called before the Mongo connection is open');
  }

  await ensurePriceSnapshotsCollection(db, logger, cfg);
  await ensureDomainIndexes();
}

import mongoose from 'mongoose';
import type { Logger } from 'pino';
import { config, type Config } from '../config/env.js';
import { CoinModel } from '../modules/coins/coins.model.js';
import { JobRunModel } from '../modules/job-runs/job-runs.model.js';

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
 * Creates `price_snapshots` as a time-series collection if it doesn't exist
 * yet, or validates the shape of an existing one — never lets an implicit
 * insert create it as a normal collection first (RF-1.1 / price-snapshot-store spec).
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
      // `process.exit` never returns in a real process; this guards the case
      // where a test mocks it and execution would otherwise fall through
      // into code that assumes a valid time-series collection.
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
 * `coins` and `job_runs` are normal collections, so there's no "wrong shape"
 * risk — but `connectDb()` disables Mongoose's `autoIndex` in production, so
 * their indexes (including job_runs' TTL index) must be built explicitly at
 * startup instead of relying on Mongoose's on-connect background build.
 */
async function ensureDomainIndexes(): Promise<void> {
  await Promise.all([CoinModel.createIndexes(), JobRunModel.createIndexes()]);
}

/**
 * Runs at startup for every entrypoint that could be first to touch Mongo
 * (API, worker, seed script, manual-run script) — always immediately after
 * `connectDb()`, before anything else touches the database.
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

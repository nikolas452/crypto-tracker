import type { Types } from 'mongoose';
import { PriceSnapshotModel } from './snapshots.model.js';

export interface NewSnapshotInput {
  readonly timestamp: Date;
  readonly coinId: Types.ObjectId;
  readonly coingeckoId: string;
  readonly priceUsd: number;
  readonly marketCapUsd: number | null;
  readonly volume24hUsd: number | null;
  readonly change24hPct: number | null;
  readonly sourceUpdatedAt: Date | null;
}

/**
 * Repository contract for `price_snapshots`. Injected into the polling job
 * so it can be tested with a fake implementation (unit tests) or a real
 * `mongodb-memory-server` time-series collection (integration tests).
 */
export interface SnapshotsRepo {
  /**
   * One aggregation for the whole batch of requested coins: `$match` on
   * `meta.coingeckoId` -> `$sort` by `timestamp` descending -> `$group`
   * with `$first`, to get each coin's most recent `sourceUpdatedAt`.
   * Coins with no prior snapshot are simply absent from the returned map.
   */
  getLastSourceUpdatedAt(coingeckoIds: readonly string[]): Promise<Map<string, Date | null>>;
  /** `insertMany(docs, { ordered: false })`; returns the number of documents inserted. */
  insertMany(docs: readonly NewSnapshotInput[]): Promise<number>;
}

interface LastUpdatedAggregationResult {
  _id: string;
  sourceUpdatedAt: Date | null;
}

export function createSnapshotsRepo(): SnapshotsRepo {
  return {
    async getLastSourceUpdatedAt(coingeckoIds) {
      if (coingeckoIds.length === 0) {
        return new Map();
      }

      const results = await PriceSnapshotModel.aggregate<LastUpdatedAggregationResult>([
        { $match: { 'meta.coingeckoId': { $in: [...coingeckoIds] } } },
        { $sort: { timestamp: -1 } },
        {
          $group: {
            _id: '$meta.coingeckoId',
            sourceUpdatedAt: { $first: '$sourceUpdatedAt' },
          },
        },
      ]).exec();

      return new Map(results.map((result) => [result._id, result.sourceUpdatedAt ?? null]));
    },

    async insertMany(docs) {
      if (docs.length === 0) {
        return 0;
      }

      const result = await PriceSnapshotModel.insertMany(
        docs.map((doc) => ({
          timestamp: doc.timestamp,
          meta: { coinId: doc.coinId, coingeckoId: doc.coingeckoId },
          priceUsd: doc.priceUsd,
          marketCapUsd: doc.marketCapUsd,
          volume24hUsd: doc.volume24hUsd,
          change24hPct: doc.change24hPct,
          sourceUpdatedAt: doc.sourceUpdatedAt,
        })),
        { ordered: false },
      );

      return result.length;
    },
  };
}

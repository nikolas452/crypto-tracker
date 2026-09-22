import type { Types } from 'mongoose';
import { CoinModel } from './coins.model.js';

/** The subset of a coin document the polling job actually needs. */
export interface ActiveCoin {
  readonly id: Types.ObjectId;
  readonly coingeckoId: string;
}

export interface MarketCoinUpsertInput {
  readonly coingeckoId: string;
  readonly symbol: string;
  readonly name: string;
}

export interface UpsertResult {
  readonly coingeckoId: string;
  /** `true` when the coin document did not exist before this call. */
  readonly created: boolean;
}

/**
 * Repository contract for the `coins` collection. Injected into the
 * polling job and the seed script so both can be tested with a fake
 * implementation instead of a real database.
 */
export interface CoinsRepo {
  findActive(): Promise<ActiveCoin[]>;
  upsertFromMarket(input: MarketCoinUpsertInput): Promise<UpsertResult>;
}

interface ActiveCoinProjection {
  _id: Types.ObjectId;
  coingeckoId: string;
}

/** Creates the `coins` repository backed by Mongoose. Plain factory function, no DI container. */
export function createCoinsRepo(): CoinsRepo {
  return {
    async findActive() {
      const docs = await CoinModel.find({ isActive: true })
        .select({ coingeckoId: 1 })
        .lean<ActiveCoinProjection[]>()
        .exec();
      return docs.map((doc) => ({ id: doc._id, coingeckoId: doc.coingeckoId }));
    },

    async upsertFromMarket(input) {
      const existing = await CoinModel.exists({ coingeckoId: input.coingeckoId }).exec();

      await CoinModel.updateOne(
        { coingeckoId: input.coingeckoId },
        {
          $set: {
            name: input.name,
            symbol: input.symbol.toLowerCase(),
            isActive: true,
          },
        },
        { upsert: true },
      ).exec();

      return { coingeckoId: input.coingeckoId, created: existing === null };
    },
  };
}

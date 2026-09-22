import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * `coins`: the catalog of tracked coins. A normal (non-time-series)
 * collection. `coingeckoId` is the natural key used everywhere else
 * (snapshots, job stats) instead of the Mongo `_id`.
 */
const coinSchema = new Schema(
  {
    coingeckoId: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: /^[a-z0-9-]+$/,
    },
    symbol: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    isActive: {
      type: Boolean,
      required: true,
      default: true,
    },
  },
  {
    collection: 'coins',
    timestamps: true,
    versionKey: false,
  },
);

// Supports the job's active-coin lookup (RF-1.4 step 2 / coin-catalog spec).
coinSchema.index({ isActive: 1 });

export type CoinDocument = HydratedDocument<InferSchemaType<typeof coinSchema>>;

export const CoinModel = model('Coin', coinSchema);

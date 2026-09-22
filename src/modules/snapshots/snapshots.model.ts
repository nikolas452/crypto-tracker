import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * `price_snapshots`: a MongoDB time-series collection. `ensureCollections()`
 * (see `src/db/ensureCollections.ts`) is solely responsible for creating this
 * collection with the correct `timeseries` options and its secondary index —
 * this schema NEVER auto-creates the collection or auto-builds indexes on
 * it (`autoCreate`/`autoIndex: false`), because MongoDB silently creates a
 * *normal* collection on the first implicit write, and a normal collection
 * can never be converted to time-series afterward.
 *
 * `meta` holds ONLY identity fields (`coinId`, `coingeckoId`) — never a
 * per-point value like price — because MongoDB buckets time-series documents
 * by the `meta` value; a changing field there would put every point in its
 * own bucket and defeat the format's purpose.
 */
const priceSnapshotSchema = new Schema(
  {
    timestamp: { type: Date, required: true },
    meta: {
      coinId: { type: Schema.Types.ObjectId, required: true, ref: 'Coin' },
      coingeckoId: { type: String, required: true },
    },
    priceUsd: {
      type: Number,
      required: true,
      validate: {
        validator: (value: number) => value > 0,
        message: 'priceUsd must be greater than 0',
      },
    },
    marketCapUsd: { type: Number, default: null },
    volume24hUsd: { type: Number, default: null },
    change24hPct: { type: Number, default: null },
    sourceUpdatedAt: { type: Date, default: null },
  },
  {
    collection: 'price_snapshots',
    autoCreate: false,
    autoIndex: false,
    versionKey: false,
  },
);

export type PriceSnapshotDocument = HydratedDocument<InferSchemaType<typeof priceSnapshotSchema>>;

export const PriceSnapshotModel = model('PriceSnapshot', priceSnapshotSchema);

import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * `price_snapshots`: una colección de series temporales de MongoDB.
 * `ensureCollections()` (ver `src/db/ensureCollections.ts`) es el único
 * responsable de crear esta colección con las opciones `timeseries`
 * correctas y su índice secundario — este schema NUNCA crea la colección
 * automáticamente ni construye índices sobre ella (`autoCreate`/`autoIndex:
 * false`), porque MongoDB crea en silencio una colección *normal* en el
 * primer write implícito, y una colección normal nunca puede convertirse
 * después a series temporales.
 *
 * `meta` contiene SOLO campos de identidad (`coinId`, `coingeckoId`) — nunca
 * un valor propio de cada punto como el precio — porque MongoDB agrupa los
 * documentos de series temporales por el valor de `meta`; un campo que
 * cambie ahí pondría cada punto en su propio bucket y anularía el propósito
 * del formato.
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

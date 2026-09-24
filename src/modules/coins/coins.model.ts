import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * Modelo de Mongoose para `coins`: el catálogo de monedas rastreadas, con su
 * copia desnormalizada de `latest` y los índices que sirven a los endpoints
 * de lectura.
 */

/**
 * Compartido con el schema del parámetro de ruta `coingeckoId` del
 * coin-read-api (5.5: "validar coingeckoId contra el mismo patrón que
 * impone el modelo de coins"), para que ambos nunca se desincronicen.
 */
export const COINGECKO_ID_PATTERN = /^[a-z0-9-]+$/;

/**
 * Copia desnormalizada del punto más reciente de `price_snapshots` de una
 * moneda, actualizada por el job `poll-prices` después de cada corrida —
 * nunca se escribe desde una lectura (spec api-rest / coin-catalog). `null`
 * hasta la primera actualización exitosa, así el endpoint de listado puede
 * ordenar al final las monedas que nunca fueron consultadas en lugar de
 * fallar al serializarlas.
 */
const latestSchema = new Schema(
  {
    priceUsd: { type: Number, required: true },
    marketCapUsd: { type: Number, default: null },
    volume24hUsd: { type: Number, default: null },
    change24hPct: { type: Number, default: null },
    capturedAt: { type: Date, required: true },
    sourceUpdatedAt: { type: Date, default: null },
  },
  { _id: false },
);

/**
 * `coins`: el catálogo de monedas rastreadas. Una colección normal (no de
 * series temporales). `coingeckoId` es la clave natural usada en todo el
 * resto del sistema (snapshots, stats de jobs) en lugar del `_id` de Mongo.
 */
const coinSchema = new Schema(
  {
    coingeckoId: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: COINGECKO_ID_PATTERN,
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
    // Espejo en minúsculas de `name`, mantenido por el hook pre('save') de
    // abajo y seteado explícitamente por el upsert del script de seed (que
    // evita `save()`). Existe para que la búsqueda por prefijo `q` del
    // endpoint de listado nunca necesite una regex insensible a mayúsculas
    // — esas no pueden usar un índice (design.md).
    //
    // No es `required`: Mongoose ejecuta la validación del schema *antes*
    // de los hooks pre('save') (validate -> pre('save') -> write), así que
    // una restricción required acá rechazaría el propio save() que está por
    // derivarlo.
    nameLower: {
      type: String,
      trim: true,
    },
    isActive: {
      type: Boolean,
      required: true,
      default: true,
    },
    latest: {
      type: latestSchema,
      default: null,
    },
  },
  {
    collection: 'coins',
    timestamps: true,
    versionKey: false,
  },
);

// El callback `pre('save', fn)` de Mongoose 9 está basado en promesas (sin
// parámetro `next`) — ver mongoose/types/middlewares.d.ts PreSaveMiddlewareFunction.
coinSchema.pre<HydratedDocument<InferSchemaType<typeof coinSchema>>>('save', function () {
  if (this.isNew || this.isModified('name')) {
    this.nameLower = this.name.toLowerCase();
  }
});

// Sirve la búsqueda de monedas activas del job (RF-1.4 paso 2 / spec coin-catalog).
coinSchema.index({ isActive: 1 });
// Índices de la read-API de api-rest: listado ordenado por market cap /
// cambio 24h, y búsqueda por prefijo de nombre / símbolo — todos acotados a
// isActive para que el query planner pueda resolverlos con un único IXSCAN.
coinSchema.index({ isActive: 1, 'latest.marketCapUsd': -1 });
coinSchema.index({ isActive: 1, nameLower: 1 });
coinSchema.index({ isActive: 1, symbol: 1 });
coinSchema.index({ isActive: 1, 'latest.change24hPct': -1 });

export type CoinDocument = HydratedDocument<InferSchemaType<typeof coinSchema>>;

export const CoinModel = model('Coin', coinSchema);

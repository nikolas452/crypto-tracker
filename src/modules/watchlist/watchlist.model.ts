import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * Modelo de Mongoose para `watchlist_items`: un documento por cada par
 * usuario-moneda que un usuario decide seguir (spec watchlist-store). Se
 * elige referenciar con un documento por ítem, en lugar de embeber un array
 * en `users`, precisamente porque un índice único compuesto puede resolver
 * "sin duplicados" en la base de datos, algo que un array no puede (ver
 * design.md, sección "Decisions").
 */

const NOTE_MAX_LENGTH = 200;

const watchlistItemSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: 'User',
    },
    coinId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: 'Coin',
    },
    // Texto plano, sin escapar HTML (RNF-4.4): no es responsabilidad de la
    // API interpretarlo, solo de cualquier cliente que lo renderice.
    note: {
      type: String,
      default: null,
      trim: true,
      maxlength: NOTE_MAX_LENGTH,
    },
    // Campo explícito (en lugar de que `timestamps` renombre `createdAt` a
    // `addedAt`): renombrar el timestamp automático a nivel de schema rompe
    // la inferencia de tipos de Mongoose (`InferSchemaType` termina
    // generando una firma de índice incorrecta para el resto de los
    // campos). `default: Date.now` se comporta igual que el `createdAt`
    // automático que reemplaza.
    addedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  {
    collection: 'watchlist_items',
    // Solo `updatedAt` es un timestamp automático; `addedAt` (el
    // equivalente a `createdAt`) es el campo explícito de arriba.
    timestamps: { createdAt: false, updatedAt: true },
    versionKey: false,
  },
);

// Único: impide que la misma moneda aparezca dos veces en la watchlist de un
// usuario, incluso bajo escrituras concurrentes (spec watchlist-store,
// design.md: "el índice es todo el argumento — convierte una condición de
// carrera en un E11000 atrapable").
watchlistItemSchema.index({ userId: 1, coinId: 1 }, { unique: true });
// Sirve el listado de la watchlist de un usuario, ordenado por fecha de
// alta (RNF-4.2).
watchlistItemSchema.index({ userId: 1, addedAt: -1 });
// Sirve el conteo de "cuántos usuarios siguen esta moneda" (watchersCount
// del listado de admin de monedas).
watchlistItemSchema.index({ coinId: 1 });

export type WatchlistItemDocument = HydratedDocument<InferSchemaType<typeof watchlistItemSchema>>;

export const WatchlistItemModel = model('WatchlistItem', watchlistItemSchema);

import { Types } from 'mongoose';
import { config, type Config } from '../../config/env.js';
import { ConflictError, NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { findCoinRefByCoingeckoId, type CoinRef } from '../coins/coins.service.js';
import { WatchlistItemModel } from './watchlist.model.js';
import {
  toWatchlistItemDto,
  type WatchlistItemDto,
  type WatchlistItemDtoSource,
} from './watchlist.dto.js';
import type {
  AddWatchlistItemBody,
  WatchlistListQuery,
  WatchlistSortField,
  WatchlistSortOrder,
} from './watchlist.schemas.js';

/**
 * Capa de servicio del módulo de watchlist: repositorio de `watchlist_items`
 * y la lógica de negocio de RF-4.1 a RF-4.5. Toda función pública recibe
 * `userId` como primer parámetro explícito (RF-4.5 / spec
 * user-data-isolation) — nunca lo lee de un objeto de contexto ambiente, así
 * un caller no puede invocarla sin elegir un alcance.
 */

export type WatchlistItemRow = WatchlistItemDtoSource;

export interface InsertWatchlistItemInput {
  readonly userId: Types.ObjectId;
  readonly coinId: Types.ObjectId;
  readonly note: string | null;
}

export interface WatchlistItemRecord {
  readonly coinId: Types.ObjectId;
  readonly note: string | null;
  readonly addedAt: Date;
  readonly updatedAt: Date;
}

/**
 * Contrato de repositorio para `watchlist_items`. Se inyecta en las
 * funciones de servicio de abajo para que los tests unitarios (tarea 4.8)
 * puedan usar una implementación falsa en memoria, el mismo patrón que
 * `CoinsRepo` / `UsersRepo`.
 */
export interface WatchlistRepo {
  countByUser(userId: Types.ObjectId): Promise<number>;
  /** Deja pasar el error nativo `E11000` de MongoDB tal cual ante una violación del índice único; el servicio lo traduce. */
  insert(input: InsertWatchlistItemInput): Promise<WatchlistItemRecord>;
  findByUserAndCoin(
    userId: Types.ObjectId,
    coinId: Types.ObjectId,
  ): Promise<WatchlistItemRecord | null>;
  updateNote(
    userId: Types.ObjectId,
    coinId: Types.ObjectId,
    note: string | null,
  ): Promise<WatchlistItemRecord | null>;
  deleteByUserAndCoin(userId: Types.ObjectId, coinId: Types.ObjectId): Promise<void>;
  /** Devuelve la cantidad de documentos eliminados — usado por la cascada de borrado de cuenta (RF-4.7). */
  deleteAllByUser(userId: Types.ObjectId): Promise<number>;
  listByUser(
    userId: Types.ObjectId,
    sortField: WatchlistSortField,
    order: WatchlistSortOrder,
  ): Promise<WatchlistItemRow[]>;
  /** `$group` sobre `watchlist_items` restringido a los ids recibidos (RF-4.6: `watchersCount`). */
  countWatchersByCoinIds(coinIds: readonly Types.ObjectId[]): Promise<Map<string, number>>;
}

const WATCHLIST_ITEM_RECORD_PROJECTION = {
  coinId: 1,
  note: 1,
  addedAt: 1,
  updatedAt: 1,
  _id: 0,
} as const;

/** Campo de Mongo (después del `$unwind` de `coin`) por el que ordena cada valor de `sort` (spec watchlist-read-api). */
const SORT_FIELD_MAP: Record<WatchlistSortField, string> = {
  addedAt: 'addedAt',
  name: 'coin.name',
  change24h: 'coin.latest.change24hPct',
  marketCap: 'coin.latest.marketCapUsd',
};

/** Crea el repositorio de `watchlist_items` respaldado por Mongoose. Función factory simple, sin contenedor de DI. */
export function createWatchlistRepo(): WatchlistRepo {
  return {
    async countByUser(userId) {
      return WatchlistItemModel.countDocuments({ userId }).exec();
    },

    async insert(input) {
      const doc = await WatchlistItemModel.create({
        userId: input.userId,
        coinId: input.coinId,
        note: input.note,
      });
      return {
        coinId: doc.coinId,
        note: doc.note ?? null,
        addedAt: doc.addedAt,
        updatedAt: doc.updatedAt,
      };
    },

    async findByUserAndCoin(userId, coinId) {
      return WatchlistItemModel.findOne({ userId, coinId })
        .select(WATCHLIST_ITEM_RECORD_PROJECTION)
        .lean<WatchlistItemRecord | null>()
        .exec();
    },

    async updateNote(userId, coinId, note) {
      return WatchlistItemModel.findOneAndUpdate(
        { userId, coinId },
        { $set: { note } },
        { returnDocument: 'after' },
      )
        .select(WATCHLIST_ITEM_RECORD_PROJECTION)
        .lean<WatchlistItemRecord | null>()
        .exec();
    },

    async deleteByUserAndCoin(userId, coinId) {
      await WatchlistItemModel.deleteOne({ userId, coinId }).exec();
    },

    async deleteAllByUser(userId) {
      const result = await WatchlistItemModel.deleteMany({ userId }).exec();
      return result.deletedCount;
    },

    /**
     * Agregación fija de RF-4.1: `$match` por `userId` -> `$lookup` a `coins`
     * (proyectando solo `coingeckoId`/`symbol`/`name`/`isActive`/`latest`) ->
     * `$unwind` -> `$sort`. Sin `$skip`/`$limit`: el listado nunca pagina,
     * acotado por `WATCHLIST_MAX_ITEMS` (spec watchlist-read-api).
     */
    async listByUser(userId, sortField, order) {
      const field = SORT_FIELD_MAP[sortField];

      return WatchlistItemModel.aggregate<WatchlistItemRow>([
        { $match: { userId } },
        {
          $lookup: {
            from: 'coins',
            localField: 'coinId',
            foreignField: '_id',
            as: 'coin',
            pipeline: [
              { $project: { _id: 0, coingeckoId: 1, symbol: 1, name: 1, isActive: 1, latest: 1 } },
            ],
          },
        },
        { $unwind: '$coin' },
        { $sort: { [field]: order === 'asc' ? 1 : -1 } },
        {
          $project: {
            _id: 0,
            note: 1,
            addedAt: 1,
            coingeckoId: '$coin.coingeckoId',
            symbol: '$coin.symbol',
            name: '$coin.name',
            isActive: '$coin.isActive',
            latest: '$coin.latest',
          },
        },
      ]).exec();
    },

    async countWatchersByCoinIds(coinIds) {
      if (coinIds.length === 0) {
        return new Map();
      }

      const rows = await WatchlistItemModel.aggregate<{ _id: Types.ObjectId; count: number }>([
        { $match: { coinId: { $in: [...coinIds] } } },
        { $group: { _id: '$coinId', count: { $sum: 1 } } },
      ]).exec();

      return new Map(rows.map((row) => [row._id.toString(), row.count]));
    },
  };
}

/** `true` cuando `error` es el error de clave duplicada de MongoDB (E11000) — mismo chequeo que `users.service.ts`. */
function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000
  );
}

/**
 * Fuente de datos de `GET /api/v1/me/watchlist` (RF-4.1). `meta.max` expone
 * el cap configurado, sin importar cuántos ítems tenga el usuario
 * actualmente (spec watchlist-store: "el cap configurado se expone al
 * cliente").
 */
export async function listWatchlist(
  userId: string,
  query: WatchlistListQuery,
  cfg: Pick<Config, 'WATCHLIST_MAX_ITEMS'> = config,
  repo: WatchlistRepo = createWatchlistRepo(),
): Promise<{ data: WatchlistItemDto[]; meta: { count: number; max: number } }> {
  const rows = await repo.listByUser(new Types.ObjectId(userId), query.sort, query.order);
  const data = rows.map(toWatchlistItemDto);

  return { data, meta: { count: data.length, max: cfg.WATCHLIST_MAX_ITEMS } };
}

export interface AddWatchlistItemDeps {
  readonly repo?: WatchlistRepo;
  /** Inyectable para tests unitarios (tarea 4.8); por defecto, `findCoinRefByCoingeckoId` del módulo de monedas. */
  readonly findCoin?: (coingeckoId: string) => Promise<CoinRef | null>;
  readonly cfg?: Pick<Config, 'WATCHLIST_MAX_ITEMS'>;
}

/**
 * Alta de un ítem (RF-4.2). Orden de validaciones FIJO, no reordenable: (1)
 * la forma del body ya la validó la ruta antes de llamar acá; (2) la moneda
 * existe y está activa -> 404 `NOT_FOUND`; (3) la cantidad actual está por
 * debajo del cap -> 422 `UNPROCESSABLE`/`LIMIT_REACHED`; (4) inserción,
 * traduciendo un `E11000` a 409 `CONFLICT`.
 *
 * El paso (3) — contar y después insertar — no es atómico (design.md,
 * "Decisions"): bajo requests concurrentes un usuario podría quedar con
 * `WATCHLIST_MAX_ITEMS + 1` ítems. Se acepta y documenta como limitación
 * conocida (tarea 4.12) en lugar de resolverse con un contador dedicado en
 * `users` — ver README.
 */
export async function addWatchlistItem(
  userId: string,
  body: AddWatchlistItemBody,
  deps: AddWatchlistItemDeps = {},
): Promise<WatchlistItemDto> {
  const repo = deps.repo ?? createWatchlistRepo();
  const findCoin = deps.findCoin ?? findCoinRefByCoingeckoId;
  const cfg = deps.cfg ?? config;

  const coin = await findCoin(body.coingeckoId);
  if (!coin || !coin.isActive) {
    throw new NotFoundError('La moneda no está disponible');
  }

  const userObjectId = new Types.ObjectId(userId);
  const currentCount = await repo.countByUser(userObjectId);
  if (currentCount >= cfg.WATCHLIST_MAX_ITEMS) {
    throw new UnprocessableError('Alcanzaste el límite de ítems en tu watchlist', {
      details: { reason: 'LIMIT_REACHED' },
    });
  }

  try {
    const created = await repo.insert({
      userId: userObjectId,
      coinId: coin.id,
      note: body.note ?? null,
    });

    return toWatchlistItemDto({
      coingeckoId: coin.coingeckoId,
      symbol: coin.symbol,
      name: coin.name,
      isActive: coin.isActive,
      note: created.note,
      addedAt: created.addedAt,
      latest: coin.latest,
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new ConflictError('La moneda ya está en tu watchlist');
    }
    throw error;
  }
}

export interface UpdateWatchlistItemNoteDeps {
  readonly repo?: WatchlistRepo;
  readonly findCoin?: (coingeckoId: string) => Promise<CoinRef | null>;
}

/**
 * Edición de la nota de un ítem (RF-4.3). Resuelve la moneda por
 * `coingeckoId` sin filtrar por `isActive` (a diferencia de la alta: "keeping
 * one does not [require it to be active]", design.md) y luego el ítem por
 * `{ userId, coinId }`. 404 cuando el usuario no sigue esa moneda.
 */
export async function updateWatchlistItemNote(
  userId: string,
  coingeckoId: string,
  note: string | null,
  deps: UpdateWatchlistItemNoteDeps = {},
): Promise<WatchlistItemDto> {
  const repo = deps.repo ?? createWatchlistRepo();
  const findCoin = deps.findCoin ?? findCoinRefByCoingeckoId;

  const coin = await findCoin(coingeckoId);
  if (!coin) {
    throw new NotFoundError('No seguís esta moneda');
  }

  const userObjectId = new Types.ObjectId(userId);
  const updated = await repo.updateNote(userObjectId, coin.id, note);
  if (!updated) {
    throw new NotFoundError('No seguís esta moneda');
  }

  return toWatchlistItemDto({
    coingeckoId: coin.coingeckoId,
    symbol: coin.symbol,
    name: coin.name,
    isActive: coin.isActive,
    note: updated.note,
    addedAt: updated.addedAt,
    latest: coin.latest,
  });
}

export interface RemoveWatchlistItemDeps {
  readonly repo?: WatchlistRepo;
  readonly findCoin?: (coingeckoId: string) => Promise<CoinRef | null>;
}

/**
 * Baja de un ítem (RF-4.4). Siempre 204: `DELETE` es idempotente por
 * definición (design.md), así que ni un ítem inexistente ni un
 * `coingeckoId` que no corresponde a ninguna moneda produce un error — la
 * postcondición ("esta moneda no está en tu watchlist") ya se cumple.
 */
export async function removeWatchlistItem(
  userId: string,
  coingeckoId: string,
  deps: RemoveWatchlistItemDeps = {},
): Promise<void> {
  const repo = deps.repo ?? createWatchlistRepo();
  const findCoin = deps.findCoin ?? findCoinRefByCoingeckoId;

  const coin = await findCoin(coingeckoId);
  if (!coin) {
    return;
  }

  await repo.deleteByUserAndCoin(new Types.ObjectId(userId), coin.id);
}

/**
 * Elimina todos los ítems de un usuario (RF-4.7 / spec
 * account-deletion-cascade). La llama `usersService.deleteAccount(userId)`
 * antes de borrar el documento de `users` — este módulo nunca sabe nada de
 * `users`, solo borra sus propios documentos cuando se lo piden
 * explícitamente (design.md: "cada módulo borra sus propios datos").
 * Idempotente: `deleteMany` sobre una colección ya vacía para ese `userId`
 * no falla, solo reporta `0` eliminados.
 */
export async function deleteAllWatchlistItemsForUser(
  userId: string,
  repo: WatchlistRepo = createWatchlistRepo(),
): Promise<number> {
  return repo.deleteAllByUser(new Types.ObjectId(userId));
}

/**
 * `watchersCount` por moneda (RF-4.6), restringido a los ids recibidos — el
 * listado de admin de monedas lo usa acotado a la página actual, nunca al
 * catálogo completo (design.md: "computed only for the coins on the
 * requested page").
 */
export async function countWatchersByCoinIds(
  coinIds: readonly Types.ObjectId[],
  repo: WatchlistRepo = createWatchlistRepo(),
): Promise<Map<string, number>> {
  return repo.countWatchersByCoinIds(coinIds);
}

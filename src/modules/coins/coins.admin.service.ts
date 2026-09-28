import type { Logger } from 'pino';
import type { Types } from 'mongoose';
import { logger as defaultLogger } from '../../lib/logger.js';
import {
  AppError,
  ConflictError,
  InternalError,
  UnprocessableError,
  UpstreamError,
} from '../../lib/errors.js';
import { buildPaginationMeta, type PaginatedResult } from '../../lib/pagination.js';
import { countWatchersByCoinIds } from '../watchlist/watchlist.service.js';
import type { CoinGeckoClient } from '../../integrations/coingecko/coingecko.types.js';
import { CoinModel } from './coins.model.js';
import {
  createCoinsRepo,
  findCoinRefByCoingeckoId,
  type CoinRef,
  type CoinsRepo,
} from './coins.service.js';
import { toAdminCoinDto, type AdminCoinDto } from './coins.admin.dto.js';
import type { CoinDtoSource } from './coins.dto.js';
import type { AdminCoinListQuery } from './coins.admin.schemas.js';

/**
 * Capa de servicio de administración de monedas (spec admin-coin-management,
 * RF-4.6): listado paginado con `watchersCount`, alta/reactivación validada
 * contra CoinGecko y activación/desactivación. No hay borrado: ver la
 * sección "Coins are never deleted" de la spec — desactivar es la única
 * forma de "remover" una moneda, así el histórico y las referencias de
 * watchlist nunca quedan colgando.
 */

interface CoinAdminProjection {
  readonly _id: Types.ObjectId;
  readonly coingeckoId: string;
  readonly symbol: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly latest: CoinDtoSource['latest'];
}

const ADMIN_COIN_PROJECTION = {
  coingeckoId: 1,
  symbol: 1,
  name: 1,
  isActive: 1,
  latest: 1,
} as const;

type CountWatchersFn = (coinIds: readonly Types.ObjectId[]) => Promise<Map<string, number>>;

async function watchersCountFor(
  coinId: Types.ObjectId,
  countWatchers: CountWatchersFn = countWatchersByCoinIds,
): Promise<number> {
  const watchersMap = await countWatchers([coinId]);
  return watchersMap.get(coinId.toString()) ?? 0;
}

/**
 * Fuente de datos de `GET /api/v1/admin/coins`: lista paginada incluyendo
 * monedas inactivas, con filtro `isActive` opcional, más `watchersCount` por
 * moneda calculado con una única agregación restringida a los ids de la
 * página actual (design.md: "computed only for the coins on the requested
 * page").
 */
export async function listAdminCoins(
  query: AdminCoinListQuery,
): Promise<PaginatedResult<AdminCoinDto>> {
  const filter: Record<string, unknown> = {};
  if (query.isActive !== undefined) {
    filter.isActive = query.isActive;
  }

  const skip = (query.page - 1) * query.limit;

  const [docs, total] = await Promise.all([
    CoinModel.find(filter)
      .select(ADMIN_COIN_PROJECTION)
      .sort({ coingeckoId: 1 })
      .skip(skip)
      .limit(query.limit)
      .lean<CoinAdminProjection[]>()
      .exec(),
    CoinModel.countDocuments(filter).exec(),
  ]);

  const watchersMap = await countWatchersByCoinIds(docs.map((doc) => doc._id));

  const data = docs.map((doc) =>
    toAdminCoinDto({
      coingeckoId: doc.coingeckoId,
      symbol: doc.symbol,
      name: doc.name,
      isActive: doc.isActive,
      latest: doc.latest,
      watchersCount: watchersMap.get(doc._id.toString()) ?? 0,
    }),
  );

  return { data, meta: buildPaginationMeta(query.page, query.limit, total) };
}

export interface CreateOrReactivateCoinDeps {
  readonly coingecko: Pick<CoinGeckoClient, 'getMarkets'>;
  readonly coinsRepo?: CoinsRepo;
  readonly logger?: Logger;
  /** Inyectable para tests unitarios (tarea 5.6); por defecto, `findCoinRefByCoingeckoId` del propio módulo. */
  readonly findCoin?: (coingeckoId: string) => Promise<CoinRef | null>;
  /** Inyectable para tests unitarios; por defecto, `countWatchersByCoinIds` del módulo de watchlist. */
  readonly countWatchers?: CountWatchersFn;
}

/**
 * Alta o reactivación de una moneda (RF-4.6). Valida contra CoinGecko con
 * `getMarkets([id])` ANTES de escribir nada: un id que CoinGecko no
 * reconoce es 422 `UNKNOWN_COINGECKO_ID`, y un fallo del propio llamado se
 * propaga tal cual (`CoinGeckoError` ya extiende `UpstreamError` -> 502
 * `UPSTREAM_ERROR`, spec admin-coin-management). Reutiliza
 * `CoinsRepo.upsertFromMarket` (el mismo upsert que usa `seed:coins`) tanto
 * para crear como para reactivar: ambos casos escriben `isActive: true` y
 * refrescan `name`/`symbol` desde CoinGecko.
 */
export async function createOrReactivateCoin(
  coingeckoId: string,
  adminUserId: string,
  deps: CreateOrReactivateCoinDeps,
): Promise<{ readonly dto: AdminCoinDto; readonly created: boolean }> {
  const coinsRepo = deps.coinsRepo ?? createCoinsRepo();
  const logger = deps.logger ?? defaultLogger;
  const findCoin = deps.findCoin ?? findCoinRefByCoingeckoId;
  const countWatchers = deps.countWatchers ?? countWatchersByCoinIds;
  const normalizedId = coingeckoId.trim().toLowerCase();

  let markets;
  try {
    markets = await deps.coingecko.getMarkets([normalizedId]);
  } catch (error) {
    // La implementación real del cliente ya lanza `CoinGeckoError` (un
    // `UpstreamError`) para todo fallo upstream, pero el contrato de
    // `CoinGeckoClient` no lo garantiza a nivel de tipos — así que acá se
    // traduce cualquier error no reconocido a 502 `UPSTREAM_ERROR` de forma
    // defensiva (spec admin-coin-management: "un fallo del llamado -> 502").
    throw error instanceof AppError
      ? error
      : new UpstreamError('Falló la validación contra CoinGecko', { cause: error });
  }
  const market = markets.find((entry) => entry.coingeckoId === normalizedId);
  if (!market) {
    throw new UnprocessableError('CoinGecko no reconoce este id', {
      details: { reason: 'UNKNOWN_COINGECKO_ID' },
    });
  }

  const existing = await findCoin(normalizedId);
  if (existing?.isActive) {
    throw new ConflictError('La moneda ya está activa');
  }

  await coinsRepo.upsertFromMarket({
    coingeckoId: normalizedId,
    symbol: market.symbol,
    name: market.name,
  });

  const created = !existing;

  logger.info(
    { adminUserId, coingeckoId: normalizedId, action: created ? 'created' : 'reactivated' },
    'Admin coin write',
  );

  const refreshed = await findCoin(normalizedId);
  if (!refreshed) {
    throw new InternalError('La moneda recién escrita no se pudo releer');
  }

  const watchersCount = await watchersCountFor(refreshed.id, countWatchers);

  return {
    created,
    dto: toAdminCoinDto({
      coingeckoId: refreshed.coingeckoId,
      symbol: refreshed.symbol,
      name: refreshed.name,
      isActive: refreshed.isActive,
      latest: refreshed.latest,
      watchersCount,
    }),
  };
}

export interface SetCoinActiveDeps {
  readonly logger?: Logger;
}

/**
 * Activación/desactivación (RF-4.6). Devuelve `null` cuando no existe
 * ninguna moneda con ese `coingeckoId` — la ruta lo mapea a 404
 * `NOT_FOUND`. Desactivar no borra nada: el job de polling ya excluye las
 * monedas inactivas (`CoinsRepo.findActive()`), así que deja de
 * consultarla desde la próxima corrida sin tocar su histórico ni los ítems
 * de watchlist que la referencian.
 */
export async function setCoinActive(
  coingeckoId: string,
  isActive: boolean,
  adminUserId: string,
  deps: SetCoinActiveDeps = {},
): Promise<AdminCoinDto | null> {
  const logger = deps.logger ?? defaultLogger;

  const updated = await CoinModel.findOneAndUpdate(
    { coingeckoId },
    { $set: { isActive } },
    { returnDocument: 'after' },
  )
    .select({ ...ADMIN_COIN_PROJECTION, _id: 1 })
    .lean<CoinAdminProjection | null>()
    .exec();

  if (!updated) {
    return null;
  }

  logger.info({ adminUserId, coingeckoId: updated.coingeckoId, isActive }, 'Admin coin write');

  const watchersCount = await watchersCountFor(updated._id);

  return toAdminCoinDto({
    coingeckoId: updated.coingeckoId,
    symbol: updated.symbol,
    name: updated.name,
    isActive: updated.isActive,
    latest: updated.latest,
    watchersCount,
  });
}

import type { Types } from 'mongoose';
import { CoinModel } from './coins.model.js';
import { escapeRegExp } from '../../lib/regexEscape.js';
import { buildPaginationMeta, type PaginatedResult } from '../../lib/pagination.js';
import {
  toCoinDetailDto,
  toCoinListItemDto,
  type CoinDetailDto,
  type CoinDtoSource,
  type CoinListItemDto,
} from './coins.dto.js';
import type { CoinListQuery, CoinSortField } from './coins.schemas.js';

/**
 * Capa de servicio del módulo de monedas: repositorio de `coins` y las
 * consultas que sirven a las rutas de lectura, al job de polling y a los
 * scripts de mantenimiento.
 */

/** El subconjunto de un documento de moneda que realmente necesita el job de polling. */
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
  /** `true` cuando el documento de la moneda no existía antes de esta llamada. */
  readonly created: boolean;
}

/** Los valores `latest` actualizados de una moneda, indexados por su `_id` (RF-2.x / spec price-polling-job). */
export interface LatestRefreshInput {
  readonly coinId: Types.ObjectId;
  readonly priceUsd: number;
  readonly marketCapUsd: number | null;
  readonly volume24hUsd: number | null;
  readonly change24hPct: number | null;
  readonly capturedAt: Date;
  readonly sourceUpdatedAt: Date | null;
}

export interface RefreshLatestResult {
  /** Cantidad de operaciones `updateOne` que matchearon un documento de moneda. */
  readonly matchedCount: number;
  /** Cantidad de monedas cuyo `latest` fue efectivamente sobrescrito (excluye los no-ops de la guarda de antigüedad). */
  readonly modifiedCount: number;
}

/**
 * Contrato de repositorio para la colección `coins`. Se inyecta en el job de
 * polling y en el script de seed para que ambos puedan testearse con una
 * implementación falsa en lugar de una base de datos real.
 */
export interface CoinsRepo {
  findActive(): Promise<ActiveCoin[]>;
  upsertFromMarket(input: MarketCoinUpsertInput): Promise<UpsertResult>;
  /**
   * Un `bulkWrite` con un `updateOne` condicional por cada input, que hace
   * `$set` de `latest`. Cada `updateOne` solo matchea cuando el `latest`
   * almacenado de la moneda es `null` o su `latest.capturedAt` es
   * estrictamente anterior al nuevo `capturedAt`, así una corrida más lenta
   * y vieja nunca puede sobrescribir valores más nuevos (spec
   * price-polling-job: "La actualización de latest nunca sobrescribe datos
   * más nuevos"). Un no-op (`updates` vacío) devuelve conteos en cero sin
   * round trip.
   */
  refreshLatest(updates: readonly LatestRefreshInput[]): Promise<RefreshLatestResult>;
}

interface ActiveCoinProjection {
  _id: Types.ObjectId;
  coingeckoId: string;
}

/** Crea el repositorio de `coins` respaldado por Mongoose. Función factory simple, sin contenedor de DI. */
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
            // `updateOne` nunca ejecuta el hook pre('save') del schema, así
            // que nameLower se deriva acá explícitamente (spec coin-catalog).
            nameLower: input.name.toLowerCase(),
            symbol: input.symbol.toLowerCase(),
            isActive: true,
          },
        },
        { upsert: true },
      ).exec();

      return { coingeckoId: input.coingeckoId, created: existing === null };
    },

    async refreshLatest(updates) {
      if (updates.length === 0) {
        return { matchedCount: 0, modifiedCount: 0 };
      }

      const result = await CoinModel.bulkWrite(
        updates.map((update) => ({
          updateOne: {
            filter: {
              _id: update.coinId,
              $or: [{ latest: null }, { 'latest.capturedAt': { $lt: update.capturedAt } }],
            },
            update: {
              $set: {
                latest: {
                  priceUsd: update.priceUsd,
                  marketCapUsd: update.marketCapUsd,
                  volume24hUsd: update.volume24hUsd,
                  change24hPct: update.change24hPct,
                  capturedAt: update.capturedAt,
                  sourceUpdatedAt: update.sourceUpdatedAt,
                },
              },
            },
          },
        })),
        { ordered: false },
      );

      return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
    },
  };
}

/** Campo de Mongo por el que ordena cada valor de `sort` (spec coin-read-api). */
const SORT_FIELD_MAP: Record<CoinSortField, string> = {
  marketCap: 'latest.marketCapUsd',
  change24h: 'latest.change24hPct',
  name: 'nameLower',
  symbol: 'symbol',
};

interface CoinListProjection {
  coingeckoId: string;
  symbol: string;
  name: string;
  latest: CoinDtoSource['latest'];
}

interface CoinDetailProjection extends CoinListProjection {
  createdAt: Date;
}

const LIST_PROJECTION = { coingeckoId: 1, symbol: 1, name: 1, latest: 1, _id: 0 } as const;

/**
 * Fuente de datos de `GET /api/v1/coins`: una consulta de datos más un
 * `countDocuments` sobre el mismo filtro, solo `isActive: true`, sin
 * `$lookup` hacia `price_snapshots` (spec coin-read-api). Recibe solo
 * valores tipados y validados — nunca el `req`/`res` de Express (spec 5.9).
 *
 * Las monedas con `latest: null` deben ordenarse al final sin importar
 * `order` (spec coin-read-api). Para la dirección `desc` por defecto en los
 * dos campos `latest.*` esto pasa gratis: BSON ordena `null` por debajo de
 * cualquier número, así que un `-1` simple ya pone las monedas sin consultar
 * después de las consultadas, servido por uno de los índices de dos campos
 * `{ isActive, latest.* }` (RNF-2.2) — el caso que cubre el test explain de
 * RNF-2.2. Una solicitud explícita ascendente en esos mismos campos
 * pondría las monedas sin consultar PRIMERO (E2-3), así que esa única
 * combinación (un campo de sort `latest.*` con `order: 'asc'`) recurre a una
 * agregación corta que agrega un booleano explícito `__hasLatest` y ordena
 * primero por eso — ordenar directamente por el subdocumento `latest` en su
 * lugar sería incorrecto: BSON compara dos subdocumentos no nulos campo por
 * campo (empezando por `priceUsd`), lo que anularía en silencio el orden
 * secundario solicitado en lugar de simplemente agrupar los nulos al final.
 */
export async function listCoins(options: CoinListQuery): Promise<PaginatedResult<CoinListItemDto>> {
  const filter = options.q
    ? {
        isActive: true,
        $or: [
          { symbol: new RegExp(`^${escapeRegExp(options.q.toLowerCase())}`) },
          { nameLower: new RegExp(`^${escapeRegExp(options.q.toLowerCase())}`) },
        ],
      }
    : { isActive: true };

  const field = SORT_FIELD_MAP[options.sort];
  const skip = (options.page - 1) * options.limit;
  const forceNullsLast = field.startsWith('latest.') && options.order === 'asc';

  const dataQuery = forceNullsLast
    ? CoinModel.aggregate<CoinListProjection>([
        { $match: filter },
        { $addFields: { __hasLatest: { $ne: ['$latest', null] } } },
        { $sort: { __hasLatest: -1, [field]: 1 } },
        { $skip: skip },
        { $limit: options.limit },
        { $project: { _id: 0, coingeckoId: 1, symbol: 1, name: 1, latest: 1 } },
      ]).exec()
    : CoinModel.find(filter)
        .select(LIST_PROJECTION)
        .sort({ [field]: options.order === 'asc' ? 1 : -1 })
        .skip(skip)
        .limit(options.limit)
        .lean<CoinListProjection[]>()
        .exec();

  const [docs, total] = await Promise.all([dataQuery, CoinModel.countDocuments(filter).exec()]);

  return {
    data: docs.map(toCoinListItemDto),
    meta: buildPaginationMeta(options.page, options.limit, total),
  };
}

/**
 * Fuente de datos de `GET /api/v1/coins/:coingeckoId`. Devuelve `null` para
 * una moneda desconocida o inactiva; la ruta mapea eso a 404 `NOT_FOUND`
 * (spec coin-read-api: las monedas desactivadas se ocultan, no solo se
 * filtran).
 */
export async function getCoinDetail(coingeckoId: string): Promise<CoinDetailDto | null> {
  const doc = await CoinModel.findOne({ coingeckoId, isActive: true })
    .select({ coingeckoId: 1, symbol: 1, name: 1, latest: 1, createdAt: 1, _id: 0 })
    .lean<CoinDetailProjection | null>()
    .exec();

  return doc ? toCoinDetailDto(doc) : null;
}

/**
 * Chequeo de existencia liviano reutilizado por los endpoints de history y
 * stats (`src/modules/snapshots/snapshots.service.ts`) para su mismo
 * comportamiento de 404-ante-moneda-desconocida-o-inactiva (specs
 * price-history-api / price-stats-api), sin traer el DTO de detalle
 * completo.
 */
export async function isActiveCoin(coingeckoId: string): Promise<boolean> {
  const exists = await CoinModel.exists({ coingeckoId, isActive: true }).exec();
  return exists !== null;
}

/**
 * Fuente de datos de `activeCoins` para `GET /api/v1/status` (spec
 * system-status-api).
 */
export async function countActiveCoins(): Promise<number> {
  return CoinModel.countDocuments({ isActive: true }).exec();
}

/**
 * Todas las monedas sin importar `isActive` — la fuente de datos del script
 * `coins:rebuild-latest` (spec data-maintenance-scripts: "para cada
 * moneda"), a diferencia de `findActive()` que el job de polling acota solo
 * a monedas activas.
 */
export async function findAllCoinIds(): Promise<ActiveCoin[]> {
  const docs = await CoinModel.find({})
    .select({ coingeckoId: 1 })
    .lean<ActiveCoinProjection[]>()
    .exec();
  return docs.map((doc) => ({ id: doc._id, coingeckoId: doc.coingeckoId }));
}

/**
 * Busca el `_id` de una moneda por `coingeckoId`, sin importar `isActive` —
 * lo usa `backfill:history` (11.4) para resolver
 * `price_snapshots.meta.coinId` antes de importar. Devuelve `null` cuando la
 * moneda todavía no fue sembrada (seed).
 */
export async function findCoinIdByCoingeckoId(coingeckoId: string): Promise<Types.ObjectId | null> {
  const doc = await CoinModel.findOne({ coingeckoId })
    .select({ _id: 1 })
    .lean<{ _id: Types.ObjectId } | null>()
    .exec();
  return doc ? doc._id : null;
}

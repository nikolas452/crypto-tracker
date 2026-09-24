import type { PipelineStage, Types } from 'mongoose';
import { PriceSnapshotModel } from './snapshots.model.js';
import { isActiveCoin } from '../coins/coins.service.js';
import { assertRangeAllowed, selectInterval, type HistoryInterval } from './interval.js';
import { nullifySmaWarmup } from './sma.js';
import { computeChangePct } from './stats.js';
import { ValidationError } from '../../lib/errors.js';
import type { HistoryQuery, StatsQuery } from './snapshots.schemas.js';
import type {
  BucketedHistoryPointDto,
  HistoryResponseDto,
  RawHistoryPointDto,
  StatsResponseDto,
} from './snapshots.dto.js';

/**
 * Capa de servicio del módulo de snapshots: repositorio de `price_snapshots`
 * y las consultas de historial/estadísticas que exponen las rutas de
 * lectura de precios.
 */

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
 * Contrato de repositorio para `price_snapshots`. Se inyecta en el job de
 * polling para poder testearlo con una implementación falsa (tests
 * unitarios) o con una colección real de series temporales de
 * `mongodb-memory-server` (tests de integración).
 */
export interface SnapshotsRepo {
  /**
   * Una sola agregación para todo el batch de monedas solicitadas: `$match`
   * sobre `meta.coingeckoId` -> `$sort` por `timestamp` descendente ->
   * `$group` con `$first`, para obtener el `sourceUpdatedAt` más reciente de
   * cada moneda. Las monedas sin snapshot previo simplemente están ausentes
   * del mapa devuelto.
   */
  getLastSourceUpdatedAt(coingeckoIds: readonly string[]): Promise<Map<string, Date | null>>;
  /** `insertMany(docs, { ordered: false })`; devuelve la cantidad de documentos insertados. */
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

export interface LatestSnapshotValues {
  readonly priceUsd: number;
  readonly marketCapUsd: number | null;
  readonly volume24hUsd: number | null;
  readonly change24hPct: number | null;
  readonly capturedAt: Date;
  readonly sourceUpdatedAt: Date | null;
}

interface LatestSnapshotAggregationResult {
  _id: string;
  priceUsd: number;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  change24hPct: number | null;
  capturedAt: Date;
  sourceUpdatedAt: Date | null;
}

/**
 * El punto más reciente de `price_snapshots` de cada moneda solicitada,
 * indexado por `coingeckoId` — la fuente de datos de `coins:rebuild-latest`
 * (11.1). Una sola agregación para todo el batch, con la misma forma que
 * {@link SnapshotsRepo.getLastSourceUpdatedAt} pero llevando todos los
 * campos que necesita `coins.latest`. Las monedas sin ningún snapshot
 * simplemente están ausentes del mapa devuelto.
 */
export async function getLatestSnapshotsByCoin(
  coingeckoIds: readonly string[],
): Promise<Map<string, LatestSnapshotValues>> {
  if (coingeckoIds.length === 0) {
    return new Map();
  }

  const results = await PriceSnapshotModel.aggregate<LatestSnapshotAggregationResult>([
    { $match: { 'meta.coingeckoId': { $in: [...coingeckoIds] } } },
    { $sort: { timestamp: -1 } },
    {
      $group: {
        _id: '$meta.coingeckoId',
        priceUsd: { $first: '$priceUsd' },
        marketCapUsd: { $first: '$marketCapUsd' },
        volume24hUsd: { $first: '$volume24hUsd' },
        change24hPct: { $first: '$change24hPct' },
        capturedAt: { $first: '$timestamp' },
        sourceUpdatedAt: { $first: '$sourceUpdatedAt' },
      },
    },
  ]).exec();

  return new Map(
    results.map((result) => [
      result._id,
      {
        priceUsd: result.priceUsd,
        marketCapUsd: result.marketCapUsd ?? null,
        volume24hUsd: result.volume24hUsd ?? null,
        change24hPct: result.change24hPct ?? null,
        capturedAt: result.capturedAt,
        sourceUpdatedAt: result.sourceUpdatedAt ?? null,
      },
    ]),
  );
}

/**
 * El conjunto de timestamps (epoch ms) de `price_snapshots` ya almacenados
 * para una moneda dentro de `[from, to]` — el chequeo de solapamiento de
 * `backfill:history` (11.4/11.5). Un punto cuyo timestamp exacto de upstream
 * ya está presente se omite en lugar de reemplazarse (design.md: omitir
 * nunca descarta un punto genuinamente obtenido por polling a favor de uno
 * importado de menor resolución).
 */
export async function getSnapshotTimestamps(
  coingeckoId: string,
  from: Date,
  to: Date,
): Promise<Set<number>> {
  const docs = await PriceSnapshotModel.find({
    'meta.coingeckoId': coingeckoId,
    timestamp: { $gte: from, $lte: to },
  })
    .select({ timestamp: 1, _id: 0 })
    .lean<{ timestamp: Date }[]>()
    .exec();
  return new Set(docs.map((doc) => doc.timestamp.getTime()));
}

/**
 * Las solicitudes con `interval=raw` se rechazan en lugar de truncarse una
 * vez que el rango devolvería más de esta cantidad de puntos (spec
 * price-history-api).
 */
const RAW_POINT_CAP = 2000;

interface RawSnapshotProjection {
  timestamp: Date;
  priceUsd: number;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  change24hPct: number | null;
}

/**
 * Camino de `interval=raw` (spec price-history-api 6.4): primero cuenta el
 * rango para que una solicitud por encima del tope se rechace (400) en lugar
 * de pagar el costo de una consulta que se va a descartar, y después hace
 * `find` por `meta.coingeckoId` y el rango de `timestamp`, ascendente,
 * proyectando solo los campos necesarios.
 */
async function getRawHistoryPoints(
  coingeckoId: string,
  from: Date,
  to: Date,
): Promise<RawHistoryPointDto[]> {
  const filter = { 'meta.coingeckoId': coingeckoId, timestamp: { $gte: from, $lte: to } };

  const count = await PriceSnapshotModel.countDocuments(filter).exec();
  if (count > RAW_POINT_CAP) {
    throw new ValidationError(
      `El rango solicitado con interval=raw supera los ${RAW_POINT_CAP} puntos. Use interval=1h en su lugar.`,
    );
  }

  const docs = await PriceSnapshotModel.find(filter)
    .select({
      timestamp: 1,
      priceUsd: 1,
      marketCapUsd: 1,
      volume24hUsd: 1,
      change24hPct: 1,
      _id: 0,
    })
    .sort({ timestamp: 1 })
    .lean<RawSnapshotProjection[]>()
    .exec();

  return docs.map((doc) => ({
    t: doc.timestamp,
    priceUsd: doc.priceUsd,
    marketCapUsd: doc.marketCapUsd,
    volume24hUsd: doc.volume24hUsd,
    change24hPct: doc.change24hPct,
  }));
}

interface BucketAggregationResult {
  t: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  avg: number;
  samples: number;
  sma?: number | null;
}

/**
 * Camino de `interval=1h`/`1d` (spec price-history-api 6.5/6.6): una sola
 * agregación hace `$match` de la moneda y el rango, ordena ascendente,
 * agrupa (`$group`) con `$dateTrunc` en buckets OHLC + `avg` + `samples`,
 * ordena por bucket ascendente y — cuando se solicita `sma` — agrega un
 * promedio móvil con `$setWindowFields` sobre `close`. La ventana de Mongo
 * promedia sin problema sobre menos documentos de los que pide `sma` al
 * comienzo de la serie; {@link nullifySmaWarmup} sobrescribe esos buckets de
 * calentamiento a `null` después (design.md).
 */
async function getBucketedHistoryPoints(
  coingeckoId: string,
  from: Date,
  to: Date,
  interval: Exclude<HistoryInterval, 'raw'>,
  sma: number | undefined,
): Promise<BucketedHistoryPointDto[]> {
  const unit = interval === '1h' ? 'hour' : 'day';

  const pipeline: PipelineStage[] = [
    { $match: { 'meta.coingeckoId': coingeckoId, timestamp: { $gte: from, $lte: to } } },
    { $sort: { timestamp: 1 } },
    {
      $group: {
        _id: { $dateTrunc: { date: '$timestamp', unit, timezone: 'UTC' } },
        open: { $first: '$priceUsd' },
        high: { $max: '$priceUsd' },
        low: { $min: '$priceUsd' },
        close: { $last: '$priceUsd' },
        avg: { $avg: '$priceUsd' },
        samples: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ];

  if (sma !== undefined) {
    pipeline.push({
      $setWindowFields: {
        sortBy: { _id: 1 },
        output: {
          sma: { $avg: '$close', window: { documents: [-(sma - 1), 0] } },
        },
      },
    });
  }

  pipeline.push({
    $project: {
      _id: 0,
      t: '$_id',
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      avg: 1,
      samples: 1,
      ...(sma !== undefined ? { sma: 1 } : {}),
    },
  });

  const points = await PriceSnapshotModel.aggregate<BucketAggregationResult>(pipeline).exec();

  return sma !== undefined ? nullifySmaWarmup<BucketAggregationResult>(points, sma) : points;
}

/**
 * Fuente de datos de `GET /api/v1/coins/:coingeckoId/history` (spec
 * price-history-api). Devuelve `null` para una moneda desconocida o inactiva
 * para que la ruta pueda mapear eso a 404, siguiendo la misma convención que
 * `getCoinDetail` en `coins.service.ts`.
 */
export async function getCoinHistory(
  coingeckoId: string,
  query: HistoryQuery,
): Promise<HistoryResponseDto | null> {
  if (!(await isActiveCoin(coingeckoId))) {
    return null;
  }

  const interval = query.interval ?? selectInterval(query.from, query.to);

  if (query.sma !== undefined && interval === 'raw') {
    throw new ValidationError('sma solo puede usarse junto con interval=1h o interval=1d');
  }

  assertRangeAllowed(interval, query.from, query.to);

  const points =
    interval === 'raw'
      ? await getRawHistoryPoints(coingeckoId, query.from, query.to)
      : await getBucketedHistoryPoints(coingeckoId, query.from, query.to, interval, query.sma);

  return { coingeckoId, interval, from: query.from, to: query.to, points };
}

interface StatsAggregationResult {
  open: number;
  close: number;
  min: number;
  max: number;
  avg: number;
  samples: number;
  firstAt: Date;
  lastAt: Date;
}

/**
 * Fuente de datos de `GET /api/v1/coins/:coingeckoId/stats` (spec
 * price-stats-api). Un solo pipeline calcula `open`/`close`/`min`/`max`/
 * `avg`/`samples`/`firstAt`/`lastAt`; un rango vacío produce `samples: 0`
 * con todos los demás campos en `null` en lugar de un error. Devuelve
 * `null` para una moneda desconocida o inactiva para que la ruta pueda
 * mapear eso a 404.
 */
export async function getCoinStats(
  coingeckoId: string,
  query: StatsQuery,
): Promise<StatsResponseDto | null> {
  if (!(await isActiveCoin(coingeckoId))) {
    return null;
  }

  const results = await PriceSnapshotModel.aggregate<StatsAggregationResult>([
    {
      $match: { 'meta.coingeckoId': coingeckoId, timestamp: { $gte: query.from, $lte: query.to } },
    },
    { $sort: { timestamp: 1 } },
    {
      $group: {
        _id: null,
        open: { $first: '$priceUsd' },
        close: { $last: '$priceUsd' },
        min: { $min: '$priceUsd' },
        max: { $max: '$priceUsd' },
        avg: { $avg: '$priceUsd' },
        samples: { $sum: 1 },
        firstAt: { $first: '$timestamp' },
        lastAt: { $last: '$timestamp' },
      },
    },
  ]).exec();

  const result = results[0] ?? null;

  if (!result || result.samples === 0) {
    return {
      coingeckoId,
      range: query.range,
      from: query.from,
      to: query.to,
      open: null,
      close: null,
      changePct: null,
      min: null,
      max: null,
      avg: null,
      samples: 0,
      firstAt: null,
      lastAt: null,
    };
  }

  return {
    coingeckoId,
    range: query.range,
    from: query.from,
    to: query.to,
    open: result.open,
    close: result.close,
    changePct: computeChangePct(result.open, result.close),
    min: result.min,
    max: result.max,
    avg: result.avg,
    samples: result.samples,
    firstAt: result.firstAt,
    lastAt: result.lastAt,
  };
}

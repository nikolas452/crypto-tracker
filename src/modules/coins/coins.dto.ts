/**
 * DTOs de salida del módulo de monedas y el builder que los arma a partir de
 * un documento de `coins`.
 */

/**
 * Forma de salida del snapshot `latest` desnormalizado de una moneda. Omite
 * deliberadamente `sourceUpdatedAt` — no forma parte del contrato de
 * respuesta del coin-read-api.
 */
export interface LatestDto {
  readonly priceUsd: number;
  readonly marketCapUsd: number | null;
  readonly volume24hUsd: number | null;
  readonly change24hPct: number | null;
  readonly capturedAt: Date;
}

export interface CoinListItemDto {
  readonly coingeckoId: string;
  readonly symbol: string;
  readonly name: string;
  readonly latest: LatestDto | null;
}

export interface CoinDetailDto extends CoinListItemDto {
  readonly trackedSince: Date;
}

/** El subconjunto de un documento `coins` del que leen estos builders de DTO. */
export interface CoinDtoSource {
  readonly coingeckoId: string;
  readonly symbol: string;
  readonly name: string;
  readonly latest: {
    readonly priceUsd: number;
    readonly marketCapUsd: number | null;
    readonly volume24hUsd: number | null;
    readonly change24hPct: number | null;
    readonly capturedAt: Date;
  } | null;
}

export interface CoinDetailDtoSource extends CoinDtoSource {
  readonly createdAt: Date;
}

function toLatestDto(latest: CoinDtoSource['latest']): LatestDto | null {
  if (!latest) {
    return null;
  }
  return {
    priceUsd: latest.priceUsd,
    marketCapUsd: latest.marketCapUsd,
    volume24hUsd: latest.volume24hUsd,
    change24hPct: latest.change24hPct,
    capturedAt: latest.capturedAt,
  };
}

/**
 * Builders de DTO explícitos campo por campo (design.md: "los DTOs de
 * salida son explícitos, no transforms de `toJSON`" — RNF-2.5 prohíbe filtrar
 * `_id`/`__v`, y un mapeo explícito falla de forma visible cuando se agrega
 * un campo al schema, mientras que un transform genérico empezaría a
 * exponerlo en silencio).
 */
export function toCoinListItemDto(coin: CoinDtoSource): CoinListItemDto {
  return {
    coingeckoId: coin.coingeckoId,
    symbol: coin.symbol,
    name: coin.name,
    latest: toLatestDto(coin.latest),
  };
}

export function toCoinDetailDto(coin: CoinDetailDtoSource): CoinDetailDto {
  return {
    ...toCoinListItemDto(coin),
    trackedSince: coin.createdAt,
  };
}

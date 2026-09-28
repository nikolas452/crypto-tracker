import type { LatestDto } from '../coins/coins.dto.js';

/**
 * DTO de salida de los endpoints de watchlist y el builder que lo arma a
 * partir de la proyección de la agregación / de un documento actualizado.
 * Explícito campo por campo (design.md: "los DTOs de salida son explícitos,
 * no transforms de `toJSON`") — nunca incluye `userId`, el `_id` del ítem ni
 * el `_id` de la moneda (RNF-4.3): el ítem se identifica por `coingeckoId`
 * dentro de la watchlist del que llama.
 */
export interface WatchlistItemDto {
  readonly coingeckoId: string;
  readonly symbol: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly note: string | null;
  readonly addedAt: Date;
  readonly latest: LatestDto | null;
}

/** La forma de la que lee este builder: la fila que produce la agregación de listado, o el resultado combinado de una escritura. */
export interface WatchlistItemDtoSource {
  readonly coingeckoId: string;
  readonly symbol: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly note: string | null;
  readonly addedAt: Date;
  readonly latest: WatchlistItemDto['latest'];
}

export function toWatchlistItemDto(source: WatchlistItemDtoSource): WatchlistItemDto {
  return {
    coingeckoId: source.coingeckoId,
    symbol: source.symbol,
    name: source.name,
    isActive: source.isActive,
    note: source.note,
    addedAt: source.addedAt,
    latest: source.latest
      ? {
          priceUsd: source.latest.priceUsd,
          marketCapUsd: source.latest.marketCapUsd,
          volume24hUsd: source.latest.volume24hUsd,
          change24hPct: source.latest.change24hPct,
          capturedAt: source.latest.capturedAt,
        }
      : null,
  };
}

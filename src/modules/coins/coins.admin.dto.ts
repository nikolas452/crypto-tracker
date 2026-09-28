import type { LatestDto } from './coins.dto.js';

/**
 * DTO de salida de los endpoints de administración de monedas (spec
 * admin-coin-management) y el builder que lo arma. Explícito campo por
 * campo, igual que el resto de los DTOs del proyecto — a diferencia del DTO
 * público de monedas, este SÍ incluye `isActive` (el admin necesita ver las
 * inactivas) y `watchersCount` (cuántos usuarios la siguen).
 */
export interface AdminCoinDto {
  readonly coingeckoId: string;
  readonly symbol: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly latest: LatestDto | null;
  readonly watchersCount: number;
}

export interface AdminCoinDtoSource {
  readonly coingeckoId: string;
  readonly symbol: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly latest: AdminCoinDto['latest'];
  readonly watchersCount: number;
}

export function toAdminCoinDto(source: AdminCoinDtoSource): AdminCoinDto {
  return {
    coingeckoId: source.coingeckoId,
    symbol: source.symbol,
    name: source.name,
    isActive: source.isActive,
    latest: source.latest
      ? {
          priceUsd: source.latest.priceUsd,
          marketCapUsd: source.latest.marketCapUsd,
          volume24hUsd: source.latest.volume24hUsd,
          change24hPct: source.latest.change24hPct,
          capturedAt: source.latest.capturedAt,
        }
      : null,
    watchersCount: source.watchersCount,
  };
}

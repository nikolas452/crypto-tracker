/**
 * Tipos compartidos de la integración con CoinGecko: formas de datos que
 * entran y salen del cliente HTTP.
 */

export interface SimplePrice {
  readonly priceUsd: number;
  readonly marketCapUsd: number | null;
  readonly volume24hUsd: number | null;
  readonly change24hPct: number | null;
  readonly sourceUpdatedAt: Date | null;
}

export interface MarketCoin {
  readonly coingeckoId: string;
  readonly symbol: string;
  readonly name: string;
  readonly priceUsd: number;
}

export interface GetSimplePricesResult {
  readonly prices: Map<string, SimplePrice>;
  /** Total de llamadas HTTP realizadas en todos los batches, reintentos incluidos. */
  readonly attempts: number;
}

/** Un punto de `/coins/{id}/market_chart` (11.4 / spec data-maintenance-scripts). */
export interface MarketChartPoint {
  readonly timestamp: Date;
  readonly priceUsd: number;
  readonly marketCapUsd: number | null;
  readonly volume24hUsd: number | null;
}

/**
 * Contrato de la integración con CoinGecko (RF-1.2 / spec coingecko-client).
 * Respaldado por el `fetch` nativo de Node, nunca axios.
 */
export interface CoinGeckoClient {
  getSimplePrices(ids: string[]): Promise<GetSimplePricesResult>;
  getMarkets(ids: string[]): Promise<MarketCoin[]>;
  ping(): Promise<void>;
  /** `backfill:history` (11.4): una sola llamada, nunca fraccionada (un único coin id). */
  getMarketChart(coingeckoId: string, days: number): Promise<MarketChartPoint[]>;
}

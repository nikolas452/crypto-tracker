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
  /** Total HTTP calls made across every batch, retries included. */
  readonly attempts: number;
}

/**
 * Contract for the CoinGecko integration (RF-1.2 / coingecko-client spec).
 * Backed by Node's native `fetch`, never axios.
 */
export interface CoinGeckoClient {
  getSimplePrices(ids: string[]): Promise<GetSimplePricesResult>;
  getMarkets(ids: string[]): Promise<MarketCoin[]>;
  ping(): Promise<void>;
}

import type { Logger } from 'pino';
import { z } from 'zod';
import { CoinGeckoError } from './coingecko.errors.js';
import type { CoinGeckoClient, GetSimplePricesResult, MarketCoin, SimplePrice } from './coingecko.types.js';

export type SleepFn = (ms: number) => Promise<void>;

async function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Base backoff waits (ms) before jitter, indexed by retry attempt (0 = first retry). */
const BACKOFF_MS = [1000, 3000] as const;
const JITTER_RATIO = 0.2;
const RATE_LIMIT_FALLBACK_WAIT_MS = 30000;
const RATE_LIMIT_MAX_RETRY_AFTER_S = 60;

export interface CreateCoinGeckoClientDeps {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly maxIdsPerCall: number;
  readonly logger: Logger;
  /** Injectable so tests never actually wait. Defaults to a real `setTimeout`-based sleep. */
  readonly sleep?: SleepFn;
  /** Injectable source of randomness for jitter, `[0, 1)`. Defaults to `Math.random`. */
  readonly random?: () => number;
  /** Injectable for tests (`vi.stubGlobal('fetch', ...)` also works without this). Defaults to the global `fetch`. */
  readonly fetchFn?: typeof fetch;
}

const simplePriceEntrySchema = z
  .object({
    usd: z.number().nullish(),
    usd_market_cap: z.number().nullish(),
    usd_24h_vol: z.number().nullish(),
    usd_24h_change: z.number().nullish(),
    last_updated_at: z.number().nullish(),
  })
  .passthrough();

const simplePriceResponseSchema = z.record(z.string(), simplePriceEntrySchema);

const marketCoinEntrySchema = z
  .object({
    id: z.string(),
    symbol: z.string(),
    name: z.string(),
    current_price: z.number().nullish(),
  })
  .passthrough();

const marketsResponseSchema = z.array(marketCoinEntrySchema);

function epochSecondsToDate(value: number | null | undefined): Date | null {
  return typeof value === 'number' ? new Date(value * 1000) : null;
}

function buildQuery(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

function parseRetryAfterMs(headerValue: string | null): number {
  if (headerValue === null) {
    return RATE_LIMIT_FALLBACK_WAIT_MS;
  }
  const seconds = Number(headerValue);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > RATE_LIMIT_MAX_RETRY_AFTER_S) {
    return RATE_LIMIT_FALLBACK_WAIT_MS;
  }
  return seconds * 1000;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

/**
 * Creates the CoinGecko HTTP client. Uses native `fetch` with
 * `AbortSignal.timeout(ms)` per attempt — no axios. Batches are always
 * requested sequentially, never in parallel. Every retryable failure
 * (timeout, network error, 5xx, one 429) waits via the injected `sleep`, so
 * unit tests never actually wait.
 */
export function createCoinGeckoClient(deps: CreateCoinGeckoClientDeps): CoinGeckoClient {
  const { baseUrl, apiKey, timeoutMs, maxRetries, maxIdsPerCall, logger } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const fetchFn = deps.fetchFn ?? fetch;

  function jitteredBackoff(retryIndex: number): number {
    const base = BACKOFF_MS[Math.min(retryIndex, BACKOFF_MS.length - 1)] ?? BACKOFF_MS[0];
    const jitter = 1 - JITTER_RATIO + random() * (2 * JITTER_RATIO);
    return Math.round(base * jitter);
  }

  /**
   * Performs one logical call (with retries) against `path`. Never includes
   * the API key in the path, in any log line, or in any thrown error
   * message — only the `x-cg-demo-api-key` header carries it.
   */
  async function requestWithRetry(path: string): Promise<{ json: unknown; attempts: number }> {
    let attempts = 0;
    let retriesUsed = 0;
    let rateLimitRetryUsed = false;

    for (;;) {
      attempts += 1;
      const startedAt = Date.now();
      let response: Response;

      try {
        response = await fetchFn(`${baseUrl}${path}`, {
          headers: { 'x-cg-demo-api-key': apiKey },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (cause) {
        logger.debug({ path, err: (cause as Error)?.name, durationMs: Date.now() - startedAt }, 'CoinGecko request failed');
        if (retriesUsed < maxRetries) {
          await sleep(jitteredBackoff(retriesUsed));
          retriesUsed += 1;
          continue;
        }
        throw new CoinGeckoError('COINGECKO_UNAVAILABLE', 'CoinGecko request timed out or failed (network error)', {
          cause,
          retryable: true,
        });
      }

      const durationMs = Date.now() - startedAt;
      logger.debug({ path, status: response.status, durationMs }, 'CoinGecko request');

      if (response.ok) {
        const json: unknown = await response.json();
        return { json, attempts };
      }

      if (response.status >= 500) {
        if (retriesUsed < maxRetries) {
          await sleep(jitteredBackoff(retriesUsed));
          retriesUsed += 1;
          continue;
        }
        throw new CoinGeckoError('COINGECKO_UNAVAILABLE', `CoinGecko responded with status ${response.status}`, {
          retryable: true,
        });
      }

      if (response.status === 429) {
        if (!rateLimitRetryUsed && maxRetries > 0) {
          rateLimitRetryUsed = true;
          const waitMs = parseRetryAfterMs(response.headers.get('retry-after'));
          await sleep(waitMs);
          continue;
        }
        throw new CoinGeckoError('COINGECKO_RATE_LIMITED', 'CoinGecko rate limit exceeded (429)', {
          retryable: true,
        });
      }

      if (response.status === 401 || response.status === 403) {
        const error = new CoinGeckoError(
          'COINGECKO_AUTH',
          `CoinGecko rejected the request as unauthorized (status ${response.status})`,
          { retryable: false },
        );
        logger.error({ path, status: response.status }, 'CoinGecko authentication error');
        throw error;
      }

      throw new CoinGeckoError('COINGECKO_CLIENT_ERROR', `CoinGecko responded with status ${response.status}`, {
        retryable: false,
      });
    }
  }

  async function fetchSimplePriceBatch(ids: string[]): Promise<{ entries: Record<string, unknown>; attempts: number }> {
    const query = buildQuery({
      ids: ids.join(','),
      vs_currencies: 'usd',
      include_market_cap: 'true',
      include_24hr_vol: 'true',
      include_24hr_change: 'true',
      include_last_updated_at: 'true',
    });

    const { json, attempts } = await requestWithRetry(`/simple/price?${query}`);
    const parsed = simplePriceResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new CoinGeckoError('COINGECKO_BAD_RESPONSE', 'CoinGecko simple/price response did not match the expected shape');
    }
    return { entries: parsed.data, attempts };
  }

  async function fetchMarketsBatch(ids: string[]): Promise<{ coins: MarketCoin[]; attempts: number }> {
    const query = buildQuery({ vs_currency: 'usd', ids: ids.join(',') });
    const { json, attempts } = await requestWithRetry(`/coins/markets?${query}`);
    const parsed = marketsResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new CoinGeckoError('COINGECKO_BAD_RESPONSE', 'CoinGecko coins/markets response did not match the expected shape');
    }

    const coins: MarketCoin[] = [];
    for (const entry of parsed.data) {
      if (typeof entry.current_price !== 'number' || entry.current_price <= 0) {
        logger.warn({ coingeckoId: entry.id }, 'Discarding market coin with missing or non-positive current_price');
        continue;
      }
      coins.push({
        coingeckoId: entry.id,
        symbol: entry.symbol,
        name: entry.name,
        priceUsd: entry.current_price,
      });
    }
    return { coins, attempts };
  }

  return {
    async getSimplePrices(ids) {
      const prices = new Map<string, SimplePrice>();
      let totalAttempts = 0;

      for (const batch of chunk(ids, maxIdsPerCall)) {
        const { entries, attempts } = await fetchSimplePriceBatch(batch);
        totalAttempts += attempts;

        for (const [coingeckoId, entry] of Object.entries(entries)) {
          const parsedEntry = entry as z.infer<typeof simplePriceEntrySchema>;
          if (typeof parsedEntry.usd !== 'number' || parsedEntry.usd <= 0) {
            logger.warn({ coingeckoId }, 'Discarding coin with missing or non-positive usd price');
            continue;
          }
          prices.set(coingeckoId, {
            priceUsd: parsedEntry.usd,
            marketCapUsd: parsedEntry.usd_market_cap ?? null,
            volume24hUsd: parsedEntry.usd_24h_vol ?? null,
            change24hPct: parsedEntry.usd_24h_change ?? null,
            sourceUpdatedAt: epochSecondsToDate(parsedEntry.last_updated_at),
          });
        }
      }

      const result: GetSimplePricesResult = { prices, attempts: totalAttempts };
      return result;
    },

    async getMarkets(ids) {
      const coins: MarketCoin[] = [];
      for (const batch of chunk(ids, maxIdsPerCall)) {
        const { coins: batchCoins } = await fetchMarketsBatch(batch);
        coins.push(...batchCoins);
      }
      return coins;
    },

    async ping() {
      await requestWithRetry('/ping');
    },
  };
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { createCoinGeckoClient } from '../../src/integrations/coingecko/coingecko.client.js';
import { CoinGeckoError } from '../../src/integrations/coingecko/coingecko.errors.js';

function createFakeLogger(): Logger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    fatal: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  } as unknown as Logger;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

interface ClientTestContext {
  logger: Logger;
  sleep: ReturnType<typeof vi.fn>;
  fetchFn: ReturnType<typeof vi.fn>;
  createClient: (overrides?: Partial<Parameters<typeof createCoinGeckoClient>[0]>) => ReturnType<typeof createCoinGeckoClient>;
}

function setup(): ClientTestContext {
  const logger = createFakeLogger();
  const sleep = vi.fn().mockResolvedValue(undefined);
  const fetchFn = vi.fn();

  function createClient(overrides: Partial<Parameters<typeof createCoinGeckoClient>[0]> = {}) {
    return createCoinGeckoClient({
      baseUrl: 'https://api.coingecko.com/api/v3',
      apiKey: 'super-secret-demo-key',
      timeoutMs: 10000,
      maxRetries: 2,
      maxIdsPerCall: 50,
      logger,
      sleep,
      random: () => 0.5,
      fetchFn: fetchFn as unknown as typeof fetch,
      ...overrides,
    });
  }

  return { logger, sleep, fetchFn, createClient };
}

describe('createCoinGeckoClient - getSimplePrices', () => {
  let ctx: ClientTestContext;

  beforeEach(() => {
    ctx = setup();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps fields including null and epoch -> Date', async () => {
    ctx.fetchFn.mockResolvedValueOnce(
      jsonResponse(200, {
        bitcoin: {
          usd: 65000.5,
          usd_market_cap: 1_000_000,
          usd_24h_vol: null,
          usd_24h_change: undefined,
          last_updated_at: 1_700_000_000,
        },
      }),
    );

    const client = ctx.createClient();
    const { prices, attempts } = await client.getSimplePrices(['bitcoin']);

    expect(attempts).toBe(1);
    const bitcoin = prices.get('bitcoin');
    expect(bitcoin).toEqual({
      priceUsd: 65000.5,
      marketCapUsd: 1_000_000,
      volume24hUsd: null,
      change24hPct: null,
      sourceUpdatedAt: new Date(1_700_000_000 * 1000),
    });
  });

  it('discards a coin whose usd is missing', async () => {
    ctx.fetchFn.mockResolvedValueOnce(jsonResponse(200, { ghost: { usd: null } }));

    const client = ctx.createClient();
    const { prices } = await client.getSimplePrices(['ghost']);

    expect(prices.has('ghost')).toBe(false);
    expect(ctx.logger.warn).toHaveBeenCalled();
  });

  it('discards a coin whose usd is non-positive', async () => {
    ctx.fetchFn.mockResolvedValueOnce(jsonResponse(200, { deadcoin: { usd: 0 } }));

    const client = ctx.createClient();
    const { prices } = await client.getSimplePrices(['deadcoin']);

    expect(prices.has('deadcoin')).toBe(false);
  });

  it('throws COINGECKO_BAD_RESPONSE when the shape does not match at all', async () => {
    ctx.fetchFn.mockResolvedValueOnce(jsonResponse(200, ['not', 'an', 'object']));

    const client = ctx.createClient();

    await expect(client.getSimplePrices(['bitcoin'])).rejects.toMatchObject({
      internalCode: 'COINGECKO_BAD_RESPONSE',
    });
  });

  it('splits 120 ids into 3 sequential batches of 50', async () => {
    const calls: string[] = [];
    ctx.fetchFn.mockImplementation((url: string) => {
      calls.push(url);
      return Promise.resolve(jsonResponse(200, {}));
    });

    const client = ctx.createClient({ maxIdsPerCall: 50 });
    const ids = Array.from({ length: 120 }, (_, i) => `coin-${i}`);
    await client.getSimplePrices(ids);

    expect(ctx.fetchFn).toHaveBeenCalledTimes(3);
    const decoded = calls.map((url) => decodeURIComponent(url));
    expect(decoded[0]).toContain(ids.slice(0, 50).join(','));
    expect(decoded[1]).toContain(ids.slice(50, 100).join(','));
    expect(decoded[2]).toContain(ids.slice(100, 120).join(','));
  });

  it('401 throws COINGECKO_AUTH without retrying and logs at error', async () => {
    ctx.fetchFn.mockResolvedValueOnce(jsonResponse(401, {}));

    const client = ctx.createClient();

    await expect(client.getSimplePrices(['bitcoin'])).rejects.toMatchObject({
      internalCode: 'COINGECKO_AUTH',
    });
    expect(ctx.fetchFn).toHaveBeenCalledTimes(1);
    expect(ctx.logger.error).toHaveBeenCalled();
  });

  it('403 throws COINGECKO_AUTH without retrying', async () => {
    ctx.fetchFn.mockResolvedValueOnce(jsonResponse(403, {}));

    const client = ctx.createClient();

    await expect(client.getSimplePrices(['bitcoin'])).rejects.toMatchObject({
      internalCode: 'COINGECKO_AUTH',
    });
    expect(ctx.fetchFn).toHaveBeenCalledTimes(1);
  });

  it('other 4xx throws COINGECKO_CLIENT_ERROR without retrying', async () => {
    ctx.fetchFn.mockResolvedValueOnce(jsonResponse(404, {}));

    const client = ctx.createClient();

    await expect(client.getSimplePrices(['bitcoin'])).rejects.toMatchObject({
      internalCode: 'COINGECKO_CLIENT_ERROR',
    });
    expect(ctx.fetchFn).toHaveBeenCalledTimes(1);
  });

  it('retries transient 503s and succeeds on the 3rd attempt (attempts=3)', async () => {
    ctx.fetchFn
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(jsonResponse(200, { bitcoin: { usd: 100 } }));

    const client = ctx.createClient({ maxRetries: 2 });
    const { attempts, prices } = await client.getSimplePrices(['bitcoin']);

    expect(attempts).toBe(3);
    expect(prices.get('bitcoin')?.priceUsd).toBe(100);
    expect(ctx.sleep).toHaveBeenCalledTimes(2);
  });

  it('exhausts retries and throws COINGECKO_UNAVAILABLE on persistent 503s', async () => {
    ctx.fetchFn.mockResolvedValue(jsonResponse(503, {}));

    const client = ctx.createClient({ maxRetries: 2 });

    await expect(client.getSimplePrices(['bitcoin'])).rejects.toMatchObject({
      internalCode: 'COINGECKO_UNAVAILABLE',
    });
    expect(ctx.fetchFn).toHaveBeenCalledTimes(3);
  });

  it('retries a network/timeout failure as COINGECKO_UNAVAILABLE', async () => {
    ctx.fetchFn
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(jsonResponse(200, { bitcoin: { usd: 100 } }));

    const client = ctx.createClient({ maxRetries: 2 });
    const { attempts } = await client.getSimplePrices(['bitcoin']);

    expect(attempts).toBe(2);
  });

  it('respects Retry-After up to a 60s cap on 429', async () => {
    ctx.fetchFn
      .mockResolvedValueOnce(jsonResponse(429, {}, { 'Retry-After': '45' }))
      .mockResolvedValueOnce(jsonResponse(200, { bitcoin: { usd: 100 } }));

    const client = ctx.createClient({ maxRetries: 2 });
    await client.getSimplePrices(['bitcoin']);

    expect(ctx.sleep).toHaveBeenCalledWith(45000);
  });

  it('falls back to 30s when Retry-After is missing', async () => {
    ctx.fetchFn
      .mockResolvedValueOnce(jsonResponse(429, {}))
      .mockResolvedValueOnce(jsonResponse(200, { bitcoin: { usd: 100 } }));

    const client = ctx.createClient({ maxRetries: 2 });
    await client.getSimplePrices(['bitcoin']);

    expect(ctx.sleep).toHaveBeenCalledWith(30000);
  });

  it('falls back to 30s when Retry-After exceeds 60s', async () => {
    ctx.fetchFn
      .mockResolvedValueOnce(jsonResponse(429, {}, { 'Retry-After': '120' }))
      .mockResolvedValueOnce(jsonResponse(200, { bitcoin: { usd: 100 } }));

    const client = ctx.createClient({ maxRetries: 2 });
    await client.getSimplePrices(['bitcoin']);

    expect(ctx.sleep).toHaveBeenCalledWith(30000);
  });

  it('429 is retried only once, even with more retry budget left', async () => {
    ctx.fetchFn.mockResolvedValue(jsonResponse(429, {}));

    const client = ctx.createClient({ maxRetries: 2 });

    await expect(client.getSimplePrices(['bitcoin'])).rejects.toMatchObject({
      internalCode: 'COINGECKO_RATE_LIMITED',
    });
    expect(ctx.fetchFn).toHaveBeenCalledTimes(2);
  });

  it('never includes the API key in a thrown error message', async () => {
    ctx.fetchFn.mockResolvedValue(jsonResponse(401, {}));
    const client = ctx.createClient();

    try {
      await client.getSimplePrices(['bitcoin']);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain('super-secret-demo-key');
      expect(JSON.stringify(error)).not.toContain('super-secret-demo-key');
    }
  });

  it('never includes the API key in any log call', async () => {
    ctx.fetchFn.mockResolvedValueOnce(jsonResponse(200, { bitcoin: { usd: 100 } }));
    const client = ctx.createClient();
    await client.getSimplePrices(['bitcoin']);

    const allLogCalls = [
      ...(ctx.logger.debug as ReturnType<typeof vi.fn>).mock.calls,
      ...(ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls,
      ...(ctx.logger.error as ReturnType<typeof vi.fn>).mock.calls,
    ];
    expect(JSON.stringify(allLogCalls)).not.toContain('super-secret-demo-key');
  });
});

describe('createCoinGeckoClient - CoinGeckoError instance', () => {
  it('is an instance of CoinGeckoError with retryable metadata', async () => {
    const ctx = setup();
    ctx.fetchFn.mockResolvedValue(jsonResponse(500, {}));
    const client = ctx.createClient({ maxRetries: 0 });

    try {
      await client.getSimplePrices(['bitcoin']);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CoinGeckoError);
      expect((error as CoinGeckoError).retryable).toBe(true);
    }
  });
});

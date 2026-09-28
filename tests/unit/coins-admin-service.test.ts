import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { Types } from 'mongoose';
import { ConflictError, UnprocessableError, UpstreamError } from '../../src/lib/errors.js';
import {
  createOrReactivateCoin,
  type CreateOrReactivateCoinDeps,
} from '../../src/modules/coins/coins.admin.service.js';
import type { CoinRef, CoinsRepo } from '../../src/modules/coins/coins.service.js';
import type { MarketCoin } from '../../src/integrations/coingecko/coingecko.types.js';

/**
 * Tests unitarios de `createOrReactivateCoin` (`src/modules/coins/coins.admin.service.ts`):
 * alta, reactivación, conflicto, id desconocido y falla upstream, con un
 * cliente de CoinGecko falso, un `CoinsRepo` falso y un `findCoin` falso —
 * nunca toca Mongo real, a diferencia de los tests de integración
 * E4-8/E4-10/E4-11.
 */

const silentLogger = pino({ level: 'silent' });
const ADMIN_USER_ID = new Types.ObjectId().toString();

function makeMarketCoin(overrides: Partial<MarketCoin> = {}): MarketCoin {
  return { coingeckoId: 'bitcoin', symbol: 'btc', name: 'Bitcoin', priceUsd: 50000, ...overrides };
}

function makeCoinRef(overrides: Partial<CoinRef> = {}): CoinRef {
  return {
    id: new Types.ObjectId(),
    coingeckoId: 'bitcoin',
    symbol: 'btc',
    name: 'Bitcoin',
    isActive: true,
    latest: null,
    ...overrides,
  };
}

function createFakeCoinsRepo(): CoinsRepo & { upsertFromMarket: ReturnType<typeof vi.fn> } {
  return {
    findActive: vi.fn(),
    upsertFromMarket: vi.fn(async (input) => ({ coingeckoId: input.coingeckoId, created: true })),
    refreshLatest: vi.fn(),
  };
}

/** `findCoin` falso: primera llamada = lookup previo a la escritura, segunda = relectura posterior. */
function makeFindCoin(before: CoinRef | null, after: CoinRef | null = before) {
  let calls = 0;
  return vi.fn(async () => {
    calls += 1;
    return calls === 1 ? before : after;
  });
}

const noWatchers = vi.fn(async () => new Map<string, number>());

describe('createOrReactivateCoin', () => {
  it('creates a new coin (created: true) when it does not exist yet in the catalog', async () => {
    const coinsRepo = createFakeCoinsRepo();
    const deps: CreateOrReactivateCoinDeps = {
      coingecko: { getMarkets: vi.fn(async () => [makeMarketCoin()]) },
      coinsRepo,
      logger: silentLogger,
      findCoin: makeFindCoin(null, makeCoinRef({ isActive: true })),
      countWatchers: noWatchers,
    };

    const result = await createOrReactivateCoin('bitcoin', ADMIN_USER_ID, deps);

    expect(result.created).toBe(true);
    expect(result.dto.isActive).toBe(true);
    expect(coinsRepo.upsertFromMarket).toHaveBeenCalledWith({
      coingeckoId: 'bitcoin',
      symbol: 'btc',
      name: 'Bitcoin',
    });
  });

  it('reactivates an existing inactive coin (created: false)', async () => {
    const coinsRepo = createFakeCoinsRepo();
    const existingInactive = makeCoinRef({ isActive: false });
    const deps: CreateOrReactivateCoinDeps = {
      coingecko: { getMarkets: vi.fn(async () => [makeMarketCoin()]) },
      coinsRepo,
      logger: silentLogger,
      findCoin: makeFindCoin(existingInactive, { ...existingInactive, isActive: true }),
      countWatchers: noWatchers,
    };

    const result = await createOrReactivateCoin('bitcoin', ADMIN_USER_ID, deps);

    expect(result.created).toBe(false);
    expect(result.dto.isActive).toBe(true);
  });

  it('rejects with 409 CONFLICT when the coin already exists and is active', async () => {
    const coinsRepo = createFakeCoinsRepo();
    const deps: CreateOrReactivateCoinDeps = {
      coingecko: { getMarkets: vi.fn(async () => [makeMarketCoin()]) },
      coinsRepo,
      logger: silentLogger,
      findCoin: makeFindCoin(makeCoinRef({ isActive: true })),
      countWatchers: noWatchers,
    };

    await expect(createOrReactivateCoin('bitcoin', ADMIN_USER_ID, deps)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(coinsRepo.upsertFromMarket).not.toHaveBeenCalled();
  });

  it('rejects with 422 UNKNOWN_COINGECKO_ID when CoinGecko does not return the id', async () => {
    const coinsRepo = createFakeCoinsRepo();
    const deps: CreateOrReactivateCoinDeps = {
      coingecko: { getMarkets: vi.fn(async () => []) },
      coinsRepo,
      logger: silentLogger,
      findCoin: makeFindCoin(null),
      countWatchers: noWatchers,
    };

    try {
      await createOrReactivateCoin('not-a-real-coin', ADMIN_USER_ID, deps);
      expect.unreachable('createOrReactivateCoin should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UnprocessableError);
      expect((error as UnprocessableError).details).toEqual({ reason: 'UNKNOWN_COINGECKO_ID' });
    }
    expect(coinsRepo.upsertFromMarket).not.toHaveBeenCalled();
  });

  it('translates any getMarkets failure into a 502 UpstreamError', async () => {
    const coinsRepo = createFakeCoinsRepo();
    const upstreamFailure = new Error('CoinGecko unreachable');
    const deps: CreateOrReactivateCoinDeps = {
      coingecko: {
        getMarkets: vi.fn(async () => {
          throw upstreamFailure;
        }),
      },
      coinsRepo,
      logger: silentLogger,
      findCoin: makeFindCoin(null),
      countWatchers: noWatchers,
    };

    await expect(createOrReactivateCoin('bitcoin', ADMIN_USER_ID, deps)).rejects.toBeInstanceOf(
      UpstreamError,
    );
    expect(coinsRepo.upsertFromMarket).not.toHaveBeenCalled();
  });
});

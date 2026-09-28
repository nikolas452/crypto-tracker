import { describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { ConflictError, NotFoundError, UnprocessableError } from '../../src/lib/errors.js';
import {
  addWatchlistItem,
  type WatchlistItemRecord,
  type WatchlistRepo,
} from '../../src/modules/watchlist/watchlist.service.js';
import type { CoinRef } from '../../src/modules/coins/coins.service.js';

/**
 * Tests unitarios de `addWatchlistItem` (`src/modules/watchlist/watchlist.service.ts`):
 * el orden fijo de validaciones de RF-4.2 y la traducción de `E11000` a
 * `ConflictError`. Usa un `WatchlistRepo` falso en memoria y un `findCoin`
 * falso — nunca toca Mongo real, a diferencia de los tests de integración
 * E4-1 a E4-13.
 */

function makeCoin(overrides: Partial<CoinRef> = {}): CoinRef {
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

function makeRecord(overrides: Partial<WatchlistItemRecord> = {}): WatchlistItemRecord {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    coinId: new Types.ObjectId(),
    note: null,
    addedAt: now,
    updatedAt: now,
    ...overrides,
  };
}

interface FakeRepoOptions {
  readonly count?: number;
  readonly insertResult?: WatchlistItemRecord;
  readonly insertError?: unknown;
}

function createFakeRepo(options: FakeRepoOptions = {}): WatchlistRepo & {
  countByUser: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
} {
  const countByUser = vi.fn(async () => options.count ?? 0);
  const insert = vi.fn(async () => {
    if (options.insertError) {
      throw options.insertError;
    }
    return options.insertResult ?? makeRecord();
  });

  return {
    countByUser,
    insert,
    findByUserAndCoin: vi.fn(),
    updateNote: vi.fn(),
    deleteByUserAndCoin: vi.fn(),
    deleteAllByUser: vi.fn(),
    listByUser: vi.fn(),
    countWatchersByCoinIds: vi.fn(),
  };
}

const USER_ID = new Types.ObjectId().toString();

describe('addWatchlistItem — orden de validaciones (RF-4.2)', () => {
  it('rejects with 404 NOT_FOUND when the coin does not exist, without counting or inserting', async () => {
    const repo = createFakeRepo();
    const findCoin = vi.fn(async () => null);

    await expect(
      addWatchlistItem(USER_ID, { coingeckoId: 'unknown' }, { repo, findCoin }),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(repo.countByUser).not.toHaveBeenCalled();
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('rejects with 404 NOT_FOUND when the coin exists but is inactive, without counting or inserting', async () => {
    const repo = createFakeRepo();
    const findCoin = vi.fn(async () => makeCoin({ isActive: false }));

    await expect(
      addWatchlistItem(USER_ID, { coingeckoId: 'bitcoin' }, { repo, findCoin }),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(repo.countByUser).not.toHaveBeenCalled();
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('rejects with 422 UNPROCESSABLE / LIMIT_REACHED when the user is already at the cap, without inserting', async () => {
    const repo = createFakeRepo({ count: 2 });
    const findCoin = vi.fn(async () => makeCoin());

    try {
      await addWatchlistItem(
        USER_ID,
        { coingeckoId: 'bitcoin' },
        { repo, findCoin, cfg: { WATCHLIST_MAX_ITEMS: 2 } },
      );
      expect.unreachable('addWatchlistItem should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UnprocessableError);
      expect((error as UnprocessableError).details).toEqual({ reason: 'LIMIT_REACHED' });
    }

    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('inserts and returns the item in listing shape when every validation passes', async () => {
    const coin = makeCoin();
    const record = makeRecord({ coinId: coin.id, note: 'largo plazo' });
    const repo = createFakeRepo({ count: 0, insertResult: record });
    const findCoin = vi.fn(async () => coin);

    const result = await addWatchlistItem(
      USER_ID,
      { coingeckoId: 'bitcoin', note: 'largo plazo' },
      { repo, findCoin, cfg: { WATCHLIST_MAX_ITEMS: 50 } },
    );

    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ coinId: coin.id, note: 'largo plazo' }),
    );
    expect(result).toMatchObject({
      coingeckoId: 'bitcoin',
      symbol: 'btc',
      name: 'Bitcoin',
      isActive: true,
      note: 'largo plazo',
    });
  });
});

describe('addWatchlistItem — traducción de E11000 (RF-4.2)', () => {
  it('translates a duplicate-key error from the repository into a 409 ConflictError', async () => {
    const duplicateKeyError = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    const repo = createFakeRepo({ count: 0, insertError: duplicateKeyError });
    const findCoin = vi.fn(async () => makeCoin());

    await expect(
      addWatchlistItem(USER_ID, { coingeckoId: 'bitcoin' }, { repo, findCoin }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('propagates any other insert error unchanged', async () => {
    const otherError = new Error('unexpected failure');
    const repo = createFakeRepo({ count: 0, insertError: otherError });
    const findCoin = vi.fn(async () => makeCoin());

    await expect(
      addWatchlistItem(USER_ID, { coingeckoId: 'bitcoin' }, { repo, findCoin }),
    ).rejects.toBe(otherError);
  });
});

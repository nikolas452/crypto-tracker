import { describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import type { Logger } from 'pino';
import { createPollPricesJob } from '../../src/jobs/pollPrices.js';
import type { ActiveCoin, CoinsRepo } from '../../src/modules/coins/coins.service.js';
import type { NewSnapshotInput, SnapshotsRepo } from '../../src/modules/snapshots/snapshots.service.js';
import type { CloseRunInput, CreateRunningInput, JobRunsRepo } from '../../src/modules/job-runs/job-runs.service.js';
import type { SimplePrice } from '../../src/integrations/coingecko/coingecko.types.js';
import { CoinGeckoError } from '../../src/integrations/coingecko/coingecko.errors.js';
import type { Clock } from '../../src/lib/clock.js';

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

function activeCoin(coingeckoId: string): ActiveCoin {
  return { id: new Types.ObjectId(), coingeckoId };
}

function simplePrice(overrides: Partial<SimplePrice> = {}): SimplePrice {
  return {
    priceUsd: 100,
    marketCapUsd: null,
    volume24hUsd: null,
    change24hPct: null,
    sourceUpdatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** A clock that advances by a fixed step on every `now()` call, so start/finish differ deterministically. */
function createSteppingClock(startAt: Date, stepMs = 50): Clock {
  let current = startAt.getTime();
  let first = true;
  return {
    now() {
      if (first) {
        first = false;
        return new Date(current);
      }
      current += stepMs;
      return new Date(current);
    },
  };
}

interface FakeCoinsRepo extends CoinsRepo {
  coins: ActiveCoin[];
}

function createFakeCoinsRepo(coins: ActiveCoin[]): FakeCoinsRepo {
  return {
    coins,
    async findActive() {
      return coins;
    },
    async upsertFromMarket() {
      throw new Error('not used in job tests');
    },
  };
}

interface FakeSnapshotsRepoOptions {
  lastSourceUpdatedAt?: Map<string, Date | null>;
}

function createFakeSnapshotsRepo(options: FakeSnapshotsRepoOptions = {}): SnapshotsRepo & { inserted: NewSnapshotInput[] } {
  const inserted: NewSnapshotInput[] = [];
  return {
    inserted,
    async getLastSourceUpdatedAt() {
      return options.lastSourceUpdatedAt ?? new Map();
    },
    async insertMany(docs) {
      inserted.push(...docs);
      return docs.length;
    },
  };
}

function createFakeJobRunsRepo(): JobRunsRepo & { closed: Array<{ id: Types.ObjectId; patch: CloseRunInput }>; created: CreateRunningInput[] } {
  const closed: Array<{ id: Types.ObjectId; patch: CloseRunInput }> = [];
  const created: CreateRunningInput[] = [];
  return {
    closed,
    created,
    async createRunning(input) {
      created.push(input);
      return new Types.ObjectId();
    },
    async closeRun(id, patch) {
      closed.push({ id, patch });
    },
    async createSkipped() {
      return new Types.ObjectId();
    },
    async recoverStaleRuns() {
      return 0;
    },
  };
}

describe('createPollPricesJob', () => {
  // E1-5
  it('E1-5: all 3 requested coins returned -> success, 3 snapshots inserted with the same timestamp', async () => {
    const coins = [activeCoin('bitcoin'), activeCoin('ethereum'), activeCoin('solana')];
    const coinsRepo = createFakeCoinsRepo(coins);
    const snapshotsRepo = createFakeSnapshotsRepo();
    const jobRunsRepo = createFakeJobRunsRepo();
    const getSimplePrices = vi.fn().mockResolvedValue({
      prices: new Map([
        ['bitcoin', simplePrice()],
        ['ethereum', simplePrice()],
        ['solana', simplePrice()],
      ]),
      attempts: 1,
    });

    const job = createPollPricesJob({
      coinsRepo,
      snapshotsRepo,
      jobRunsRepo,
      coingecko: { getSimplePrices },
      clock: createSteppingClock(new Date('2026-01-01T00:00:00.000Z')),
      logger: createFakeLogger(),
      workerId: 'test-worker-1',
    });

    const result = await job.run('manual');

    expect(result.status).toBe('success');
    expect(result.stats.snapshotsInserted).toBe(3);
    expect(snapshotsRepo.inserted).toHaveLength(3);
    const timestamps = new Set(snapshotsRepo.inserted.map((doc) => doc.timestamp.getTime()));
    expect(timestamps.size).toBe(1);
    expect(jobRunsRepo.closed[0]?.patch.status).toBe('success');
  });

  // E1-6
  it('E1-6: unchanged sourceUpdatedAt is skipped and counted, not duplicated', async () => {
    const sameInstant = new Date('2026-01-01T00:00:00.000Z');
    const coins = [activeCoin('bitcoin')];
    const coinsRepo = createFakeCoinsRepo(coins);
    const snapshotsRepo = createFakeSnapshotsRepo({
      lastSourceUpdatedAt: new Map([['bitcoin', sameInstant]]),
    });
    const jobRunsRepo = createFakeJobRunsRepo();
    const getSimplePrices = vi.fn().mockResolvedValue({
      prices: new Map([['bitcoin', simplePrice({ sourceUpdatedAt: sameInstant })]]),
      attempts: 1,
    });

    const job = createPollPricesJob({
      coinsRepo,
      snapshotsRepo,
      jobRunsRepo,
      coingecko: { getSimplePrices },
      clock: createSteppingClock(new Date()),
      logger: createFakeLogger(),
      workerId: 'w',
    });

    const result = await job.run('schedule');

    expect(snapshotsRepo.inserted).toHaveLength(0);
    expect(result.stats.skippedUnchanged).toBe(1);
    expect(result.status).toBe('success');
  });

  it('inserts anyway when either sourceUpdatedAt value is null', async () => {
    const coins = [activeCoin('bitcoin')];
    const coinsRepo = createFakeCoinsRepo(coins);
    const snapshotsRepo = createFakeSnapshotsRepo({
      lastSourceUpdatedAt: new Map([['bitcoin', null]]),
    });
    const jobRunsRepo = createFakeJobRunsRepo();
    const getSimplePrices = vi.fn().mockResolvedValue({
      prices: new Map([['bitcoin', simplePrice({ sourceUpdatedAt: new Date() })]]),
      attempts: 1,
    });

    const job = createPollPricesJob({
      coinsRepo,
      snapshotsRepo,
      jobRunsRepo,
      coingecko: { getSimplePrices },
      clock: createSteppingClock(new Date()),
      logger: createFakeLogger(),
      workerId: 'w',
    });

    const result = await job.run('schedule');

    expect(snapshotsRepo.inserted).toHaveLength(1);
    expect(result.stats.skippedUnchanged).toBe(0);
  });

  // E1-7
  it('E1-7: 2 of 3 coins returned -> partial with the missing coin listed', async () => {
    const coins = [activeCoin('bitcoin'), activeCoin('ethereum'), activeCoin('solana')];
    const coinsRepo = createFakeCoinsRepo(coins);
    const snapshotsRepo = createFakeSnapshotsRepo();
    const jobRunsRepo = createFakeJobRunsRepo();
    const getSimplePrices = vi.fn().mockResolvedValue({
      prices: new Map([
        ['bitcoin', simplePrice()],
        ['ethereum', simplePrice()],
      ]),
      attempts: 1,
    });

    const job = createPollPricesJob({
      coinsRepo,
      snapshotsRepo,
      jobRunsRepo,
      coingecko: { getSimplePrices },
      clock: createSteppingClock(new Date()),
      logger: createFakeLogger(),
      workerId: 'w',
    });

    const result = await job.run('schedule');

    expect(result.status).toBe('partial');
    expect(result.stats.missingCoins).toEqual(['solana']);
  });

  // E1-8: attempts reflects total upstream calls including retries (the client itself is faked here,
  // simulating that it already retried twice before succeeding).
  it('E1-8: reflects upstreamAttempts from the CoinGecko client result', async () => {
    const coins = [activeCoin('bitcoin')];
    const coinsRepo = createFakeCoinsRepo(coins);
    const snapshotsRepo = createFakeSnapshotsRepo();
    const jobRunsRepo = createFakeJobRunsRepo();
    const getSimplePrices = vi.fn().mockResolvedValue({
      prices: new Map([['bitcoin', simplePrice()]]),
      attempts: 3,
    });

    const job = createPollPricesJob({
      coinsRepo,
      snapshotsRepo,
      jobRunsRepo,
      coingecko: { getSimplePrices },
      clock: createSteppingClock(new Date()),
      logger: createFakeLogger(),
      workerId: 'w',
    });

    const result = await job.run('schedule');

    expect(result.status).toBe('success');
    expect(result.stats.upstreamAttempts).toBe(3);
  });

  // E1-9
  it('E1-9: CoinGecko failing on every attempt -> failed with the upstream error code, run() still resolves', async () => {
    const coins = [activeCoin('bitcoin')];
    const coinsRepo = createFakeCoinsRepo(coins);
    const snapshotsRepo = createFakeSnapshotsRepo();
    const jobRunsRepo = createFakeJobRunsRepo();
    const getSimplePrices = vi
      .fn()
      .mockRejectedValue(new CoinGeckoError('COINGECKO_UNAVAILABLE', 'CoinGecko responded with status 503', { retryable: true }));

    const job = createPollPricesJob({
      coinsRepo,
      snapshotsRepo,
      jobRunsRepo,
      coingecko: { getSimplePrices },
      clock: createSteppingClock(new Date()),
      logger: createFakeLogger(),
      workerId: 'w',
    });

    const result = await job.run('schedule');

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('COINGECKO_UNAVAILABLE');
  });

  // E1-12
  it('E1-12: no active coins -> skipped/no_active_coins without calling CoinGecko', async () => {
    const coinsRepo = createFakeCoinsRepo([]);
    const snapshotsRepo = createFakeSnapshotsRepo();
    const jobRunsRepo = createFakeJobRunsRepo();
    const getSimplePrices = vi.fn();

    const job = createPollPricesJob({
      coinsRepo,
      snapshotsRepo,
      jobRunsRepo,
      coingecko: { getSimplePrices },
      clock: createSteppingClock(new Date()),
      logger: createFakeLogger(),
      workerId: 'w',
    });

    const result = await job.run('schedule');

    expect(result.status).toBe('skipped');
    expect(result.skipReason).toBe('no_active_coins');
    expect(getSimplePrices).not.toHaveBeenCalled();
  });

  it('run() never throws even when jobRunsRepo.createRunning rejects', async () => {
    const coinsRepo = createFakeCoinsRepo([activeCoin('bitcoin')]);
    const snapshotsRepo = createFakeSnapshotsRepo();
    const jobRunsRepo: JobRunsRepo = {
      createRunning: vi.fn().mockRejectedValue(new Error('mongo is down')),
      closeRun: vi.fn(),
      createSkipped: vi.fn(),
      recoverStaleRuns: vi.fn(),
    };

    const job = createPollPricesJob({
      coinsRepo,
      snapshotsRepo,
      jobRunsRepo,
      coingecko: { getSimplePrices: vi.fn() },
      clock: createSteppingClock(new Date()),
      logger: createFakeLogger(),
      workerId: 'w',
    });

    await expect(job.run('schedule')).resolves.toMatchObject({ status: 'failed' });
  });

  it('run() never throws even when jobRunsRepo.closeRun rejects', async () => {
    const coinsRepo = createFakeCoinsRepo([]);
    const snapshotsRepo = createFakeSnapshotsRepo();
    const jobRunsRepo: JobRunsRepo = {
      createRunning: vi.fn().mockResolvedValue(new Types.ObjectId()),
      closeRun: vi.fn().mockRejectedValue(new Error('mongo write failed')),
      createSkipped: vi.fn(),
      recoverStaleRuns: vi.fn(),
    };

    const job = createPollPricesJob({
      coinsRepo,
      snapshotsRepo,
      jobRunsRepo,
      coingecko: { getSimplePrices: vi.fn() },
      clock: createSteppingClock(new Date()),
      logger: createFakeLogger(),
      workerId: 'w',
    });

    await expect(job.run('schedule')).resolves.toMatchObject({ status: 'skipped', skipReason: 'no_active_coins' });
  });

  it('run() never throws on an unexpected synchronous-looking dependency rejection', async () => {
    const coinsRepo: CoinsRepo = {
      findActive: vi.fn().mockRejectedValue(new TypeError('boom')),
      upsertFromMarket: vi.fn(),
    };
    const snapshotsRepo = createFakeSnapshotsRepo();
    const jobRunsRepo = createFakeJobRunsRepo();

    const job = createPollPricesJob({
      coinsRepo,
      snapshotsRepo,
      jobRunsRepo,
      coingecko: { getSimplePrices: vi.fn() },
      clock: createSteppingClock(new Date()),
      logger: createFakeLogger(),
      workerId: 'w',
    });

    const result = await job.run('schedule');
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('INTERNAL');
  });
});

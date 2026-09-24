import { describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { parseArgs, runBackfillHistory } from '../../src/scripts/backfillHistory.js';
import type { MarketChartPoint } from '../../src/integrations/coingecko/coingecko.types.js';

/** Tests unitarios del script `backfillHistory` de `src/scripts/backfillHistory.ts`. */

function point(overrides: Partial<MarketChartPoint> = {}): MarketChartPoint {
  return {
    timestamp: new Date('2026-01-01T00:00:00.000Z'),
    priceUsd: 50000,
    marketCapUsd: null,
    volume24hUsd: null,
    ...overrides,
  };
}

describe('backfillHistory: parseArgs', () => {
  it('parses coingeckoId, --days and defaults skipConfirm to false', () => {
    expect(parseArgs(['bitcoin', '--days', '30'])).toEqual({
      coingeckoId: 'bitcoin',
      days: 30,
      skipConfirm: false,
    });
  });

  it('accepts --yes and --force as skipConfirm', () => {
    expect(parseArgs(['bitcoin', '--days', '30', '--yes'])).toMatchObject({ skipConfirm: true });
    expect(parseArgs(['bitcoin', '--days', '30', '--force'])).toMatchObject({ skipConfirm: true });
  });

  it('lowercases and trims the coingeckoId', () => {
    expect(parseArgs([' Bitcoin ', '--days', '1'])).toMatchObject({ coingeckoId: 'bitcoin' });
  });

  it('throws when the coingeckoId does not match the allowed pattern', () => {
    expect(() => parseArgs(['Not Valid!', '--days', '1'])).toThrow(/Usage/);
  });

  it('throws when --days is missing', () => {
    expect(() => parseArgs(['bitcoin'])).toThrow(/Usage/);
  });

  it('throws when --days is zero, negative, or not an integer', () => {
    expect(() => parseArgs(['bitcoin', '--days', '0'])).toThrow();
    expect(() => parseArgs(['bitcoin', '--days', '-5'])).toThrow();
    expect(() => parseArgs(['bitcoin', '--days', '1.5'])).toThrow();
    expect(() => parseArgs(['bitcoin', '--days', 'abc'])).toThrow();
  });
});

describe('backfillHistory: runBackfillHistory', () => {
  it('imports every point when none already exist', async () => {
    const coinId = new Types.ObjectId();
    const inserted: unknown[] = [];

    const summary = await runBackfillHistory({
      coingeckoId: 'bitcoin',
      coinId,
      points: [
        point({ timestamp: new Date('2026-01-01T00:00:00.000Z') }),
        point({ timestamp: new Date('2026-01-01T01:00:00.000Z') }),
      ],
      getExistingTimestamps: vi.fn().mockResolvedValue(new Set()),
      insertSnapshots: vi.fn(async (docs) => {
        inserted.push(...docs);
        return docs.length;
      }),
    });

    expect(summary).toEqual({ imported: 2, skipped: 0 });
    expect(inserted).toHaveLength(2);
  });

  it('skips points whose exact upstream timestamp already exists, never deleting them', async () => {
    const coinId = new Types.ObjectId();
    const existingTs = new Date('2026-01-01T00:00:00.000Z').getTime();
    const insertSnapshots = vi.fn(async (docs: readonly unknown[]) => docs.length);

    const summary = await runBackfillHistory({
      coingeckoId: 'bitcoin',
      coinId,
      points: [
        point({ timestamp: new Date(existingTs) }),
        point({ timestamp: new Date('2026-01-01T01:00:00.000Z') }),
      ],
      getExistingTimestamps: vi.fn().mockResolvedValue(new Set([existingTs])),
      insertSnapshots,
    });

    expect(summary).toEqual({ imported: 1, skipped: 1 });
    const [insertedDocs] = insertSnapshots.mock.calls[0] as [{ timestamp: Date }[]];
    expect(insertedDocs).toHaveLength(1);
    expect(insertedDocs[0]?.timestamp.getTime()).toBe(
      new Date('2026-01-01T01:00:00.000Z').getTime(),
    );
  });

  it("sets timestamp and sourceUpdatedAt to the point's own upstream timestamp, not now", async () => {
    const coinId = new Types.ObjectId();
    const upstreamTs = new Date('2025-06-15T12:00:00.000Z');
    const insertSnapshots = vi.fn(async (docs: readonly unknown[]) => docs.length);

    await runBackfillHistory({
      coingeckoId: 'bitcoin',
      coinId,
      points: [point({ timestamp: upstreamTs, priceUsd: 42, marketCapUsd: 1, volume24hUsd: 2 })],
      getExistingTimestamps: vi.fn().mockResolvedValue(new Set()),
      insertSnapshots,
    });

    const [insertedDocs] = insertSnapshots.mock.calls[0] as [
      {
        timestamp: Date;
        sourceUpdatedAt: Date | null;
        priceUsd: number;
        coinId: Types.ObjectId;
        coingeckoId: string;
      }[],
    ];
    expect(insertedDocs[0]).toMatchObject({
      timestamp: upstreamTs,
      sourceUpdatedAt: upstreamTs,
      priceUsd: 42,
      coinId,
      coingeckoId: 'bitcoin',
    });
  });

  it('returns immediately without querying existing timestamps when there are no points', async () => {
    const getExistingTimestamps = vi.fn();
    const insertSnapshots = vi.fn();

    const summary = await runBackfillHistory({
      coingeckoId: 'bitcoin',
      coinId: new Types.ObjectId(),
      points: [],
      getExistingTimestamps,
      insertSnapshots,
    });

    expect(summary).toEqual({ imported: 0, skipped: 0 });
    expect(getExistingTimestamps).not.toHaveBeenCalled();
    expect(insertSnapshots).not.toHaveBeenCalled();
  });
});

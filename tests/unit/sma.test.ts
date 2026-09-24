import { describe, expect, it } from 'vitest';
import { nullifySmaWarmup } from '../../src/modules/snapshots/sma.js';

/** Tests unitarios de `nullifySmaWarmup` de `src/modules/snapshots/sma.ts`. */

interface FakeBucket {
  readonly t: number;
  readonly sma: number | null;
}

function buckets(count: number): FakeBucket[] {
  return Array.from({ length: count }, (_, index) => ({ t: index, sma: 100 + index }));
}

describe('nullifySmaWarmup', () => {
  // E2-10: el warm-up con sma=3 anula los dos primeros buckets y conserva el resto.
  it('E2-10: nulls the first sma - 1 buckets and keeps the average for the rest', () => {
    const result = nullifySmaWarmup(buckets(5), 3);

    expect(result.map((point) => point.sma)).toEqual([null, null, 102, 103, 104]);
  });

  it('a window larger than the series nulls every bucket', () => {
    const result = nullifySmaWarmup(buckets(3), 10);

    expect(result.every((point) => point.sma === null)).toBe(true);
  });

  it('sma equal to 2 (the minimum) only nulls the first bucket', () => {
    const result = nullifySmaWarmup(buckets(4), 2);

    expect(result.map((point) => point.sma)).toEqual([null, 101, 102, 103]);
  });

  it('does not mutate the input array', () => {
    const input = buckets(3);
    const inputCopy = input.map((point) => ({ ...point }));

    nullifySmaWarmup(input, 3);

    expect(input).toEqual(inputCopy);
  });
});

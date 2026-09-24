import { describe, expect, it } from 'vitest';
import { computeChangePct } from '../../src/modules/snapshots/stats.js';

/** Tests unitarios de `computeChangePct` de `src/modules/snapshots/stats.ts`. */

describe('computeChangePct', () => {
  it('computes a positive change percentage', () => {
    expect(computeChangePct(100, 110)).toBe(10);
  });

  it('computes a negative change percentage', () => {
    expect(computeChangePct(100, 90)).toBe(-10);
  });

  it('returns 0 when open equals close', () => {
    expect(computeChangePct(50, 50)).toBe(0);
  });

  // spec price-stats-api: redondeado a 4 decimales.
  it('rounds to 4 decimal places', () => {
    expect(computeChangePct(3, 3.10001)).toBeCloseTo(3.3337, 4);
    expect(computeChangePct(7, 7.777777)).toBe(11.1111);
  });

  it('rounds a value that would otherwise have many more than 4 decimals', () => {
    const result = computeChangePct(33333, 33334);
    expect(result.toString().split('.')[1]?.length ?? 0).toBeLessThanOrEqual(4);
  });
});

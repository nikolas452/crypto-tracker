import { describe, expect, it } from 'vitest';
import { exitCodeFor } from '../../src/scripts/pollPricesOnce.js';

describe('exitCodeFor (job:poll-prices exit code mapping)', () => {
  it.each([
    ['success', 0],
    ['partial', 0],
    ['skipped', 0],
    ['failed', 1],
  ] as const)('maps status %s to exit code %i', (status, expected) => {
    expect(exitCodeFor(status)).toBe(expected);
  });
});

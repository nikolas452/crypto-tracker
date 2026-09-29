import { describe, expect, it } from 'vitest';
import { isRetryImminent, isTransientErrorCode } from '../../src/scheduler/retryPolicy.js';

/**
 * Tests unitarios de las funciones puras de `src/scheduler/retryPolicy.ts`
 * (spec job-retry-policy): el clasificador de códigos transitorios y la
 * regla de "corrida inminente".
 */

describe('isTransientErrorCode', () => {
  it.each(['COINGECKO_UNAVAILABLE', 'COINGECKO_RATE_LIMITED', 'ALERT_EVALUATION_FAILED'])(
    'treats %s as transient',
    (code) => {
      expect(isTransientErrorCode(code)).toBe(true);
    },
  );

  it.each(['COINGECKO_AUTH', 'INTERNAL', 'SOMETHING_ELSE', undefined])(
    'does not treat %s as transient',
    (code) => {
      expect(isTransientErrorCode(code)).toBe(false);
    },
  );
});

describe('isRetryImminent', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');

  it('is false when there is no recurring nextRunAt', () => {
    expect(isRetryImminent(null, now)).toBe(false);
  });

  it('is false when the next run is more than 3 minutes away', () => {
    const nextRunAt = new Date(now.getTime() + 4 * 60_000);
    expect(isRetryImminent(nextRunAt, now)).toBe(false);
  });

  it('is true when the next run is less than 3 minutes away', () => {
    const nextRunAt = new Date(now.getTime() + 2 * 60_000);
    expect(isRetryImminent(nextRunAt, now)).toBe(true);
  });

  it('is true when the next run is exactly at the boundary minus one ms', () => {
    const nextRunAt = new Date(now.getTime() + 3 * 60_000 - 1);
    expect(isRetryImminent(nextRunAt, now)).toBe(true);
  });

  it('is false when the next run is exactly 3 minutes away', () => {
    const nextRunAt = new Date(now.getTime() + 3 * 60_000);
    expect(isRetryImminent(nextRunAt, now)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { coinIdParamSchema, coinListQuerySchema } from '../../src/modules/coins/coins.schemas.js';

/** Tests unitarios de los schemas de validación de `src/modules/coins/coins.schemas.ts`. */

describe('coinListQuerySchema', () => {
  it('applies defaults when no query parameters are given', () => {
    const result = coinListQuerySchema.parse({});

    expect(result).toEqual({ page: 1, limit: 20, sort: 'marketCap', order: 'desc' });
  });

  it('coerces page and limit from query-string strings to numbers', () => {
    const result = coinListQuerySchema.parse({ page: '2', limit: '50' });

    expect(result.page).toBe(2);
    expect(result.limit).toBe(50);
  });

  it.each([
    ['marketCap', 'desc'],
    ['change24h', 'desc'],
    ['name', 'asc'],
    ['symbol', 'asc'],
  ] as const)('defaults order to %s -> %s when order is omitted', (sort, expectedOrder) => {
    const result = coinListQuerySchema.parse({ sort });

    expect(result.order).toBe(expectedOrder);
  });

  it('keeps an explicit order even when it overrides the per-sort default', () => {
    const result = coinListQuerySchema.parse({ sort: 'name', order: 'desc' });

    expect(result.order).toBe('desc');
  });

  it('accepts a valid q within the 1-50 character range', () => {
    const result = coinListQuerySchema.parse({ q: 'bit' });

    expect(result.q).toBe('bit');
  });

  it.each([
    { page: '0' },
    { page: '-1' },
    { limit: '0' },
    { limit: '101' },
    { limit: 'abc' },
    { sort: 'price' },
    { order: 'sideways' },
    { q: '' },
    { q: 'a'.repeat(51) },
  ])('rejects invalid input %j', (input) => {
    const result = coinListQuerySchema.safeParse(input);

    expect(result.success).toBe(false);
  });

  it('rejects an unknown query parameter (strict schema)', () => {
    const result = coinListQuerySchema.safeParse({ foo: '1' });

    expect(result.success).toBe(false);
  });
});

describe('coinIdParamSchema', () => {
  it('accepts a coingeckoId matching the model pattern', () => {
    const result = coinIdParamSchema.parse({ coingeckoId: 'bitcoin' });

    expect(result.coingeckoId).toBe('bitcoin');
  });

  it('accepts hyphenated and numeric ids', () => {
    const result = coinIdParamSchema.parse({ coingeckoId: 'usd-coin-2' });

    expect(result.coingeckoId).toBe('usd-coin-2');
  });

  it.each(['BITCOIN', 'bit coin', 'bit_coin', ''])(
    'rejects a malformed coingeckoId: %j',
    (coingeckoId) => {
      const result = coinIdParamSchema.safeParse({ coingeckoId });

      expect(result.success).toBe(false);
    },
  );
});

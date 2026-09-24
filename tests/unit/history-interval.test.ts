import { describe, expect, it } from 'vitest';
import { assertRangeAllowed, selectInterval } from '../../src/modules/snapshots/interval.js';
import { ValidationError } from '../../src/lib/errors.js';

/** Tests unitarios de `selectInterval` y `assertRangeAllowed` de `src/modules/snapshots/interval.ts`. */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function rangeFrom(days: number, ms = 0): { from: Date; to: Date } {
  const to = new Date('2026-06-15T00:00:00.000Z');
  return { from: new Date(to.getTime() - days * DAY - ms), to };
}

describe('selectInterval', () => {
  it.each([
    ['exactly 2 days', 2, 0, 'raw'],
    ['just under 2 days', 1, -HOUR, 'raw'],
    ['just over 2 days', 2, HOUR, '1h'],
    ['exactly 30 days', 30, 0, '1h'],
    ['just over 30 days', 30, HOUR, '1d'],
    ['a 20-day range (E2-9)', 20, 0, '1h'],
    ['a 400-day range', 400, 0, '1d'],
  ] as const)('%s selects %s', (_label, days, ms, expected) => {
    const { from, to } = rangeFrom(days, ms);
    expect(selectInterval(from, to)).toBe(expected);
  });
});

describe('assertRangeAllowed', () => {
  it.each([
    ['raw', 7, 0],
    ['1h', 90, 0],
    ['1d', 365, 0],
  ] as const)('accepts the maximum allowed range for %s', (interval, days, ms) => {
    const { from, to } = rangeFrom(days, ms);
    expect(() => assertRangeAllowed(interval, from, to)).not.toThrow();
  });

  it.each([
    ['raw', 7, HOUR],
    ['1h', 90, HOUR],
    ['1d', 365, HOUR],
  ] as const)('rejects a range one hour over the maximum for %s', (interval, days, ms) => {
    const { from, to } = rangeFrom(days, ms);
    expect(() => assertRangeAllowed(interval, from, to)).toThrow(ValidationError);
  });

  // E2-8: raw sobre un rango de 10 días es rechazado con un mensaje que sugiere 1h.
  it('E2-8: suggests 1h when raw exceeds its 7-day maximum', () => {
    const { from, to } = rangeFrom(10);
    expect(() => assertRangeAllowed('raw', from, to)).toThrow(/1h/);
  });

  it('suggests 1d when 1h exceeds its 90-day maximum', () => {
    const { from, to } = rangeFrom(91);
    expect(() => assertRangeAllowed('1h', from, to)).toThrow(/1d/);
  });

  it('names no coarser interval when 1d exceeds its own maximum', () => {
    const { from, to } = rangeFrom(366);
    let caught: unknown;
    try {
      assertRangeAllowed('1d', from, to);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).message).not.toMatch(/Use interval=/);
  });
});

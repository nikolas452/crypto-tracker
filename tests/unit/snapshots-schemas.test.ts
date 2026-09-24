import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  historyQuerySchema,
  statsQuerySchema,
} from '../../src/modules/snapshots/snapshots.schemas.js';

/** Tests unitarios de los schemas de validación de `src/modules/snapshots/snapshots.schemas.ts`. */

describe('historyQuerySchema', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies the default 7-day range ending at now when from/to are omitted', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T00:00:00.000Z'));

    const result = historyQuerySchema.parse({});

    expect(result.to.toISOString()).toBe('2026-06-15T00:00:00.000Z');
    expect(result.from.toISOString()).toBe('2026-06-08T00:00:00.000Z');
  });

  it('accepts an explicit from/to with a Z suffix', () => {
    const result = historyQuerySchema.parse({
      from: '2026-06-01T00:00:00Z',
      to: '2026-06-02T00:00:00Z',
    });

    expect(result.from.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(result.to.toISOString()).toBe('2026-06-02T00:00:00.000Z');
  });

  it('accepts an explicit offset instead of Z', () => {
    const result = historyQuerySchema.safeParse({
      from: '2026-06-01T00:00:00+02:00',
      to: '2026-06-02T00:00:00+02:00',
    });

    expect(result.success).toBe(true);
  });

  // spec price-history-api: un datetime sin zona horaria es rechazado.
  it('rejects a datetime with no Z and no offset', () => {
    const result = historyQuerySchema.safeParse({
      from: '2026-06-10T10:00',
      to: '2026-06-11T10:00',
    });

    expect(result.success).toBe(false);
  });

  // spec price-history-api: from igual a to es rechazado.
  it('rejects from equal to to', () => {
    const result = historyQuerySchema.safeParse({
      from: '2026-06-01T00:00:00Z',
      to: '2026-06-01T00:00:00Z',
    });

    expect(result.success).toBe(false);
  });

  it('rejects from after to', () => {
    const result = historyQuerySchema.safeParse({
      from: '2026-06-02T00:00:00Z',
      to: '2026-06-01T00:00:00Z',
    });

    expect(result.success).toBe(false);
  });

  // spec price-history-api: un to más de 5 minutos en el futuro es rechazado.
  it('rejects a to more than 5 minutes in the future', () => {
    const to = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const result = historyQuerySchema.safeParse({ from, to });

    expect(result.success).toBe(false);
  });

  it('accepts a to a few seconds in the future (within the 5-minute grace)', () => {
    const to = new Date(Date.now() + 60 * 1000).toISOString();
    const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const result = historyQuerySchema.safeParse({ from, to });

    expect(result.success).toBe(true);
  });

  // spec price-history-api: sma es rechazado junto con interval=raw.
  it('rejects sma together with interval=raw', () => {
    const result = historyQuerySchema.safeParse({ interval: 'raw', sma: 5 });

    expect(result.success).toBe(false);
  });

  it('accepts sma together with interval=1h', () => {
    const result = historyQuerySchema.safeParse({ interval: '1h', sma: 5 });

    expect(result.success).toBe(true);
  });

  it('rejects sma outside the 2-200 range', () => {
    expect(historyQuerySchema.safeParse({ interval: '1h', sma: 1 }).success).toBe(false);
    expect(historyQuerySchema.safeParse({ interval: '1h', sma: 201 }).success).toBe(false);
  });

  it('rejects an unknown query parameter (strict schema)', () => {
    const result = historyQuerySchema.safeParse({ foo: '1' });

    expect(result.success).toBe(false);
  });

  it('rejects an unknown interval value', () => {
    const result = historyQuerySchema.safeParse({ interval: '5m' });

    expect(result.success).toBe(false);
  });
});

describe('statsQuerySchema', () => {
  it('defaults range to 24h and derives from/to', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T00:00:00.000Z'));

    const result = statsQuerySchema.parse({});

    expect(result.range).toBe('24h');
    expect(result.to.toISOString()).toBe('2026-06-15T00:00:00.000Z');
    expect(result.from.toISOString()).toBe('2026-06-14T00:00:00.000Z');

    vi.useRealTimers();
  });

  it.each(['24h', '7d', '30d', '90d'] as const)('accepts range=%s', (range) => {
    const result = statsQuerySchema.safeParse({ range });
    expect(result.success).toBe(true);
  });

  // spec price-stats-api: un valor de range desconocido es rechazado.
  it('rejects a range outside the enum', () => {
    const result = statsQuerySchema.safeParse({ range: '1y' });

    expect(result.success).toBe(false);
  });

  it('rejects an unknown query parameter (strict schema)', () => {
    const result = statsQuerySchema.safeParse({ foo: '1' });

    expect(result.success).toBe(false);
  });
});

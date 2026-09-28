import { describe, expect, it } from 'vitest';
import { backoffMinutes } from '../../src/jobs/notifyBackoff.js';

/** Tests unitarios del cálculo de backoff con jitter de `src/jobs/notifyBackoff.ts` (spec send-notifications-job, tarea 9.10). */

const BASE_MINUTES_BY_ATTEMPT: Record<number, number> = {
  1: 1,
  2: 5,
  3: 15,
  4: 60,
};

describe('backoffMinutes', () => {
  it('uses the 4 base values [1, 5, 15, 60] for attempts 1-4 when there is no jitter', () => {
    const noJitterRandom = () => 0.5; // jitterFraction = 0.5*0.2 - 0.1 = 0
    for (const [attempt, base] of Object.entries(BASE_MINUTES_BY_ATTEMPT)) {
      expect(backoffMinutes(Number(attempt), noJitterRandom)).toBe(base);
    }
  });

  it('attempt 5 and beyond reuse the last base value (60)', () => {
    const noJitterRandom = () => 0.5;
    expect(backoffMinutes(5, noJitterRandom)).toBe(60);
    expect(backoffMinutes(10, noJitterRandom)).toBe(60);
  });

  // Bordes exactos del jitter con un RNG inyectado y fijo, en lugar de
  // depender de muchas muestras aleatorias (deterministico, no flaky).
  it('random() = 0 yields the lower bound: base * 0.9', () => {
    const lowerBoundRandom = () => 0; // jitterFraction = -0.1
    expect(backoffMinutes(1, lowerBoundRandom)).toBeCloseTo(1 * 0.9, 10);
    expect(backoffMinutes(2, lowerBoundRandom)).toBeCloseTo(5 * 0.9, 10);
    expect(backoffMinutes(3, lowerBoundRandom)).toBeCloseTo(15 * 0.9, 10);
    expect(backoffMinutes(4, lowerBoundRandom)).toBeCloseTo(60 * 0.9, 10);
  });

  it('random() just under 1 yields (nearly) the upper bound: base * 1.1', () => {
    const upperBoundRandom = () => 0.999999999;
    expect(backoffMinutes(1, upperBoundRandom)).toBeCloseTo(1 * 1.1, 5);
    expect(backoffMinutes(4, upperBoundRandom)).toBeCloseTo(60 * 1.1, 5);
  });

  // Con el RNG por defecto (Math.random), muchas muestras nunca deben
  // escapar de +-10% de la base — cobertura del jitter en su forma real,
  // sin fijar el RNG, pero con un chequeo de rango en lugar de un valor
  // exacto (para no ser flaky).
  it('with the default RNG, many samples always stay within +-10% of the base', () => {
    for (const [attempt, base] of Object.entries(BASE_MINUTES_BY_ATTEMPT)) {
      for (let i = 0; i < 500; i += 1) {
        const result = backoffMinutes(Number(attempt));
        expect(result).toBeGreaterThanOrEqual(base * 0.9);
        expect(result).toBeLessThanOrEqual(base * 1.1);
      }
    }
  });
});

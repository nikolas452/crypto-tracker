import { describe, expect, it } from 'vitest';
import {
  decide,
  isRearmConditionMet,
  isTriggerConditionMet,
  isWithinCooldown,
  type AlertDecisionInput,
  type AlertValue,
} from '../../src/modules/alerts/alerts.decide.js';

/**
 * Tests unitarios de `decide()` y sus helpers (`src/modules/alerts/alerts.decide.ts`):
 * el árbol de decisión completo de la máquina de estados de alertas (spec
 * alert-store) — condiciones de disparo por tipo, cooldown, rearme con
 * histéresis y los estados que nunca se evalúan. Pura, sin Mongo.
 */

const NOW = new Date('2026-01-01T12:00:00.000Z');
const MINUTE_MS = 60 * 1000;

function minutesBefore(now: Date, minutes: number): Date {
  return new Date(now.getTime() - minutes * MINUTE_MS);
}

function makeAlert(overrides: Partial<AlertDecisionInput> = {}): AlertDecisionInput {
  return {
    type: 'PRICE_ABOVE',
    status: 'armed',
    threshold: 100,
    rearmPct: 1,
    cooldownMinutes: 60,
    lastTriggeredAt: null,
    ...overrides,
  };
}

function makeValue(overrides: Partial<AlertValue> = {}): AlertValue {
  return { priceUsd: 0, change24hPct: null, ...overrides };
}

describe('decide', () => {
  describe('trigger conditions (armed, no prior trigger)', () => {
    it('PRICE_ABOVE fires exactly at the threshold (inclusive boundary)', () => {
      const alert = makeAlert({ type: 'PRICE_ABOVE', threshold: 100 });
      expect(decide(alert, makeValue({ priceUsd: 100 }), NOW)).toBe('TRIGGER');
    });

    it('PRICE_ABOVE stays NOOP just below the threshold', () => {
      const alert = makeAlert({ type: 'PRICE_ABOVE', threshold: 100 });
      expect(decide(alert, makeValue({ priceUsd: 99.99 }), NOW)).toBe('NOOP');
    });

    it('PRICE_BELOW fires exactly at the threshold (inclusive boundary)', () => {
      const alert = makeAlert({ type: 'PRICE_BELOW', threshold: 100 });
      expect(decide(alert, makeValue({ priceUsd: 100 }), NOW)).toBe('TRIGGER');
    });

    it('PRICE_BELOW stays NOOP just above the threshold', () => {
      const alert = makeAlert({ type: 'PRICE_BELOW', threshold: 100 });
      expect(decide(alert, makeValue({ priceUsd: 100.01 }), NOW)).toBe('NOOP');
    });

    it('CHANGE_24H_ABS_GTE fires exactly at the threshold with a positive change (inclusive boundary)', () => {
      const alert = makeAlert({ type: 'CHANGE_24H_ABS_GTE', threshold: 5 });
      expect(decide(alert, makeValue({ change24hPct: 5 }), NOW)).toBe('TRIGGER');
    });

    it('CHANGE_24H_ABS_GTE fires exactly at the threshold with a negative change (absolute value)', () => {
      const alert = makeAlert({ type: 'CHANGE_24H_ABS_GTE', threshold: 5 });
      expect(decide(alert, makeValue({ change24hPct: -5 }), NOW)).toBe('TRIGGER');
    });

    it('CHANGE_24H_ABS_GTE stays NOOP just below the threshold', () => {
      const alert = makeAlert({ type: 'CHANGE_24H_ABS_GTE', threshold: 5 });
      expect(decide(alert, makeValue({ change24hPct: 4.99 }), NOW)).toBe('NOOP');
    });

    it('CHANGE_24H_ABS_GTE with a null change24hPct is not evaluated (NOOP)', () => {
      const alert = makeAlert({ type: 'CHANGE_24H_ABS_GTE', threshold: 5 });
      expect(decide(alert, makeValue({ change24hPct: null }), NOW)).toBe('NOOP');
    });
  });

  describe('cooldown (armed, trigger condition met)', () => {
    it('stays in COOLDOWN when lastTriggeredAt is 20 minutes ago and cooldownMinutes is 60', () => {
      const alert = makeAlert({
        threshold: 100,
        cooldownMinutes: 60,
        lastTriggeredAt: minutesBefore(NOW, 20),
      });
      expect(decide(alert, makeValue({ priceUsd: 150 }), NOW)).toBe('COOLDOWN');
    });

    it('TRIGGERs again once 61 minutes have elapsed with cooldownMinutes 60', () => {
      const alert = makeAlert({
        threshold: 100,
        cooldownMinutes: 60,
        lastTriggeredAt: minutesBefore(NOW, 61),
      });
      expect(decide(alert, makeValue({ priceUsd: 150 }), NOW)).toBe('TRIGGER');
    });

    it('TRIGGERs exactly at the cooldown boundary (elapsed == cooldownMinutes, inclusive)', () => {
      const alert = makeAlert({
        threshold: 100,
        cooldownMinutes: 60,
        lastTriggeredAt: minutesBefore(NOW, 60),
      });
      expect(decide(alert, makeValue({ priceUsd: 150 }), NOW)).toBe('TRIGGER');
    });

    it('TRIGGERs when lastTriggeredAt is null (never triggered before)', () => {
      const alert = makeAlert({ threshold: 100, cooldownMinutes: 60, lastTriggeredAt: null });
      expect(decide(alert, makeValue({ priceUsd: 150 }), NOW)).toBe('TRIGGER');
    });
  });

  describe('rearm with hysteresis (triggered)', () => {
    it('PRICE_BELOW stays triggered (NOOP) inside the hysteresis band (50400 vs threshold 50000, rearmPct 1)', () => {
      const alert = makeAlert({
        type: 'PRICE_BELOW',
        status: 'triggered',
        threshold: 50000,
        rearmPct: 1,
      });
      expect(decide(alert, makeValue({ priceUsd: 50400 }), NOW)).toBe('NOOP');
    });

    it('PRICE_BELOW REARMs once price clears the hysteresis band (50600 vs threshold 50000, rearmPct 1)', () => {
      const alert = makeAlert({
        type: 'PRICE_BELOW',
        status: 'triggered',
        threshold: 50000,
        rearmPct: 1,
      });
      expect(decide(alert, makeValue({ priceUsd: 50600 }), NOW)).toBe('REARM');
    });

    it('PRICE_ABOVE stays triggered (NOOP) exactly at the hysteresis boundary (49500 vs threshold 50000, rearmPct 1)', () => {
      const alert = makeAlert({
        type: 'PRICE_ABOVE',
        status: 'triggered',
        threshold: 50000,
        rearmPct: 1,
      });
      expect(decide(alert, makeValue({ priceUsd: 49500 }), NOW)).toBe('NOOP');
    });

    it('PRICE_ABOVE REARMs once price drops below the hysteresis boundary (49499 vs threshold 50000, rearmPct 1)', () => {
      const alert = makeAlert({
        type: 'PRICE_ABOVE',
        status: 'triggered',
        threshold: 50000,
        rearmPct: 1,
      });
      expect(decide(alert, makeValue({ priceUsd: 49499 }), NOW)).toBe('REARM');
    });

    it('CHANGE_24H_ABS_GTE stays triggered (NOOP) exactly at the hysteresis boundary (threshold 5, rearmPct 1 -> 4)', () => {
      const alert = makeAlert({
        type: 'CHANGE_24H_ABS_GTE',
        status: 'triggered',
        threshold: 5,
        rearmPct: 1,
      });
      expect(decide(alert, makeValue({ change24hPct: 4 }), NOW)).toBe('NOOP');
    });

    it('CHANGE_24H_ABS_GTE REARMs once the change clears the hysteresis boundary (3.99 vs 4)', () => {
      const alert = makeAlert({
        type: 'CHANGE_24H_ABS_GTE',
        status: 'triggered',
        threshold: 5,
        rearmPct: 1,
      });
      expect(decide(alert, makeValue({ change24hPct: 3.99 }), NOW)).toBe('REARM');
    });

    it('CHANGE_24H_ABS_GTE with a null change24hPct stays triggered (NOOP), not evaluated', () => {
      const alert = makeAlert({
        type: 'CHANGE_24H_ABS_GTE',
        status: 'triggered',
        threshold: 5,
        rearmPct: 1,
      });
      expect(decide(alert, makeValue({ change24hPct: null }), NOW)).toBe('NOOP');
    });
  });

  describe('disabled/completed alerts are never evaluated', () => {
    it('a disabled alert stays NOOP even when the trigger condition is clearly met', () => {
      const alert = makeAlert({ type: 'PRICE_ABOVE', status: 'disabled', threshold: 100 });
      expect(decide(alert, makeValue({ priceUsd: 999 }), NOW)).toBe('NOOP');
    });

    it('a completed alert stays NOOP even when the trigger condition is clearly met', () => {
      const alert = makeAlert({ type: 'PRICE_ABOVE', status: 'completed', threshold: 100 });
      expect(decide(alert, makeValue({ priceUsd: 999 }), NOW)).toBe('NOOP');
    });
  });
});

describe('isTriggerConditionMet / isRearmConditionMet / isWithinCooldown (exported helpers)', () => {
  it('isTriggerConditionMet matches decide() for PRICE_ABOVE', () => {
    expect(isTriggerConditionMet('PRICE_ABOVE', 100, makeValue({ priceUsd: 100 }))).toBe(true);
    expect(isTriggerConditionMet('PRICE_ABOVE', 100, makeValue({ priceUsd: 99.99 }))).toBe(false);
  });

  it('isRearmConditionMet matches decide() for PRICE_BELOW', () => {
    expect(isRearmConditionMet('PRICE_BELOW', 50000, 1, makeValue({ priceUsd: 50600 }))).toBe(
      true,
    );
    expect(isRearmConditionMet('PRICE_BELOW', 50000, 1, makeValue({ priceUsd: 50400 }))).toBe(
      false,
    );
  });

  it('isWithinCooldown is false when lastTriggeredAt is null', () => {
    expect(isWithinCooldown(null, 60, NOW)).toBe(false);
  });

  it('isWithinCooldown matches decide() at the exact boundary (inclusive elapsed)', () => {
    expect(isWithinCooldown(minutesBefore(NOW, 60), 60, NOW)).toBe(false);
    expect(isWithinCooldown(minutesBefore(NOW, 59), 60, NOW)).toBe(true);
  });
});

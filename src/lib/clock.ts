/**
 * Small abstraction over "now" so time-dependent code (and its tests) don't
 * depend on the real system clock or `Date.now()` directly.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Creates a fixed clock for tests: `now()` always returns the same instant. */
export function createFixedClock(fixedDate: Date): Clock {
  return {
    now: () => fixedDate,
  };
}

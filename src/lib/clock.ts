/**
 * Pequeña abstracción sobre "ahora" para que el código dependiente del tiempo
 * (y sus tests) no dependa directamente del reloj del sistema ni de
 * `Date.now()`.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Crea un reloj fijo para tests: `now()` siempre devuelve el mismo instante. */
export function createFixedClock(fixedDate: Date): Clock {
  return {
    now: () => fixedDate,
  };
}

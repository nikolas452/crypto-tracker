/**
 * Cálculo de backoff con jitter para los reintentos del job
 * `send-notifications` (spec send-notifications-job). Función pura, sin
 * I/O: recibe el nuevo número de intento y una función de aleatoriedad
 * inyectable (por defecto `Math.random`) para que los tests puedan fijar el
 * jitter en sus bordes de forma determinística en lugar de depender de
 * muchas muestras aleatorias.
 */

/** Minutos base por intento (spec: `[1, 5, 15, 60]`). El intento 4 en adelante reutiliza el último valor. */
const BACKOFF_BASE_MINUTES = [1, 5, 15, 60] as const;

/** Debe devolver un valor en `[0, 1)`, misma forma que `Math.random`. */
export type RandomFn = () => number;

/**
 * Minutos de espera antes del próximo intento, con jitter de ±10% (spec:
 * "jitterFraction es un valor aleatorio en [-0.1, 0.1]"). `attempts` es el
 * nuevo valor de `attempts` de la notificación, YA incrementado
 * (1-indexado: `attempts === 1` es el primer reintento).
 */
export function backoffMinutes(attempts: number, random: RandomFn = Math.random): number {
  // El clamp deja `index` siempre en [0, length - 1]; la aserción es segura.
  const index = Math.min(Math.max(attempts - 1, 0), BACKOFF_BASE_MINUTES.length - 1);
  const baseMinutes = BACKOFF_BASE_MINUTES[index]!;
  const jitterFraction = random() * 0.2 - 0.1;
  return baseMinutes * (1 + jitterFraction);
}

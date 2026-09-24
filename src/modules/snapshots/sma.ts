/**
 * Anula `sma` (lo deja en null) para cada bucket cuya ventana de
 * `$setWindowFields` (ver el pipeline de historial en buckets de
 * `snapshots.service.ts`) todavía no está completa — los primeros `sma - 1`
 * buckets, por posición en el array — en lugar de dejar el propio promedio
 * de Mongo sobre una ventana más corta (spec price-history-api: "Para los
 * primeros sma - 1 buckets el valor DEBE ser null en lugar de un promedio
 * sobre una ventana más corta"). Pura — sin DB, sin HTTP — así el límite de
 * calentamiento es un test unitario en lugar de un round trip HTTP
 * (design.md), mientras que el promedio en sí sigue viniendo del
 * `$setWindowFields` de Mongo (spec price-history-api 6.6).
 */
export function nullifySmaWarmup<T extends { sma?: number | null }>(
  points: readonly T[],
  sma: number,
): T[] {
  return points.map((point, index) => (index < sma - 1 ? { ...point, sma: null } : point));
}

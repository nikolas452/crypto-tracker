/**
 * Escapa todo metacaracter de regex en `value` para que pueda incrustarse en
 * un `RegExp` y coincidir en forma literal. Lo usa la búsqueda por prefijo
 * `q` del listado de monedas (spec coin-read-api) para cerrar el agujero de
 * inyección de regex / backtracking sin límite que abriría un string
 * ingresado por el usuario sin escapar.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

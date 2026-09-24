/**
 * La forma compartida del sobre de paginación por offset del proyecto (spec
 * coin-read-api: "la forma paginada del proyecto `{ data, meta }`"). No
 * existía ningún endpoint paginado antes de este, así que esta etapa
 * establece la forma; los endpoints paginados posteriores (por ejemplo,
 * `GET /api/v1/admin/job-runs`, etapa 9) deberían reutilizar
 * {@link PaginationMeta} / {@link buildPaginationMeta} en lugar de inventar
 * la suya propia.
 */
export interface PaginationMeta {
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly totalPages: number;
}

export interface PaginatedResult<T> {
  readonly data: T[];
  readonly meta: PaginationMeta;
}

/** `totalPages` es `0` (no `1`) cuando `total` es `0`, acorde a un conjunto de resultados vacío. */
export function buildPaginationMeta(page: number, limit: number, total: number): PaginationMeta {
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}

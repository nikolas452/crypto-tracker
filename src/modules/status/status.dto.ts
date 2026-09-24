import type { JobStatus } from '../job-runs/job-runs.model.js';

/**
 * Forma de la respuesta de `GET /api/v1/status` (spec system-status-api).
 * Excluye deliberadamente cualquier cosa de `JobRun.error` o `workerId` — el
 * requisito de que "Status nunca expone detalles internos".
 */
export interface PollPricesStatusDto {
  readonly lastSuccessAt: Date | null;
  readonly lastRunAt: Date | null;
  readonly lastRunStatus: JobStatus | null;
  readonly stale: boolean;
}

export interface StatusResponseDto {
  readonly activeCoins: number;
  readonly pollPrices: PollPricesStatusDto;
}

export interface StatusDtoSource {
  readonly activeCoins: number;
  readonly lastRunAt: Date | null;
  readonly lastRunStatus: JobStatus | null;
  readonly lastSuccessAt: Date | null;
  readonly stale: boolean;
}

/**
 * Builder de DTO explícito campo por campo (design.md: "los DTOs de salida
 * son explícitos, no transforms de toJSON"), y el único lugar que enumera
 * exactamente qué campos puede llevar la respuesta de status.
 */
export function toStatusResponseDto(source: StatusDtoSource): StatusResponseDto {
  return {
    activeCoins: source.activeCoins,
    pollPrices: {
      lastSuccessAt: source.lastSuccessAt,
      lastRunAt: source.lastRunAt,
      lastRunStatus: source.lastRunStatus,
      stale: source.stale,
    },
  };
}

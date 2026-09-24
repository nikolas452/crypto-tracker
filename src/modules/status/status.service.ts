import { config } from '../../config/env.js';
import { systemClock, type Clock } from '../../lib/clock.js';
import { JOB_NAME } from '../../jobs/pollPrices.js';
import { countActiveCoins } from '../coins/coins.service.js';
import { getLastRun, getLastSuccessfulRun } from '../job-runs/job-runs.service.js';
import { toStatusResponseDto, type StatusResponseDto } from './status.dto.js';

/**
 * Fuente de datos de `GET /api/v1/status` (spec system-status-api). Combina
 * un conteo de monedas activas con la señal de liveness del job poll-prices,
 * sin ningún objeto de Express (5.9). `clock` toma por defecto el reloj real
 * del sistema; los tests pueden inyectar uno fijo, aunque el test de
 * integración E2-12 no lo necesita porque verifica la antigüedad a partir de
 * un tiempo transcurrido real.
 *
 * `stale` se calcula a partir de `job_runs`, no de la recencia de los
 * snapshots (design.md): responde "¿está vivo el worker?", y es `true`
 * cuando no hubo ninguna corrida `success`/`partial` dentro de
 * `STALE_POLL_THRESHOLD_MIN` minutos, incluyendo el caso en que nunca hubo
 * ninguna.
 */
export async function getStatus(clock: Clock = systemClock): Promise<StatusResponseDto> {
  const [activeCoins, lastRun, lastSuccess] = await Promise.all([
    countActiveCoins(),
    getLastRun(JOB_NAME),
    getLastSuccessfulRun(JOB_NAME),
  ]);

  const lastSuccessAt = lastSuccess?.finishedAt ?? null;
  const thresholdMs = config.STALE_POLL_THRESHOLD_MIN * 60_000;
  const stale =
    lastSuccessAt === null || clock.now().getTime() - lastSuccessAt.getTime() > thresholdMs;

  return toStatusResponseDto({
    activeCoins,
    lastRunAt: lastRun?.startedAt ?? null,
    lastRunStatus: lastRun?.status ?? null,
    lastSuccessAt,
    stale,
  });
}

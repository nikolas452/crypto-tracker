import { Router } from 'express';
import type { ReadinessCheck } from '../lib/health.js';

/**
 * `GET /health` (liveness, sin dependencias) y `GET /health/ready`
 * (readiness, ejecuta cada chequeo de `readinessChecks`). `/health/ready` es
 * el único endpoint de la API que NO usa el formato de error global: las
 * plataformas de despliegue leen el código de estado y el body describe cada
 * chequeo.
 */
export function createHealthRouter(readinessChecks: readonly ReadinessCheck[]): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  router.get('/health/ready', async (_req, res) => {
    const outcomes = await Promise.allSettled(readinessChecks.map((entry) => entry.check()));

    const checks: Record<string, 'up' | 'down'> = {};
    let allUp = true;

    outcomes.forEach((outcome, index) => {
      const name = readinessChecks[index]?.name ?? `check_${index}`;
      if (outcome.status === 'fulfilled') {
        checks[name] = 'up';
      } else {
        checks[name] = 'down';
        allUp = false;
      }
    });

    res.status(allUp ? 200 : 503).json({
      status: allUp ? 'ready' : 'not_ready',
      checks,
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}

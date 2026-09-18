import { Router } from 'express';
import type { ReadinessCheck } from '../lib/health.js';

/**
 * `GET /health` (liveness, no dependency) and `GET /health/ready`
 * (readiness, runs every check in `readinessChecks`). `/health/ready` is the
 * one endpoint in the API that does NOT use the global error format: deploy
 * platforms read the status code and the body describes each check.
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

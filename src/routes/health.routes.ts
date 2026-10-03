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

  /**
   * @openapi
   * /health:
   *   get:
   *     tags: [health]
   *     summary: Chequeo de vida
   *     description: >-
   *       Indica que el proceso está vivo; no consulta ninguna dependencia. Está
   *       fuera del prefijo `/api/v1` y exenta del límite de peticiones.
   *     security: []
   *     responses:
   *       '200':
   *         description: El proceso está vivo.
   *         headers:
   *           X-Request-Id: { $ref: '#/components/headers/XRequestId' }
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/HealthLive'
   */
  router.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * @openapi
   * /health/ready:
   *   get:
   *     tags: [health]
   *     summary: Chequeo de disponibilidad
   *     description: >-
   *       Ejecuta los chequeos de dependencias (base de datos y, si está habilitado,
   *       CoinGecko). Responde `200` si todos están en `up` y `503` si alguno está
   *       en `down`. Es la única respuesta de la API que no usa el envoltorio
   *       `Error`: en ambos casos el cuerpo es `{ status, checks, timestamp }`.
   *       Está fuera del prefijo `/api/v1` y exenta del límite de peticiones.
   *     security: []
   *     responses:
   *       '200':
   *         description: Todos los chequeos están en `up`.
   *         headers:
   *           X-Request-Id: { $ref: '#/components/headers/XRequestId' }
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/HealthReady'
   *             example:
   *               status: ready
   *               checks: { mongo: up }
   *               timestamp: '2026-01-15T12:00:00.000Z'
   *       '503':
   *         description: >-
   *           Al menos un chequeo está en `down`. El cuerpo no usa el envoltorio
   *           `Error`.
   *         headers:
   *           X-Request-Id: { $ref: '#/components/headers/XRequestId' }
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/HealthReady'
   *             example:
   *               status: not_ready
   *               checks: { mongo: down }
   *               timestamp: '2026-01-15T12:00:00.000Z'
   */
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

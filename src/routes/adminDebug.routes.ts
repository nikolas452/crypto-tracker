import { Router } from 'express';

/**
 * `GET /api/v1/admin/debug/ip` (spec production-http-security, deploy-render
 * tarea 6.4): devuelve `req.ip`/`req.ips` tal como Express los resuelve, para
 * poder verificar contra un request real que `TRUST_PROXY` está bien
 * configurado detrás del proxy inverso de la plataforma. Montado bajo
 * `/api/v1/admin` en `src/app.ts`, dentro del prefijo que ya exige
 * `requireAuth({ checkRevoked: true })` + `requireRole('admin')` — no se
 * repite acá, mismo patrón que `coins.admin.routes.ts`/`job-runs.routes.ts`.
 */
export function createAdminDebugRouter(): Router {
  const router = Router();

  router.get('/ip', (req, res) => {
    res.status(200).json({ data: { ip: req.ip, ips: req.ips } });
  });

  return router;
}

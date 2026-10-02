/**
 * Tests del helper `listRoutes`: comprueban que enumera de forma exacta todas
 * las rutas de la app real (`createApp`), con prefijos de routers anidados y
 * parámetros en formato OpenAPI, y que no deja parcheado `Router.prototype.use`.
 */
import { describe, expect, it } from 'vitest';
import express, { Router } from 'express';
import pino from 'pino';
import { createApp } from '../../src/app.js';
import { listRoutes, toOpenApiPath } from '../helpers/listRoutes.js';

const silentLogger = pino({ level: 'silent' });

/** Rutas esperadas, derivadas de `src/app.ts`, `src/modules/*\/*.routes.ts` y `src/routes/health.routes.ts`. */
const EXPECTED_ROUTES: readonly string[] = [
  // Health (fuera del prefijo /api/v1)
  'GET /health',
  'GET /health/ready',
  // Públicas
  'GET /api/v1/coins',
  'GET /api/v1/coins/{coingeckoId}',
  'GET /api/v1/coins/{coingeckoId}/history',
  'GET /api/v1/coins/{coingeckoId}/stats',
  'GET /api/v1/status',
  // Documentación de la propia API (pública)
  'GET /api/v1/openapi.json',
  // Usuario autenticado
  'GET /api/v1/me',
  'PATCH /api/v1/me',
  'DELETE /api/v1/me',
  'GET /api/v1/me/watchlist',
  'POST /api/v1/me/watchlist',
  'PATCH /api/v1/me/watchlist/{coingeckoId}',
  'DELETE /api/v1/me/watchlist/{coingeckoId}',
  'GET /api/v1/me/alerts',
  'POST /api/v1/me/alerts',
  'GET /api/v1/me/alerts/{id}',
  'PATCH /api/v1/me/alerts/{id}',
  'DELETE /api/v1/me/alerts/{id}',
  'GET /api/v1/me/notifications',
  // Administración
  'GET /api/v1/admin/coins',
  'POST /api/v1/admin/coins',
  'PATCH /api/v1/admin/coins/{coingeckoId}',
  'GET /api/v1/admin/job-runs',
  'GET /api/v1/admin/job-runs/{id}',
  'GET /api/v1/admin/jobs',
  'POST /api/v1/admin/jobs/{name}/run',
  'POST /api/v1/admin/jobs/{name}/disable',
  'POST /api/v1/admin/jobs/{name}/enable',
  'GET /api/v1/admin/notifications',
  'POST /api/v1/admin/notifications/{id}/retry',
  'POST /api/v1/admin/notifications/test-email',
];

function keys(routes: readonly { method: string; path: string }[]): string[] {
  return routes.map((route) => `${route.method} ${route.path}`).sort();
}

describe('listRoutes', () => {
  it('lista exactamente las rutas registradas en createApp', () => {
    const routes = listRoutes(() => createApp({ logger: silentLogger }));

    expect(keys(routes)).toEqual([...EXPECTED_ROUTES].sort());
  });

  it('reconstruye prefijos de routers anidados y convierte :param a {param}', () => {
    const routes = listRoutes(() => {
      const app = express();
      const inner = Router();
      inner.get('/:id/items/:itemId', (_req, res) => {
        res.end();
      });
      const outer = Router();
      outer.use('/inner', inner);
      app.use('/api', outer);
      app.post('/root', (_req, res) => {
        res.end();
      });
      return app;
    });

    expect(keys(routes)).toEqual(['GET /api/inner/{id}/items/{itemId}', 'POST /root']);
  });

  it('restaura Router.prototype.use tras construir la app', () => {
    const before = Router.prototype.use;
    listRoutes(() => createApp({ logger: silentLogger }));

    expect(Router.prototype.use).toBe(before);
  });

  it('restaura Router.prototype.use aunque buildApp lance', () => {
    const before = Router.prototype.use;

    expect(() =>
      listRoutes(() => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(Router.prototype.use).toBe(before);
  });
});

describe('toOpenApiPath', () => {
  it('convierte parámetros de Express a notación OpenAPI', () => {
    expect(toOpenApiPath('/a/:id/b/:name')).toBe('/a/{id}/b/{name}');
    expect(toOpenApiPath('/sin/parametros')).toBe('/sin/parametros');
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { clearDatabase, startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';

/** Tests de integración del rate limiting de la API. */

describe('api rate limiting (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 120000);

  afterEach(async () => {
    await clearDatabase();
  });

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  // E2-15. `GET /api/v1/coins` (coin-read-api) ya está implementado, así que
  // las primeras 3 requests de abajo se sirven de verdad (200, catálogo vacío)
  // en vez de caer al handler 404. El rate limiter sigue montado como
  // middleware de prefijo en `/api` (ver src/app.ts), corriendo antes del
  // routing, así que la forma de la aserción no cambia: la 4ª request
  // consecutiva es rechazada por el limiter.
  it('E2-15: the 4th consecutive request over a limit of 3 is 429 RATE_LIMITED, while /health stays exempt', async () => {
    const app = createApp({ rateLimitConfig: { RATE_LIMIT_MAX: 3, RATE_LIMIT_WINDOW_MIN: 15 } });

    const first = await request(app).get('/api/v1/coins');
    const second = await request(app).get('/api/v1/coins');
    const third = await request(app).get('/api/v1/coins');
    const fourth = await request(app).get('/api/v1/coins');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);

    expect(fourth.status).toBe(429);
    expect(fourth.body.error.code).toBe('RATE_LIMITED');
    expect(fourth.body.error.requestId).toBeDefined();

    const health = await request(app).get('/health');
    expect(health.status).toBe(200);
  });

  it('serves requests within the budget with the standard RateLimit-* headers, without the legacy X-RateLimit-* ones', async () => {
    const app = createApp({ rateLimitConfig: { RATE_LIMIT_MAX: 3, RATE_LIMIT_WINDOW_MIN: 15 } });

    const response = await request(app).get('/api/v1/coins');

    expect(response.headers['ratelimit-limit']).toBeDefined();
    expect(response.headers['x-ratelimit-limit']).toBeUndefined();
  });
});

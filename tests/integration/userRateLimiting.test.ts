import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import { createApp } from '../../src/app.js';
import { UserModel } from '../../src/modules/users/users.model.js';
import { createFakeTokenVerifier } from '../../src/integrations/firebase/fakeTokenVerifier.js';
import { ensureCollections } from '../../src/db/ensureCollections.js';
import { clearDatabase, startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';

const silentLogger = pino({ level: 'silent' });

const TOKEN = 'rate-limited-user-token';
const IDENTITY = {
  uid: 'rate-limited-uid',
  email: 'rate-limited@example.com',
  emailVerified: true,
  name: null,
};

/**
 * Tests de integración del limitador de tasa por uid (spec
 * user-rate-limiting), montado después de `requireAuth` en `/me` y `/admin`
 * (src/app.ts). Usa `userRateLimitConfig` para inyectar un presupuesto
 * ajustado sin mutar `process.env` de un `config` ya parseado, siguiendo el
 * mismo patrón que `rateLimitConfig` (ver `rateLimiting.test.ts`).
 */
describe('user rate limiting (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
    await ensureCollections(silentLogger);
  }, 120000);

  afterEach(async () => {
    await clearDatabase();
  });

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  // E3-12. La clave del limitador es `req.auth.uid`, no la IP de origen
  // (`keyGenerator` en `userRateLimiter.ts`), así que da igual desde qué
  // dirección llegue cada request: lo único que importa para esta aserción
  // es que las tres pertenecen al mismo usuario autenticado.
  it('E3-12: the same user\'s 3rd request within the window is 429 RATE_LIMITED', async () => {
    const app = createApp({
      logger: silentLogger,
      tokenVerifier: createFakeTokenVerifier({ identities: { [TOKEN]: IDENTITY } }),
      userRateLimitConfig: { USER_RATE_LIMIT_PER_MIN: 2 },
    });

    const first = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${TOKEN}`);
    const second = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${TOKEN}`);
    const third = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${TOKEN}`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('RATE_LIMITED');
  });

  it('never counts an unauthenticated (401) request against any per-user budget', async () => {
    const app = createApp({
      logger: silentLogger,
      tokenVerifier: createFakeTokenVerifier({ identities: { [TOKEN]: IDENTITY } }),
      userRateLimitConfig: { USER_RATE_LIMIT_PER_MIN: 1 },
    });

    const first = await request(app).get('/api/v1/me');
    const second = await request(app).get('/api/v1/me');
    const third = await request(app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(first.status).toBe(401);
    expect(second.status).toBe(401);
    // El único request autenticado sigue teniendo presupuesto disponible.
    expect(third.status).toBe(200);
  });

  it('shares one budget across /me and /admin for the same uid', async () => {
    await UserModel.create({
      firebaseUid: IDENTITY.uid,
      email: IDENTITY.email,
      emailVerified: IDENTITY.emailVerified,
      displayName: null,
      role: 'admin',
      lastSeenAt: new Date(),
    });

    const app = createApp({
      logger: silentLogger,
      tokenVerifier: createFakeTokenVerifier({ identities: { [TOKEN]: IDENTITY } }),
      userRateLimitConfig: { USER_RATE_LIMIT_PER_MIN: 2 },
    });

    const meRequest = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${TOKEN}`);
    const adminRequest = await request(app)
      .get('/api/v1/admin/job-runs')
      .set('Authorization', `Bearer ${TOKEN}`);
    const thirdRequest = await request(app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(meRequest.status).toBe(200);
    expect(adminRequest.status).toBe(200);
    expect(thirdRequest.status).toBe(429);
    expect(thirdRequest.body.error.code).toBe('RATE_LIMITED');
  });
});

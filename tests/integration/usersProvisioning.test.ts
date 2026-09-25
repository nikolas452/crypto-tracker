import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { UserModel } from '../../src/modules/users/users.model.js';
import { resolveFromIdentity } from '../../src/modules/users/users.service.js';
import { ensureCollections } from '../../src/db/ensureCollections.js';
import { clearDatabase, startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';
import pino from 'pino';
import type { VerifiedIdentity } from '../../src/integrations/firebase/tokenVerifier.js';

const silentLogger = pino({ level: 'silent' });

/**
 * Test de integración del aprovisionamiento just-in-time contra un Mongo en
 * memoria real (spec user-profile, E3-5): un burst de requests concurrentes
 * para el mismo `firebaseUid` desconocido debe crear un único documento.
 *
 * Se ejercita directamente `resolveFromIdentity` con `Promise.all` en lugar
 * de una ruta HTTP real, porque la ruta autenticada que dispararía esto
 * (`GET /api/v1/me`) es un endpoint de la Fase B de auth-firebase, todavía no
 * implementado en esta etapa.
 *
 * TODO(auth-firebase Fase B): una vez exista `GET /api/v1/me` con
 * `requireAuth`, agregar (o reemplazar esto por) la versión a nivel HTTP de
 * E3-5 usando `createApp({ tokenVerifier: fake })` + `supertest` +
 * `Promise.all`, asertando que las 10 respuestas son 200.
 */
describe('user provisioning under concurrency (integration)', () => {
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

  // E3-5.
  it('creates exactly one document for 10 concurrent requests with the same unknown uid', async () => {
    const identity: VerifiedIdentity = {
      uid: 'concurrent-uid-1',
      email: 'concurrent@example.com',
      emailVerified: true,
      name: 'Concurrent User',
    };
    const now = new Date();

    const results = await Promise.all(
      Array.from({ length: 10 }, () => resolveFromIdentity(identity, now)),
    );

    expect(results).toHaveLength(10);
    results.forEach((result) => {
      expect(result.firebaseUid).toBe(identity.uid);
    });

    const idsInResult = new Set(results.map((result) => result.id));
    expect(idsInResult.size).toBe(1);

    const count = await UserModel.countDocuments({ firebaseUid: identity.uid });
    expect(count).toBe(1);
  });
});

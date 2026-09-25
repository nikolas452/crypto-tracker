import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import { createApp } from '../../src/app.js';
import { UserModel } from '../../src/modules/users/users.model.js';
import { createFakeTokenVerifier } from '../../src/integrations/firebase/fakeTokenVerifier.js';
import { ensureCollections } from '../../src/db/ensureCollections.js';
import { clearDatabase, startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';

const silentLogger = pino({ level: 'silent' });

const TOKEN = 'user-token';
const IDENTITY = {
  uid: 'me-uid-1',
  email: 'me-user@example.com',
  emailVerified: true,
  name: null,
};

/** `createApp` con un `FakeTokenVerifier` que resuelve `TOKEN` -> `IDENTITY` (spec me-endpoints). */
function createAppWithFakeAuth() {
  return createApp({
    logger: silentLogger,
    tokenVerifier: createFakeTokenVerifier({ identities: { [TOKEN]: IDENTITY } }),
  });
}

/**
 * Tests de integración de `GET`/`PATCH`/`DELETE /api/v1/me` (spec
 * me-endpoints), contra un Mongo en memoria real y un `FakeTokenVerifier` —
 * nunca un proyecto de Firebase real.
 */
describe('me API (integration)', () => {
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

  it('rejects a request with no Authorization header with 401 UNAUTHENTICATED', async () => {
    const app = createAppWithFakeAuth();
    const response = await request(app).get('/api/v1/me');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  // E3-4.
  it('E3-4: a new uid is provisioned and its profile returned', async () => {
    const app = createAppWithFakeAuth();
    const response = await request(app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      email: IDENTITY.email,
      emailVerified: true,
      displayName: null,
      role: 'user',
    });
    expect(typeof response.body.data.id).toBe('string');
    expect(response.body.data.createdAt).toBeDefined();

    const count = await UserModel.countDocuments({ firebaseUid: IDENTITY.uid });
    expect(count).toBe(1);
  });

  describe('PATCH /api/v1/me', () => {
    // E3-8 (parte 1): displayName aceptado.
    it('E3-8: updates displayName', async () => {
      const app = createAppWithFakeAuth();
      const response = await request(app)
        .patch('/api/v1/me')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ displayName: 'Nico' });

      expect(response.status).toBe(200);
      expect(response.body.data.displayName).toBe('Nico');

      const stored = await UserModel.findOne({ firebaseUid: IDENTITY.uid }).lean();
      expect(stored?.displayName).toBe('Nico');
    });

    it('clears displayName when sent as null', async () => {
      const app = createAppWithFakeAuth();
      await request(app)
        .patch('/api/v1/me')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ displayName: 'Nico' });

      const response = await request(app)
        .patch('/api/v1/me')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ displayName: null });

      expect(response.status).toBe(200);
      expect(response.body.data.displayName).toBeNull();
    });

    // E3-8 (parte 2): role rechazado con 400.
    it('E3-8: rejects an attempt to set role with 400 VALIDATION_ERROR', async () => {
      const app = createAppWithFakeAuth();
      const response = await request(app)
        .patch('/api/v1/me')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ role: 'admin' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');

      const stored = await UserModel.findOne({ firebaseUid: IDENTITY.uid }).lean();
      expect(stored?.role ?? 'user').toBe('user');
    });

    it('rejects an empty body with 400 VALIDATION_ERROR', async () => {
      const app = createAppWithFakeAuth();
      const response = await request(app)
        .patch('/api/v1/me')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects an attempt to set email with 400 VALIDATION_ERROR', async () => {
      const app = createAppWithFakeAuth();
      const response = await request(app)
        .patch('/api/v1/me')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ email: 'someone-else@example.com' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('DELETE /api/v1/me', () => {
    // E3-11.
    it('E3-11: deletes the profile and responds 204', async () => {
      const app = createAppWithFakeAuth();
      await request(app).get('/api/v1/me').set('Authorization', `Bearer ${TOKEN}`);

      const response = await request(app)
        .delete('/api/v1/me')
        .set('Authorization', `Bearer ${TOKEN}`);

      expect(response.status).toBe(204);
      expect(response.body).toEqual({});

      const count = await UserModel.countDocuments({ firebaseUid: IDENTITY.uid });
      expect(count).toBe(0);
    });

    // Documentado en el README (tarea 7.5): la cuenta de Firebase sobrevive,
    // así que un request posterior con un token todavía válido reaprovisiona
    // un perfil vacío nuevo.
    it('re-provisions an empty profile on a later request with a still-valid token', async () => {
      const app = createAppWithFakeAuth();
      await request(app).get('/api/v1/me').set('Authorization', `Bearer ${TOKEN}`);
      await request(app).delete('/api/v1/me').set('Authorization', `Bearer ${TOKEN}`);

      const response = await request(app)
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${TOKEN}`);

      expect(response.status).toBe(200);
      expect(response.body.data.role).toBe('user');
      expect(response.body.data.displayName).toBeNull();

      const count = await UserModel.countDocuments({ firebaseUid: IDENTITY.uid });
      expect(count).toBe(1);
    });
  });
});

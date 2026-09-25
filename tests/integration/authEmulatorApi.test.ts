import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import { getAuth } from 'firebase-admin/auth';
import { createApp } from '../../src/app.js';
import { config } from '../../src/config/env.js';
import { initializeFirebaseAdmin } from '../../src/integrations/firebase/admin.js';
import { createFirebaseTokenVerifier } from '../../src/integrations/firebase/tokenVerifier.js';
import { buildSignInUrl, signInWithPassword } from '../../src/scripts/authToken.js';
import { ensureCollections } from '../../src/db/ensureCollections.js';
import { startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';

const silentLogger = pino({ level: 'silent' });

/**
 * Suite OPCIONAL (spec auth-dev-scripts, tarea 10.1) contra el emulador REAL
 * de Firebase Auth: crea un usuario, obtiene un ID token real vía
 * `accounts:signInWithPassword` (el mismo camino que el script `auth:token`)
 * y llama a `GET /api/v1/me` con el `TokenVerifier` real (nunca el
 * `FakeTokenVerifier` que usa el resto de la suite de integración) — un
 * ejercicio de punta a punta que ninguna otra prueba cubre.
 *
 * Se salta por completo con `describe.skipIf`, sin abrir ninguna conexión de
 * red ni tocar `firebase-admin`, cuando `FIREBASE_AUTH_EMULATOR_HOST` no está
 * definida — que es el caso en cualquier `npm test` normal de este
 * repositorio/CI (nunca hay un emulador corriendo ahí). Lee la variable a
 * través del `config` ya validado (`src/config/env.ts` es el único módulo
 * autorizado a leer `process.env` directamente), no de `process.env`. Para
 * correrla de verdad: `firebase emulators:start --only auth`, exportar
 * `FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099` y `FIREBASE_PROJECT_ID`
 * (cualquier id sirve contra el emulador) y entonces `npm test`.
 */
describe.skipIf(!config.FIREBASE_AUTH_EMULATOR_HOST)(
  'Firebase Auth emulator (optional integration, E3-14-adjacent)',
  () => {
    beforeAll(async () => {
      await startInMemoryMongo();
      await ensureCollections(silentLogger);
    }, 120000);

    afterAll(async () => {
      await stopInMemoryMongo();
    });

    it('creates a user against the emulator, obtains a token and calls GET /api/v1/me', async () => {
      const email = `emulator-test-${Date.now()}@example.com`;
      const password = 'Passw0rd!';

      const firebaseApp = initializeFirebaseAdmin(config, silentLogger);
      await getAuth(firebaseApp).createUser({ email, password, emailVerified: true });

      const signInUrl = buildSignInUrl(config);
      const idToken = await signInWithPassword(signInUrl, email, password);

      const app = createApp({
        logger: silentLogger,
        tokenVerifier: createFirebaseTokenVerifier(firebaseApp),
      });

      const response = await request(app)
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${idToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data.email).toBe(email);
      expect(response.body.data.role).toBe('user');
    });
  },
);

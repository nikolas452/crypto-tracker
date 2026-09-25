import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { createApp } from '../../src/app.js';
import { createFakeTokenVerifier } from '../../src/integrations/firebase/fakeTokenVerifier.js';

/**
 * Tests unitarios del cableado de `tokenVerifier` en `createApp(deps)`
 * (auth-firebase, tarea 3.5): construir la app nunca exige credenciales de
 * Firebase (el default es perezoso), y un `tokenVerifier` inyectado queda
 * disponible en `app.locals` para que la Fase B lo consuma en `requireAuth`.
 */

const silentLogger = pino({ level: 'silent' });

describe('createApp — tokenVerifier wiring', () => {
  it('builds the app with no Firebase env configured, without touching firebase-admin', () => {
    expect(() => createApp({ logger: silentLogger })).not.toThrow();
  });

  it('exposes the default lazy token verifier on app.locals', () => {
    const app = createApp({ logger: silentLogger });

    expect(app.locals.tokenVerifier).toBeDefined();
    expect(typeof app.locals.tokenVerifier.verify).toBe('function');
  });

  it('exposes an injected FakeTokenVerifier on app.locals instead of the default', () => {
    const fake = createFakeTokenVerifier({
      identities: { 'valid-token': { uid: 'u1', email: null, emailVerified: false, name: null } },
    });

    const app = createApp({ logger: silentLogger, tokenVerifier: fake });

    expect(app.locals.tokenVerifier).toBe(fake);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { deleteApp, getApps } from 'firebase-admin/app';
import type { Logger } from 'pino';
import {
  initializeFirebaseAdmin,
  normalizePrivateKey,
} from '../../src/integrations/firebase/admin.js';
import { parseEnv } from '../../src/config/env.js';

/**
 * Tests unitarios de `src/integrations/firebase/admin.ts`: normalización de
 * la private key, reutilización de la app entre llamadas, y las guardas de
 * emulador (warn fuera de producción, exit 1 en producción).
 */

function fakeLogger(): Logger {
  return { warn: vi.fn(), fatal: vi.fn() } as unknown as Logger;
}

// `cert()` parsea de verdad el PEM de la private key (aunque nunca llegue a
// usarse para firmar nada en estos tests), así que hace falta una clave RSA
// sintácticamente válida — generada una sola vez, nunca una real de
// producción — en lugar de un string arbitrario.
const FAKE_PRIVATE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  type: 'pkcs8',
  format: 'pem',
}) as string;

// El registro de apps de `firebase-admin` es un singleton a nivel de módulo:
// se limpia entre tests para que cada uno arranque con `getApps()` vacío.
afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('normalizePrivateKey', () => {
  it('replaces literal \\n sequences with real newlines', () => {
    expect(normalizePrivateKey('line1\\nline2\\nline3')).toBe('line1\nline2\nline3');
  });

  it('leaves a key that already has real newlines untouched', () => {
    expect(normalizePrivateKey('line1\nline2')).toBe('line1\nline2');
  });

  it('is a pure function: the same input always returns the same output', () => {
    const input = '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n';
    expect(normalizePrivateKey(input)).toBe(normalizePrivateKey(input));
  });
});

describe('initializeFirebaseAdmin', () => {
  it('reuses the existing app instead of initializing a new one on repeated calls', () => {
    const cfg = parseEnv({
      MONGODB_URI: 'mongodb://localhost:27017',
      FIREBASE_PROJECT_ID: 'demo-project',
      FIREBASE_CLIENT_EMAIL: 'sa@demo-project.iam.gserviceaccount.com',
      FIREBASE_PRIVATE_KEY: FAKE_PRIVATE_KEY,
    });
    const logger = fakeLogger();

    const first = initializeFirebaseAdmin(cfg, logger);
    const second = initializeFirebaseAdmin(cfg, logger);

    expect(second).toBe(first);
    expect(getApps()).toHaveLength(1);
  });

  it('logs a warn when the emulator is used outside production', () => {
    const cfg = parseEnv({
      MONGODB_URI: 'mongodb://localhost:27017',
      NODE_ENV: 'development',
      FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
      FIREBASE_PROJECT_ID: 'demo-project',
    });
    const logger = fakeLogger();

    initializeFirebaseAdmin(cfg, logger);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.fatal).not.toHaveBeenCalled();
  });

  // E3-13.
  it('logs fatal and exits with code 1 when the emulator is set in production', () => {
    const cfg = parseEnv({
      MONGODB_URI: 'mongodb://localhost:27017',
      NODE_ENV: 'production',
      FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
    });
    const logger = fakeLogger();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    initializeFirebaseAdmin(cfg, logger);

    expect(logger.fatal).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('does not warn when no emulator host is configured', () => {
    const cfg = parseEnv({
      MONGODB_URI: 'mongodb://localhost:27017',
      FIREBASE_PROJECT_ID: 'demo-project',
      FIREBASE_CLIENT_EMAIL: 'sa@demo-project.iam.gserviceaccount.com',
      FIREBASE_PRIVATE_KEY: FAKE_PRIVATE_KEY,
    });
    const logger = fakeLogger();

    initializeFirebaseAdmin(cfg, logger);

    expect(logger.warn).not.toHaveBeenCalled();
  });
});

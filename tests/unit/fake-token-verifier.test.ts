import { describe, expect, it } from 'vitest';
import { createFakeTokenVerifier } from '../../src/integrations/firebase/fakeTokenVerifier.js';
import {
  FirebaseUnavailableError,
  TokenExpiredError,
  TokenRevokedError,
  UnauthenticatedError,
  UserDisabledError,
} from '../../src/lib/errors.js';

/**
 * Tests unitarios de `FakeTokenVerifier`
 * (`src/integrations/firebase/fakeTokenVerifier.ts`): resuelve identidades
 * fijas sin red, y puede configurarse para lanzar cada fila de la tabla de
 * traducción de errores (spec token-verification).
 */

describe('createFakeTokenVerifier', () => {
  it('resolves a token against the fixed identity map without any network call', async () => {
    const identity = { uid: 'u1', email: 'a@b.com', emailVerified: true, name: 'A' };
    const verifier = createFakeTokenVerifier({ identities: { 'valid-token': identity } });

    await expect(verifier.verify('valid-token')).resolves.toEqual(identity);
  });

  it('throws UnauthenticatedError for an unknown token', async () => {
    const verifier = createFakeTokenVerifier();

    await expect(verifier.verify('unknown-token')).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it.each([
    ['TOKEN_EXPIRED', TokenExpiredError],
    ['TOKEN_REVOKED', TokenRevokedError],
    ['USER_DISABLED', UserDisabledError],
    ['UNAUTHENTICATED', UnauthenticatedError],
    ['FIREBASE_UNAVAILABLE', FirebaseUnavailableError],
  ] as const)('throws %s as %s when configured', async (failure, ErrorClass) => {
    const verifier = createFakeTokenVerifier({ failures: { 'bad-token': failure } });

    await expect(verifier.verify('bad-token')).rejects.toBeInstanceOf(ErrorClass);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'firebase-admin/app';
import {
  FirebaseUnavailableError,
  TokenExpiredError,
  TokenRevokedError,
  UnauthenticatedError,
  UserDisabledError,
} from '../../src/lib/errors.js';

/**
 * Tests unitarios de `src/integrations/firebase/tokenVerifier.ts`: el
 * default de `checkRevoked`, la normalización de la identidad devuelta, y
 * cada fila de la tabla de traducción de errores de Firebase (spec
 * token-verification).
 */

const verifyIdToken = vi.fn();

// `vi.mock` se hoistea por encima de los imports estáticos de abajo, así que
// `createFirebaseTokenVerifier` recibe esta versión falsa de `getAuth`.
vi.mock('firebase-admin/auth', () => ({
  getAuth: () => ({ verifyIdToken }),
}));

const { createFirebaseTokenVerifier, translateFirebaseAuthError } = await import(
  '../../src/integrations/firebase/tokenVerifier.js'
);

const fakeApp = {} as unknown as App;

function firebaseError(code: string): Error {
  return Object.assign(new Error(`Firebase error ${code}`), { code });
}

describe('createFirebaseTokenVerifier', () => {
  beforeEach(() => {
    verifyIdToken.mockReset();
  });

  it('defaults checkRevoked to false when no options are given', async () => {
    verifyIdToken.mockResolvedValue({ uid: 'u1' });
    const verifier = createFirebaseTokenVerifier(fakeApp);

    await verifier.verify('a-token');

    expect(verifyIdToken).toHaveBeenCalledWith('a-token', false);
  });

  it('passes checkRevoked: true through when requested', async () => {
    verifyIdToken.mockResolvedValue({ uid: 'u1' });
    const verifier = createFirebaseTokenVerifier(fakeApp);

    await verifier.verify('a-token', { checkRevoked: true });

    expect(verifyIdToken).toHaveBeenCalledWith('a-token', true);
  });

  it('returns a normalized identity with email/name defaulted to null when absent', async () => {
    verifyIdToken.mockResolvedValue({ uid: 'u1' });
    const verifier = createFirebaseTokenVerifier(fakeApp);

    const identity = await verifier.verify('a-token');

    expect(identity).toEqual({ uid: 'u1', email: null, emailVerified: false, name: null });
  });

  it('returns email, emailVerified and name when present in the decoded token', async () => {
    verifyIdToken.mockResolvedValue({
      uid: 'u1',
      email: 'nicolas@example.com',
      email_verified: true,
      name: 'Nicolas',
    });
    const verifier = createFirebaseTokenVerifier(fakeApp);

    const identity = await verifier.verify('a-token');

    expect(identity).toEqual({
      uid: 'u1',
      email: 'nicolas@example.com',
      emailVerified: true,
      name: 'Nicolas',
    });
  });

  it.each([
    ['auth/id-token-expired', TokenExpiredError],
    ['auth/id-token-revoked', TokenRevokedError],
    ['auth/user-disabled', UserDisabledError],
    ['auth/argument-error', UnauthenticatedError],
    ['auth/invalid-id-token', UnauthenticatedError],
  ] as const)('translates Firebase error %s into %s', async (code, ErrorClass) => {
    verifyIdToken.mockRejectedValue(firebaseError(code));
    const verifier = createFirebaseTokenVerifier(fakeApp);

    await expect(verifier.verify('a-token')).rejects.toBeInstanceOf(ErrorClass);
  });

  // Fallo de red durante la comprobación de revocación: sin código `auth/*` reconocible.
  it('translates a network failure with no auth/* code into FirebaseUnavailableError', async () => {
    verifyIdToken.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    const verifier = createFirebaseTokenVerifier(fakeApp);

    await expect(verifier.verify('a-token', { checkRevoked: true })).rejects.toBeInstanceOf(
      FirebaseUnavailableError,
    );
  });
});

describe('translateFirebaseAuthError', () => {
  it('never leaks the original error message into the translated error', () => {
    const secretToken = 'super-secret-id-token-value';
    const translated = translateFirebaseAuthError(firebaseError('auth/argument-error'));

    expect(translated.message).not.toContain(secretToken);
  });

  it('falls back to FirebaseUnavailableError for an error with no recognizable auth/* code', () => {
    expect(translateFirebaseAuthError(new Error('boom'))).toBeInstanceOf(FirebaseUnavailableError);
  });
});

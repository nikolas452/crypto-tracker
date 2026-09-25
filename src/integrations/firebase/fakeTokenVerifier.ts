import {
  TokenExpiredError,
  TokenRevokedError,
  UnauthenticatedError,
  UserDisabledError,
  FirebaseUnavailableError,
} from '../../lib/errors.js';
import type { TokenVerifier, VerifiedIdentity, VerifyOptions } from './tokenVerifier.js';

/**
 * Implementación falsa de `TokenVerifier`, usada exclusivamente por tests
 * (spec token-verification: "los tests verifican tokens sin acceso a red").
 * Resuelve contra un mapa fijo de token -> identidad, o lanza el error
 * configurado para ese token, sin ninguna llamada a Firebase.
 */

/** Una de las filas de la tabla de traducción de errores de Firebase (spec token-verification). */
export type FakeTokenFailure =
  | 'TOKEN_EXPIRED'
  | 'TOKEN_REVOKED'
  | 'USER_DISABLED'
  | 'UNAUTHENTICATED'
  | 'FIREBASE_UNAVAILABLE';

function errorForFailure(failure: FakeTokenFailure): Error {
  switch (failure) {
    case 'TOKEN_EXPIRED':
      return new TokenExpiredError();
    case 'TOKEN_REVOKED':
      return new TokenRevokedError();
    case 'USER_DISABLED':
      return new UserDisabledError();
    case 'UNAUTHENTICATED':
      return new UnauthenticatedError();
    case 'FIREBASE_UNAVAILABLE':
      return new FirebaseUnavailableError();
  }
}

export interface FakeTokenVerifierOptions {
  /** Mapa fijo de token -> identidad que `verify()` resuelve exitosamente. */
  readonly identities?: Readonly<Record<string, VerifiedIdentity>>;
  /** Mapa fijo de token -> fila de la tabla de errores que `verify()` lanza. */
  readonly failures?: Readonly<Record<string, FakeTokenFailure>>;
}

/**
 * Crea un `TokenVerifier` falso a partir de un mapa fijo de tokens conocidos.
 * `checkRevoked` se acepta (para que los tests puedan aseverar cómo se
 * invocó) pero no cambia el resultado: la revocación es un detalle de la
 * implementación real, no de la falsa.
 */
export function createFakeTokenVerifier(options: FakeTokenVerifierOptions = {}): TokenVerifier {
  const identities = options.identities ?? {};
  const failures = options.failures ?? {};

  return {
    async verify(idToken: string, _opts?: VerifyOptions): Promise<VerifiedIdentity> {
      const failure = failures[idToken];
      if (failure) {
        throw errorForFailure(failure);
      }

      const identity = identities[idToken];
      if (!identity) {
        throw new UnauthenticatedError();
      }

      return identity;
    },
  };
}

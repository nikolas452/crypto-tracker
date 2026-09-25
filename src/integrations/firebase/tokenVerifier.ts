import { getAuth } from 'firebase-admin/auth';
import type { App } from 'firebase-admin/app';
import { initializeFirebaseAdmin } from './admin.js';
import {
  TokenExpiredError,
  TokenRevokedError,
  UnauthenticatedError,
  UserDisabledError,
  FirebaseUnavailableError,
  type AppError,
} from '../../lib/errors.js';

/**
 * Contrato `TokenVerifier` (spec token-verification): la abstracción que
 * `requireAuth` (Fase B) usa para verificar tokens de ID de Firebase sin
 * acoplarse directamente al SDK. La implementación real vive acá; la
 * implementación falsa para tests vive en `fakeTokenVerifier.ts`.
 */

/** Identidad verificada y normalizada a partir de un token de ID de Firebase. */
export interface VerifiedIdentity {
  readonly uid: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly name: string | null;
}

export interface VerifyOptions {
  /**
   * Si se debe comprobar la revocación del token contra el backend de
   * Firebase (una llamada de red extra). Por defecto `false` — ver
   * design.md: se activa solo para operaciones destructivas o privilegiadas.
   */
  readonly checkRevoked?: boolean;
}

export interface TokenVerifier {
  verify(idToken: string, opts?: VerifyOptions): Promise<VerifiedIdentity>;
}

/** Forma mínima de un error de `firebase-admin` que nos interesa para traducir. */
interface FirebaseLikeError {
  readonly code?: string;
}

function isFirebaseLikeError(error: unknown): error is FirebaseLikeError {
  return typeof error === 'object' && error !== null && 'code' in error;
}

/**
 * Traduce un error lanzado por `verifyIdToken` a la jerarquía `AppError` del
 * proyecto, según la tabla fija de la spec token-verification:
 *
 * - `auth/id-token-expired` -> `TokenExpiredError` (`TOKEN_EXPIRED`)
 * - `auth/id-token-revoked` -> `TokenRevokedError` (`TOKEN_REVOKED`)
 * - `auth/user-disabled` -> `UserDisabledError` (`USER_DISABLED`)
 * - cualquier otro código `auth/*` (argumento inválido, firma inválida,
 *   audiencia de otro proyecto, etc.) -> `UnauthenticatedError`
 *   (`UNAUTHENTICATED`)
 * - cualquier error sin un código `auth/*` reconocible (típicamente un fallo
 *   de red durante la comprobación de revocación) -> `FirebaseUnavailableError`
 *   (`FIREBASE_UNAVAILABLE`)
 *
 * El mensaje nunca incluye el token verificado ni ningún dato del error
 * original que pudiera filtrarlo.
 */
export function translateFirebaseAuthError(error: unknown): AppError {
  if (isFirebaseLikeError(error) && typeof error.code === 'string' && error.code.startsWith('auth/')) {
    switch (error.code) {
      case 'auth/id-token-expired':
        return new TokenExpiredError();
      case 'auth/id-token-revoked':
        return new TokenRevokedError();
      case 'auth/user-disabled':
        return new UserDisabledError();
      default:
        return new UnauthenticatedError();
    }
  }

  return new FirebaseUnavailableError('Firebase no disponible al verificar el token', {
    cause: error,
  });
}

/**
 * Implementación real de `TokenVerifier` sobre `getAuth().verifyIdToken()`.
 * Se construye una sola vez en `src/server.ts`, sobre la app inicializada por
 * `initializeFirebaseAdmin()`; nunca se instancia en `createApp()` para que
 * los tests puedan inyectar `FakeTokenVerifier` sin tocar `firebase-admin`.
 */
export function createFirebaseTokenVerifier(app: App): TokenVerifier {
  return {
    async verify(idToken: string, opts: VerifyOptions = {}): Promise<VerifiedIdentity> {
      const checkRevoked = opts.checkRevoked ?? false;

      try {
        const decoded = await getAuth(app).verifyIdToken(idToken, checkRevoked);

        return {
          uid: decoded.uid,
          email: decoded.email ?? null,
          emailVerified: decoded.email_verified ?? false,
          name: typeof decoded.name === 'string' ? decoded.name : null,
        };
      } catch (error) {
        throw translateFirebaseAuthError(error);
      }
    },
  };
}

/**
 * Variante perezosa de {@link createFirebaseTokenVerifier}: no llama a
 * `initializeFirebaseAdmin()` ni construye ningún objeto de `firebase-admin`
 * hasta que `verify()` se invoca por primera vez. Es el `tokenVerifier` por
 * defecto de `createApp(deps)` — así construir la app (como hace cada test de
 * integración que no necesita autenticación) nunca exige credenciales de
 * Firebase, y solo las exige el primer request que de verdad llegue a una
 * ruta protegida (Fase B).
 */
export function createLazyFirebaseTokenVerifier(): TokenVerifier {
  let realVerifier: TokenVerifier | undefined;

  return {
    verify(idToken: string, opts?: VerifyOptions): Promise<VerifiedIdentity> {
      if (!realVerifier) {
        realVerifier = createFirebaseTokenVerifier(initializeFirebaseAdmin());
      }
      return realVerifier.verify(idToken, opts);
    },
  };
}

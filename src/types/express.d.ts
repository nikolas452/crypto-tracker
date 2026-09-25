import type { UserRecord } from '../modules/users/users.service.js';
import type { TokenVerifier } from '../integrations/firebase/tokenVerifier.js';

/**
 * Augmenta los tipos de Express (spec auth-middleware): `req.auth` (identidad
 * verificada del token de Firebase), `req.user` (perfil de la aplicación
 * resuelto por `resolveFromIdentity`) y `app.locals.tokenVerifier` (el
 * `TokenVerifier` inyectado por `createApp(deps)`, Fase A, que `requireAuth`
 * lee en tiempo de request). Ambos campos de `Request` son opcionales porque
 * solo los puebla `requireAuth`; una ruta que no pasa por ese middleware
 * nunca los tiene — de ahí el helper `getUser()` (`src/lib/getUser.ts`), que
 * lanza en lugar de dejar que un handler use una aserción de no-nulo.
 *
 * `req.id` NO se redeclara acá a propósito: ya lo tipa `pino-http` sobre
 * `http.IncomingMessage` (del que `Request` hereda) como `ReqId` (`string |
 * number | object`); volver a declararlo acá con un tipo más angosto haría
 * que `Request` extienda dos interfaces con un campo `id` incompatible
 * (TS2320). El código ya angosta ese valor puntualmente a `string` con
 * `readRequestId()` (`src/middlewares/requestId.ts`) en cada call site que lo
 * necesita.
 */

export {};

declare global {
  namespace Express {
    interface Locals {
      tokenVerifier: TokenVerifier;
    }

    interface Request {
      /** Identidad verificada del token de ID de Firebase. Poblado por `requireAuth`. */
      auth?: {
        readonly uid: string;
        readonly email: string | null;
        readonly emailVerified: boolean;
      };
      /** Perfil de `users` resuelto para `auth.uid`. Poblado por `requireAuth`. */
      user?: UserRecord;
    }
  }
}

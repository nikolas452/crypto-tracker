import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { config, type Config } from './config/env.js';
import { requestId } from './middlewares/requestId.js';
import { createRequestLogger } from './middlewares/requestLogger.js';
import { createErrorHandler } from './middlewares/errorHandler.js';
import { notFoundHandler } from './middlewares/notFoundHandler.js';
import { createRateLimiter } from './middlewares/rateLimiter.js';
import { createUserRateLimiter } from './middlewares/userRateLimiter.js';
import { requireAuth } from './middlewares/requireAuth.js';
import { requireRole } from './middlewares/requireRole.js';
import { cacheControlNoStore, cacheControlPublic } from './middlewares/cacheControl.js';
import { createHealthRouter } from './routes/health.routes.js';
import { createCoinsRouter } from './modules/coins/coins.routes.js';
import { createStatusRouter } from './modules/status/status.routes.js';
import { createJobRunsRouter } from './modules/job-runs/job-runs.routes.js';
import { createUsersRouter } from './modules/users/users.routes.js';
import { createMongoReadinessCheck, type ReadinessCheck } from './lib/health.js';
import { logger as defaultLogger } from './lib/logger.js';
import { createLazyFirebaseTokenVerifier, type TokenVerifier } from './integrations/firebase/tokenVerifier.js';

export interface CreateAppDeps {
  /** Por defecto, la instancia compartida de pino de `src/lib/logger.ts`. */
  readonly logger?: Logger;
  /** Por defecto, un único chequeo de disponibilidad de `mongo`. Extensible para etapas posteriores. */
  readonly readinessChecks?: readonly ReadinessCheck[];
  /**
   * Hook exclusivo para tests: permite que los tests de integración
   * registren rutas extra (por ejemplo, una ruta que lanza una excepción,
   * para ejercitar el manejador de errores centralizado) sin agregar nunca
   * rutas de test a la tabla de rutas de producción.
   */
  readonly registerTestRoutes?: (app: Express) => void;
  /**
   * Override exclusivo para tests del presupuesto del limitador de tasa
   * (`RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MIN`). Por defecto, el `config`
   * real. Permite que los tests de integración ejerciten un límite ajustado
   * (por ejemplo, E2-15) sin mutar `process.env` para un singleton a nivel
   * de módulo que ya fue parseado.
   */
  readonly rateLimitConfig?: Pick<Config, 'RATE_LIMIT_MAX' | 'RATE_LIMIT_WINDOW_MIN'>;
  /**
   * Override exclusivo para tests del presupuesto del limitador de tasa por
   * uid (`USER_RATE_LIMIT_PER_MIN`, spec user-rate-limiting). Por defecto, el
   * `config` real. Mismo motivo que `rateLimitConfig`: permite ejercitar un
   * límite ajustado (E3-12) sin mutar `process.env` para un singleton a nivel
   * de módulo que ya fue parseado.
   */
  readonly userRateLimitConfig?: Pick<Config, 'USER_RATE_LIMIT_PER_MIN'>;
  /**
   * Verificador de tokens de ID de Firebase (spec token-verification). Por
   * defecto, una implementación perezosa respaldada por Firebase Admin real
   * (`createLazyFirebaseTokenVerifier()`), que no toca `firebase-admin` hasta
   * que de verdad se verifica un token. Los tests inyectan
   * `createFakeTokenVerifier(...)` acá para ejercitar rutas autenticadas
   * (`requireAuth`, Fase B) sin ningún proyecto de Firebase real ni acceso a
   * red — el mismo patrón de inyección por factory que
   * `logger`/`rateLimitConfig`/`userRateLimitConfig`.
   */
  readonly tokenVerifier?: TokenVerifier;
}

/**
 * Construye y devuelve una instancia de Express completamente configurada.
 * Nunca llama a `listen()` — solo `src/server.ts` lo hace, y solo una vez
 * que la conexión a la DB tuvo éxito. Esto es lo que permite que los tests
 * de integración ejerciten la app directamente con supertest, sin abrir un
 * puerto TCP.
 *
 * Orden de los middlewares (fijo, no reordenar): configuración de trust
 * proxy -> requestId -> logger de requests -> helmet -> parser de body JSON
 * -> deshabilitar x-powered-by -> rutas de health -> limitador de tasa
 * global (montado solo en `/api`, así `/health` y `/health/ready` quedan
 * exentas) -> rutas de la aplicación bajo `/api/v1` (las rutas de lectura de
 * monedas y la ruta de status, cada una precedida por su middleware
 * `Cache-Control`; `/me`, cada uno de cuyos verbos llama a `requireAuth` con
 * sus propias opciones y encadena el limitador de tasa por uid compartido;
 * las rutas de admin precedidas por `Cache-Control: no-store` y protegidas
 * por `requireAuth({ checkRevoked: true })` + el mismo limitador por uid +
 * `requireRole('admin')`) -> manejador 404 -> manejador de errores
 * centralizado.
 */
export function createApp(deps: CreateAppDeps = {}): Express {
  const logger = deps.logger ?? defaultLogger;
  const readinessChecks = deps.readinessChecks ?? [createMongoReadinessCheck()];
  const tokenVerifier = deps.tokenVerifier ?? createLazyFirebaseTokenVerifier();
  // Instancia única compartida entre `/me` y `/admin` (spec
  // user-rate-limiting: "un solo presupuesto por usuario", no uno
  // independiente por ruta) — ver `userRateLimiter.ts`.
  const userRateLimiter = createUserRateLimiter(deps.userRateLimitConfig ?? config);

  const app = express();

  // Expuesto a nivel de app (no solo como variable local) para que la Fase B
  // pueda leerlo desde `req.app.locals.tokenVerifier` en `requireAuth` sin
  // que este factory tenga que volver a resolver la dependencia.
  app.locals.tokenVerifier = tokenVerifier;

  // TRUST_PROXY: 0 en desarrollo, 1 en producción (default de config) — hace
  // que la clave basada en IP del limitador de tasa resuelva al cliente de
  // origen en lugar del proxy inverso cuando hay uno detrás (spec
  // api-rate-limiting).
  app.set('trust proxy', config.TRUST_PROXY);

  app.use(requestId);
  app.use(createRequestLogger(logger));
  app.use(helmet());
  app.use(express.json({ limit: '100kb' }));
  app.disable('x-powered-by');

  // Registrado antes del limitador de tasa para que las plataformas de
  // despliegue que hacen polling de /health y /health/ready nunca se vean
  // limitadas (spec api-rate-limiting).
  app.use(createHealthRouter(readinessChecks));

  app.use('/api', createRateLimiter(deps.rateLimitConfig ?? config));

  // Cache-Control se monta junto a cada router (spec http-caching).
  app.use('/api/v1/coins', cacheControlPublic(60), createCoinsRouter());
  app.use('/api/v1/status', cacheControlNoStore, createStatusRouter());

  // `/me`: sin Cache-Control propio (spec me-endpoints no lo pide); cada
  // verbo llama a requireAuth con sus propias opciones dentro del router
  // (ver users.routes.ts).
  app.use('/api/v1/me', createUsersRouter(userRateLimiter));

  // requireAuth + requireRole reemplazan al retirado requireAdminKey (spec
  // role-authorization, auth-firebase tarea 6.2/6.3): se montan sobre el
  // propio prefijo `/api/v1/admin` (no solo sobre el router de job-runs) para
  // que también rijan cualquier futura ruta de admin. checkRevoked: true
  // porque toda la superficie de admin es privilegiada (design.md).
  app.use(
    '/api/v1/admin',
    cacheControlNoStore,
    requireAuth({ checkRevoked: true }),
    userRateLimiter,
    requireRole('admin'),
  );
  app.use('/api/v1/admin/job-runs', createJobRunsRouter());

  if (deps.registerTestRoutes) {
    deps.registerTestRoutes(app);
  }

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));

  return app;
}

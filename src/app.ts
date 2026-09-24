import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { config, type Config } from './config/env.js';
import { requestId } from './middlewares/requestId.js';
import { createRequestLogger } from './middlewares/requestLogger.js';
import { createErrorHandler } from './middlewares/errorHandler.js';
import { notFoundHandler } from './middlewares/notFoundHandler.js';
import { createRateLimiter } from './middlewares/rateLimiter.js';
import { createRequireAdminKey } from './middlewares/requireAdminKey.js';
import { cacheControlNoStore, cacheControlPublic } from './middlewares/cacheControl.js';
import { createHealthRouter } from './routes/health.routes.js';
import { createCoinsRouter } from './modules/coins/coins.routes.js';
import { createStatusRouter } from './modules/status/status.routes.js';
import { createJobRunsRouter } from './modules/job-runs/job-runs.routes.js';
import { createMongoReadinessCheck, type ReadinessCheck } from './lib/health.js';
import { logger as defaultLogger } from './lib/logger.js';

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
   * Override exclusivo para tests de `ADMIN_API_KEY`. Por defecto, el
   * `config` real (normalmente sin definir en el entorno de test —
   * `vitest.config.ts` no la define y `npm test` nunca carga `.env`).
   * Permite que los tests de integración ejerciten tanto la rama
   * configurada (E2-13) como la no configurada (E2-14) sin mutar
   * `process.env` para un singleton a nivel de módulo que ya fue parseado —
   * la misma razón que `rateLimitConfig`.
   */
  readonly adminApiKey?: string;
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
 * `Cache-Control`, las rutas de admin precedidas por `Cache-Control:
 * no-store` y protegidas por `requireAdminKey`, más rutas a seguir en
 * etapas posteriores) -> manejador 404 -> manejador de errores centralizado.
 */
export function createApp(deps: CreateAppDeps = {}): Express {
  const logger = deps.logger ?? defaultLogger;
  const readinessChecks = deps.readinessChecks ?? [createMongoReadinessCheck()];

  const app = express();

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

  // Cache-Control se monta junto a cada router (spec http-caching), antes
  // de requireAdminKey en /api/v1/admin para que incluso su 404 por clave
  // no configurada lleve no-store, no solo las rutas de admin conocidas
  // detrás de él.
  app.use('/api/v1/coins', cacheControlPublic(60), createCoinsRouter());
  app.use('/api/v1/status', cacheControlNoStore, createStatusRouter());

  // requireAdminKey se monta sobre el propio prefijo `/api/v1/admin` (no
  // solo sobre el router de job-runs) para que también rija cualquier
  // futura ruta de admin, y para que una ADMIN_API_KEY sin configurar
  // devuelva 404 en cada path bajo ese prefijo, no solo en los conocidos
  // (spec admin-api-key).
  app.use('/api/v1/admin', cacheControlNoStore, createRequireAdminKey(deps.adminApiKey));
  app.use('/api/v1/admin/job-runs', createJobRunsRouter());

  if (deps.registerTestRoutes) {
    deps.registerTestRoutes(app);
  }

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));

  return app;
}

import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { requestId } from './middlewares/requestId.js';
import { createRequestLogger } from './middlewares/requestLogger.js';
import { createErrorHandler } from './middlewares/errorHandler.js';
import { notFoundHandler } from './middlewares/notFoundHandler.js';
import { createHealthRouter } from './routes/health.routes.js';
import { createMongoReadinessCheck, type ReadinessCheck } from './lib/health.js';
import { logger as defaultLogger } from './lib/logger.js';

export interface CreateAppDeps {
  /** Defaults to `src/lib/logger.ts`'s shared pino instance. */
  readonly logger?: Logger;
  /** Defaults to a single `mongo` readiness check. Extensible for later stages. */
  readonly readinessChecks?: readonly ReadinessCheck[];
  /**
   * Test-only hook: lets integration tests register extra routes (e.g. a
   * route that throws, to exercise the centralized error handler) without
   * ever adding test routes to the production route table.
   */
  readonly registerTestRoutes?: (app: Express) => void;
}

/**
 * Builds and returns a fully configured Express instance. Never calls
 * `listen()` — only `src/server.ts` does that, and only once the DB
 * connection has succeeded. This is what lets integration tests exercise the
 * app directly with supertest, without opening a TCP port.
 *
 * Middleware order (fixed, do not reorder): requestId -> request logger ->
 * helmet -> json body parser -> disable x-powered-by -> routes -> 404
 * handler -> centralized error handler.
 */
export function createApp(deps: CreateAppDeps = {}): Express {
  const logger = deps.logger ?? defaultLogger;
  const readinessChecks = deps.readinessChecks ?? [createMongoReadinessCheck()];

  const app = express();

  app.use(requestId);
  app.use(createRequestLogger(logger));
  app.use(helmet());
  app.use(express.json({ limit: '100kb' }));
  app.disable('x-powered-by');

  app.use(createHealthRouter(readinessChecks));

  if (deps.registerTestRoutes) {
    deps.registerTestRoutes(app);
  }

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));

  return app;
}

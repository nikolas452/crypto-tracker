import express, { type Express } from 'express';
import helmet from 'helmet';
import mongoose from 'mongoose';
import type { Db } from 'mongodb';
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
import {
  cacheControlNoStore,
  cacheControlPrivateNoCache,
  cacheControlPublic,
} from './middlewares/cacheControl.js';
import { createHealthRouter } from './routes/health.routes.js';
import { createAdminDebugRouter } from './routes/adminDebug.routes.js';
import { createCoinsRouter } from './modules/coins/coins.routes.js';
import { createAdminCoinsRouter } from './modules/coins/coins.admin.routes.js';
import { createStatusRouter } from './modules/status/status.routes.js';
import { createJobRunsRouter } from './modules/job-runs/job-runs.routes.js';
import { createAdminJobsRouter } from './modules/jobs/jobs.admin.routes.js';
import { createLazyAgenda, type AgendaProducerHandle } from './scheduler/agenda.js';
import { createUsersRouter } from './modules/users/users.routes.js';
import { createWatchlistRouter } from './modules/watchlist/watchlist.routes.js';
import { createNotificationsRouter } from './modules/notifications/notifications.routes.js';
import { createAdminNotificationsRouter } from './modules/notifications/notifications.admin.routes.js';
import { createAlertsRouter } from './modules/alerts/alerts.routes.js';
import {
  createMongoReadinessCheck,
  createCoinGeckoReadinessCheck,
  type ReadinessCheck,
} from './lib/health.js';
import { logger as defaultLogger } from './lib/logger.js';
import {
  createLazyFirebaseTokenVerifier,
  type TokenVerifier,
} from './integrations/firebase/tokenVerifier.js';
import { createLazyCoinGeckoClient } from './integrations/coingecko/coingecko.client.js';
import type { CoinGeckoClient } from './integrations/coingecko/coingecko.types.js';
import { createSmtpMailer } from './integrations/mailer/smtpMailer.js';
import type { Mailer } from './integrations/mailer/mailer.types.js';

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
   * Override exclusivo para tests del cap de ítems de watchlist
   * (`WATCHLIST_MAX_ITEMS`, spec watchlist-store). Por defecto, el `config`
   * real (50). Mismo motivo que `rateLimitConfig`: permite ejercitar el cap
   * con un valor pequeño (por ejemplo, E4-4 con `WATCHLIST_MAX_ITEMS=2`) sin
   * sembrar decenas de ítems ni mutar `process.env` para un singleton a
   * nivel de módulo que ya fue parseado.
   */
  readonly watchlistConfig?: Pick<Config, 'WATCHLIST_MAX_ITEMS'>;
  /**
   * Override exclusivo para tests del cap de alertas activas
   * (`ALERTS_MAX_ACTIVE`, spec alert-store). Por defecto, el `config` real
   * (20). Mismo motivo que `watchlistConfig`: permite ejercitar el cap con
   * un valor pequeño sin sembrar decenas de alertas ni mutar `process.env`.
   */
  readonly alertsConfig?: Pick<Config, 'ALERTS_MAX_ACTIVE'>;
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
  /**
   * Cliente de CoinGecko (spec admin-coin-management / watchlists tarea
   * 1.2), usado por los endpoints de administración de monedas para
   * validar un `coingeckoId` con `getMarkets([id])`, y por el chequeo de
   * disponibilidad opcional `coingecko` cuando `COINGECKO_READINESS_ENABLED`
   * está habilitado. Por defecto, `createLazyCoinGeckoClient()` — no
   * construye el cliente real (ni exige `COINGECKO_API_KEY`) hasta que se
   * invoca su primer método, el mismo patrón que `tokenVerifier`. En un
   * proceso real, `server.ts` construye el cliente real y ya llamó a
   * `assertCoinGeckoApiKey()` antes de construir la app.
   */
  readonly coingecko?: CoinGeckoClient;
  /**
   * Mailer (spec mailer / admin-notifications-api tarea 10.3), usado por
   * `POST /api/v1/admin/notifications/test-email` para enviar un correo de
   * prueba directo, sin pasar por el outbox. Por defecto,
   * `createSmtpMailer()` — construye el transporte de nodemailer de forma
   * síncrona sin abrir ninguna conexión real (nodemailer no conecta hasta
   * `sendMail`/`verify`), mismo espíritu no bloqueante que el default de
   * `coingecko`. Los tests inyectan `createFakeMailer(...)` acá, igual que
   * inyectan `createFakeTokenVerifier(...)` en `tokenVerifier`.
   */
  readonly mailer?: Mailer;
  /**
   * Handle de Mongo (fase 6), usado por `GET /api/v1/status` y por
   * `GET /api/v1/admin/jobs` para leer el estado de los documentos
   * recurrentes de `agenda_jobs`. Por defecto, `mongoose.connection.db` — ya
   * disponible en todo caller real (`server.ts` siempre conecta antes de
   * llamar a `createApp`) y en todo test de integración (que levanta el
   * Mongo en memoria en su `beforeAll`).
   */
  readonly db?: Db;
  /**
   * Instancia PRODUCTORA de Agenda (spec agenda-scheduler / admin-jobs-api),
   * usada por `POST /api/v1/admin/jobs/:name/{run,disable,enable}` para
   * encolar o (des)habilitar trabajo sin procesarlo nunca — la API nunca
   * llama a `agenda.start()`. Por defecto, una variante perezosa
   * (`createLazyAgenda`) que no construye la instancia real hasta el primer
   * uso efectivo — así un test que nunca toca `/admin/jobs` no abre una
   * conexión de Agenda redundante contra el Mongo compartido.
   */
  readonly agenda?: AgendaProducerHandle;
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
 * `/me/watchlist` y `/me/notifications`, cada una precedida por
 * `Cache-Control: private, no-cache`, con `requireAuth()` y el mismo
 * limitador por uid montados una sola vez dentro de su propio router; las
 * rutas de admin precedidas por `Cache-Control: no-store` y protegidas
 * por `requireAuth({ checkRevoked: true })` + el mismo limitador por uid +
 * `requireRole('admin')`) -> manejador 404 -> manejador de errores
 * centralizado.
 */
export function createApp(deps: CreateAppDeps = {}): Express {
  const logger = deps.logger ?? defaultLogger;
  const tokenVerifier = deps.tokenVerifier ?? createLazyFirebaseTokenVerifier();
  const coingecko = deps.coingecko ?? createLazyCoinGeckoClient();
  const mailer = deps.mailer ?? createSmtpMailer();
  // Resuelto perezosamente (nunca acá, al construir la app): igual que
  // `tokenVerifier`/`coingecko`, esto deja que un test que nunca toca
  // `/status` ni `/admin/jobs` construya la app sin una conexión de Mongo
  // abierta todavía.
  function requireDb(): Db {
    const db = deps.db ?? mongoose.connection.db;
    if (!db) {
      throw new Error('MongoDB connection is not open');
    }
    return db;
  }
  const agenda = deps.agenda ?? createLazyAgenda(() => ({ db: requireDb(), role: 'producer' }));
  // El chequeo `coingecko` solo se agrega cuando `COINGECKO_READINESS_ENABLED`
  // está habilitado (spec health-checks: "deshabilitado por defecto") — así
  // una caída de CoinGecko nunca saca a la API de rotación por sí sola.
  const readinessChecks = deps.readinessChecks ?? [
    createMongoReadinessCheck(),
    ...(config.COINGECKO_READINESS_ENABLED ? [createCoinGeckoReadinessCheck(coingecko)] : []),
  ];
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
  // HSTS explícito solo en producción (spec production-http-security, tarea
  // 6.1): la plataforma termina TLS ahí, así que tiene sentido pedirle al
  // navegador que solo vuelva por HTTPS; en desarrollo, sobre HTTP plano, el
  // header no aporta nada.
  app.use(
    helmet({
      hsts: config.NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true } : false,
    }),
  );
  app.use(express.json({ limit: '100kb' }));
  app.disable('x-powered-by');

  // Registrado antes del limitador de tasa para que las plataformas de
  // despliegue que hacen polling de /health y /health/ready nunca se vean
  // limitadas (spec api-rate-limiting).
  app.use(createHealthRouter(readinessChecks));

  app.use('/api', createRateLimiter(deps.rateLimitConfig ?? config));

  // Cache-Control se monta junto a cada router (spec http-caching).
  app.use('/api/v1/coins', cacheControlPublic(60), createCoinsRouter());
  app.use('/api/v1/status', cacheControlNoStore, createStatusRouter(requireDb));

  // `/me`: sin Cache-Control propio (spec me-endpoints no lo pide); cada
  // verbo llama a requireAuth con sus propias opciones dentro del router
  // (ver users.routes.ts).
  app.use('/api/v1/me', createUsersRouter(userRateLimiter));

  // `/me/watchlist`: Cache-Control: private, no-cache montado a nivel de
  // router (spec watchlist-read-api); requireAuth() + el mismo limitador de
  // tasa por uid se montan una sola vez dentro de watchlist.routes.ts, ya
  // que las cuatro rutas usan exactamente las mismas opciones (a diferencia
  // de `/me`).
  app.use(
    '/api/v1/me/watchlist',
    cacheControlPrivateNoCache,
    createWatchlistRouter(userRateLimiter, deps.watchlistConfig ?? config),
  );

  // `/me/notifications`: mismo patrón que `/me/watchlist` — Cache-Control:
  // private, no-cache a nivel de router (spec notification-outbox) y
  // requireAuth() + el mismo limitador por uid montados una sola vez dentro
  // de notifications.routes.ts.
  app.use(
    '/api/v1/me/notifications',
    cacheControlPrivateNoCache,
    createNotificationsRouter(userRateLimiter),
  );

  // `/me/alerts`: mismo patrón que `/me/watchlist` — Cache-Control: private,
  // no-cache a nivel de router (spec alert-api) y requireAuth() + el mismo
  // limitador por uid montados una sola vez dentro de alerts.routes.ts.
  app.use(
    '/api/v1/me/alerts',
    cacheControlPrivateNoCache,
    createAlertsRouter(userRateLimiter, deps.alertsConfig ?? config),
  );

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
  // Fase 6: listar/disparar/(des)habilitar los tres jobs de Agenda (spec admin-jobs-api).
  app.use('/api/v1/admin/jobs', createAdminJobsRouter(agenda, requireDb));
  // RF-4.6: alta/reactivación/activación de monedas, validadas contra
  // CoinGecko con el cliente inyectado (deps.coingecko / tarea 1.2).
  app.use('/api/v1/admin/coins', createAdminCoinsRouter(coingecko));
  // Spec admin-notifications-api: listado con diagnóstico completo, reintento
  // atómico y email de prueba inmediato que bypassea el outbox.
  app.use('/api/v1/admin/notifications', createAdminNotificationsRouter(mailer));
  // Spec production-http-security tarea 6.4: prueba que `trust proxy` resuelve
  // la IP pública real del caller detrás del proxy de la plataforma (E7-9).
  app.use('/api/v1/admin/debug', createAdminDebugRouter());

  if (deps.registerTestRoutes) {
    deps.registerTestRoutes(app);
  }

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));

  return app;
}

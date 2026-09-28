import http from 'node:http';
import { assertCoinGeckoApiKey, assertFirebaseCredentials, config } from './config/env.js';
import { logger } from './lib/logger.js';
import { connectDb, disconnectDb } from './db/connect.js';
import { ensureCollections } from './db/ensureCollections.js';
import { verifyReplicaSet } from './lib/verifyReplicaSet.js';
import { createApp } from './app.js';
import { initializeFirebaseAdmin } from './integrations/firebase/admin.js';
import { createFirebaseTokenVerifier } from './integrations/firebase/tokenVerifier.js';
import { createCoinGeckoClient } from './integrations/coingecko/coingecko.client.js';

/**
 * Punto de entrada del proceso de la API. Lee la config, conecta la base de
 * datos, y solo entonces construye la app y abre el socket, y registra la
 * secuencia ordenada de apagado. Este es el ÚNICO lugar en el código que
 * llama a `listen()`, y el único lugar que construye el `TokenVerifier` real
 * — todo lo demás lo recibe inyectado a través de `createApp(deps)`.
 */
async function main(): Promise<void> {
  assertFirebaseCredentials(config, logger);
  // RF-4.8: los endpoints de administración de monedas llaman a CoinGecko
  // para validar un `coingeckoId`, así que la API también falla rápido si
  // falta la clave — ya no es una guarda exclusiva del worker/scripts.
  assertCoinGeckoApiKey(config, logger);

  await connectDb(config.MONGODB_URI, config.MONGODB_DB_NAME, logger, {
    isProduction: config.NODE_ENV === 'production',
  });
  // Spec transactional-mongo: falla rápido si la conexión no soporta
  // transacciones, antes de que nada más toque la base de datos.
  await verifyReplicaSet(logger);
  await ensureCollections(logger);

  const firebaseApp = initializeFirebaseAdmin(config, logger);
  const tokenVerifier = createFirebaseTokenVerifier(firebaseApp);

  // Único lugar (junto con worker.ts y los scripts) que construye el
  // cliente real de CoinGecko — todo lo demás lo recibe inyectado a través
  // de `createApp(deps)` (tarea 1.2).
  const coingecko = createCoinGeckoClient({
    baseUrl: config.COINGECKO_BASE_URL,
    apiKey: config.COINGECKO_API_KEY,
    timeoutMs: config.COINGECKO_TIMEOUT_MS,
    maxRetries: config.COINGECKO_MAX_RETRIES,
    maxIdsPerCall: config.COINGECKO_MAX_IDS_PER_CALL,
    logger,
  });

  const app = createApp({ logger, tokenVerifier, coingecko });
  const server = http.createServer(app);

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.fatal({ err, port: config.PORT }, `Port ${config.PORT} is already in use`);
    } else {
      logger.fatal({ err }, 'HTTP server error');
    }
    process.exit(1);
  });

  server.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, 'API listening');
  });

  let shuttingDown = false;

  async function shutdown(signal: string, exitCode: number): Promise<void> {
    if (shuttingDown) {
      logger.warn({ signal }, 'Shutdown already in progress; forcing immediate exit');
      process.exit(1);
    }
    shuttingDown = true;

    logger.info({ signal }, 'shutdown iniciado');

    const forceExitTimer = setTimeout(() => {
      logger.error(
        { timeoutMs: config.SHUTDOWN_TIMEOUT_MS },
        'Graceful shutdown timed out; forcing exit',
      );
      process.exit(1);
    }, config.SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref();

    try {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await disconnectDb();
      clearTimeout(forceExitTimer);
      process.exit(exitCode);
    } catch (err) {
      logger.error({ err }, 'Error while shutting down');
      clearTimeout(forceExitTimer);
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM', 0);
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT', 0);
  });

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection');
    void shutdown('unhandledRejection', 1);
  });

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    void shutdown('uncaughtException', 1);
  });
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Fatal error during startup');
  process.exit(1);
});

import http from 'node:http';
import { config } from './config/env.js';
import { logger } from './lib/logger.js';
import { connectDb, disconnectDb } from './db/connect.js';
import { ensureCollections } from './db/ensureCollections.js';
import { createApp } from './app.js';

/**
 * Punto de entrada del proceso de la API. Lee la config, conecta la base de
 * datos, y solo entonces construye la app y abre el socket, y registra la
 * secuencia ordenada de apagado. Este es el ÚNICO lugar en el código que
 * llama a `listen()`.
 */
async function main(): Promise<void> {
  await connectDb(config.MONGODB_URI, config.MONGODB_DB_NAME, logger, {
    isProduction: config.NODE_ENV === 'production',
  });
  await ensureCollections(logger);

  const app = createApp({ logger });
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

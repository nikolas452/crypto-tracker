import mongoose from 'mongoose';
import type { Logger } from 'pino';

/**
 * Establece la conexión inicial a MongoDB con reintentos y backoff
 * exponencial, y registra el logging del ciclo de vida de la conexión.
 */

const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [1000, 2000, 4000, 8000] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lifecycleListenersRegistered = false;

/**
 * Conecta el logging del ciclo de vida de la conexión de Mongoose exactamente
 * una vez por proceso: `connected`/`reconnected` en `info`, `disconnected` en
 * `warn`, `error` en `error`. Se puede llamar varias veces; solo registra los
 * listeners una vez.
 */
function registerLifecycleLogging(logger: Logger): void {
  if (lifecycleListenersRegistered) {
    return;
  }
  lifecycleListenersRegistered = true;

  mongoose.connection.on('connected', () => {
    logger.info('MongoDB connection established');
  });
  mongoose.connection.on('reconnected', () => {
    logger.info('MongoDB connection reestablished');
  });
  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB connection lost');
  });
  mongoose.connection.on('error', (error: unknown) => {
    logger.error({ err: error }, 'MongoDB connection error');
  });
}

export interface ConnectDbOptions {
  readonly isProduction: boolean;
}

/**
 * Intenta la conexión inicial a MongoDB con hasta 5 intentos y backoff
 * exponencial (1s/2s/4s/8s). Cada intento fallido se loguea en `warn` con el
 * número de intento, nunca con la URI. Tras agotar todos los intentos,
 * loguea en `fatal` y termina el proceso con código 1 — el caller
 * (`server.ts`) nunca debe llamar a `listen()` antes de que esto resuelva
 * exitosamente.
 */
export async function connectDb(
  uri: string,
  dbName: string,
  logger: Logger,
  options: ConnectDbOptions = { isProduction: false },
): Promise<typeof mongoose> {
  registerLifecycleLogging(logger);

  mongoose.set('strictQuery', true);

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const connection = await mongoose.connect(uri, {
        dbName,
        autoIndex: !options.isProduction,
      });
      return connection;
    } catch (error) {
      lastError = error;
      logger.warn({ attempt, maxAttempts: MAX_ATTEMPTS }, 'MongoDB connection attempt failed');

      const backoffIndex = attempt - 1;
      const backoff = BACKOFF_MS[backoffIndex];
      if (attempt < MAX_ATTEMPTS && backoff !== undefined) {
        await sleep(backoff);
      }
    }
  }

  logger.fatal(
    { attempts: MAX_ATTEMPTS, err: lastError },
    'Could not connect to MongoDB after exhausting all retries; exiting.',
  );
  process.exit(1);
}

/** Cierra la conexión activa de Mongoose. Se usa como parte del apagado del proceso. */
export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}

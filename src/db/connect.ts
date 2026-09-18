import mongoose from 'mongoose';
import type { Logger } from 'pino';

const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [1000, 2000, 4000, 8000] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lifecycleListenersRegistered = false;

/**
 * Wires Mongoose connection lifecycle logging exactly once per process:
 * `connected`/`reconnected` at `info`, `disconnected` at `warn`, `error` at
 * `error`. Safe to call multiple times; only registers listeners once.
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
 * Attempts the initial MongoDB connection with up to 5 attempts and
 * exponential backoff (1s/2s/4s/8s). Each failed attempt is logged at `warn`
 * with the attempt number, never the URI. After exhausting all attempts,
 * logs at `fatal` and exits the process with code 1 — the caller (`server.ts`)
 * must never call `listen()` before this resolves successfully.
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

/** Closes the active Mongoose connection. Used as part of process shutdown. */
export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}

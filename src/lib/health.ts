import mongoose from 'mongoose';

/**
 * Extensible readiness check contract. Later stages append entries here
 * (Redis, SMTP, ...) without rewriting `GET /health/ready`.
 */
export interface ReadinessCheck {
  readonly name: string;
  check(): Promise<void>;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const MONGO_PING_TIMEOUT_MS = 2000;

/** Readiness check for MongoDB: connection must be open, and a ping must succeed within 2s. */
export function createMongoReadinessCheck(
  connection: mongoose.Connection = mongoose.connection,
): ReadinessCheck {
  return {
    name: 'mongo',
    async check() {
      if (connection.readyState !== 1) {
        throw new Error('Mongo connection is not open');
      }
      const db = connection.db;
      if (!db) {
        throw new Error('Mongo connection has no database handle');
      }
      await withTimeout(db.admin().ping(), MONGO_PING_TIMEOUT_MS);
    },
  };
}

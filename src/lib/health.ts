import mongoose from 'mongoose';
import type { CoinGeckoClient } from '../integrations/coingecko/coingecko.types.js';

/**
 * Chequeos de disponibilidad ("readiness") usados por `GET /health/ready`,
 * incluyendo el chequeo de conexión a MongoDB y el chequeo opcional de
 * CoinGecko (spec health-checks, RF-4.8).
 */

/**
 * Contrato extensible para chequeos de disponibilidad. Etapas posteriores
 * agregan entradas acá (Redis, SMTP, ...) sin reescribir `GET /health/ready`.
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

/** Chequeo de disponibilidad para MongoDB: la conexión debe estar abierta y un ping debe responder en menos de 2s. */
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

const COINGECKO_PING_TIMEOUT_MS = 2000;

/**
 * Chequeo de disponibilidad opcional para CoinGecko (spec health-checks:
 * "check opcional coingecko, deshabilitado por defecto"). Solo se agrega a
 * `readinessChecks` cuando `COINGECKO_READINESS_ENABLED` está habilitado
 * (`src/app.ts`) — una caída de CoinGecko nunca debe sacar a la API de
 * rotación por sí sola, así que este chequeo existe solo para diagnóstico
 * manual.
 */
export function createCoinGeckoReadinessCheck(
  client: Pick<CoinGeckoClient, 'ping'>,
): ReadinessCheck {
  return {
    name: 'coingecko',
    async check() {
      await withTimeout(client.ping(), COINGECKO_PING_TIMEOUT_MS);
    },
  };
}

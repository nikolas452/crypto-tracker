import mongoose from 'mongoose';
import type { Logger } from 'pino';

/**
 * Verifica, al arrancar, que la conexión activa a MongoDB soporte
 * transacciones (spec transactional-mongo): corre el comando `hello` y
 * comprueba que la respuesta incluya `setName`, que solo reporta un miembro
 * de un replica set. Contra una instancia standalone, `withTransaction`
 * falla recién al usarse — esta guarda lo detecta al arrancar, antes de que
 * nada más (en particular alertas/notificaciones) toque la base de datos.
 */

interface HelloResult {
  readonly setName?: string;
}

/**
 * Se llama inmediatamente después de `connectDb()` en todo entrypoint
 * (`server.ts`, `worker.ts`). Si la respuesta de `hello` no trae `setName`,
 * loguea en `fatal` y termina el proceso con código 1 — mismo patrón de
 * log-fatal-y-exit-1 que `assertCoinGeckoApiKey`/`assertFirebaseCredentials`
 * (`src/config/env.ts`).
 *
 * `connection` se recibe como parámetro (con el singleton global de Mongoose
 * como default) para poder testear el rechazo con un comando `hello` falso,
 * sin depender de una segunda instancia de Mongo que no sea un replica set.
 */
export async function verifyReplicaSet(
  logger: Pick<Logger, 'fatal'>,
  connection: mongoose.Connection = mongoose.connection,
): Promise<void> {
  const db = connection.db;
  if (!db) {
    throw new Error('verifyReplicaSet() called before the Mongo connection is open');
  }

  const hello = (await db.admin().command({ hello: 1 })) as HelloResult;

  if (!hello.setName) {
    logger.fatal(
      { hello },
      'MongoDB connection does not support transactions (the "hello" command response has no ' +
        '"setName", so the server is not running as part of a replica set). Refusing to start.',
    );
    process.exit(1);
  }
}

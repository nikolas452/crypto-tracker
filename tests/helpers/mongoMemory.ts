import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

/**
 * Helper compartido para los tests de integración: levanta/detiene una
 * instancia de MongoDB en memoria y permite limpiar la base entre tests.
 *
 * Usa `MongoMemoryReplSet` con un único nodo (en lugar de la
 * `MongoMemoryServer` standalone) porque, desde transactional-mongo, las
 * transacciones (`withTransaction`) requieren un replica set — contra una
 * instancia standalone, `commitTransaction` nunca persiste los cambios.
 */

let replSet: MongoMemoryReplSet | undefined;

/** Levanta un replica set de un solo nodo en memoria y conecta el singleton global de Mongoose a él. */
export async function startInMemoryMongo(): Promise<string> {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await replSet.waitUntilRunning();
  const uri = replSet.getUri();
  await mongoose.connect(uri, { dbName: 'crypto_tracker_test' });
  return uri;
}

/** Desconecta Mongoose y apaga el replica set de MongoDB en memoria. */
export async function stopInMemoryMongo(): Promise<void> {
  await mongoose.disconnect().catch(() => undefined);
  if (replSet) {
    await replSet.stop();
    replSet = undefined;
  }
}

/**
 * Elimina todos los documentos de cada colección para que cada test arranque
 * desde una base limpia. Recorre las colecciones REALES de la base (`db.
 * listCollections()`) en lugar de `mongoose.connection.collections`: esta
 * última solo lista las colecciones que tienen un modelo de Mongoose
 * registrado, y desde `agenda` (fase 6) `agenda_jobs`/`job_locks` — escritas
 * por Agenda directamente con el driver nativo — no siempre tienen uno.
 */
export async function clearDatabase(): Promise<void> {
  if (mongoose.connection.readyState !== mongoose.ConnectionStates.connected) {
    return;
  }

  const db = mongoose.connection.db;
  if (!db) {
    return;
  }

  const collections = await db.listCollections().toArray();
  await Promise.all(
    collections
      // `system.views` y otras colecciones internas de Mongo no aceptan
      // escrituras directas; las vistas tampoco son borrables (no tienen
      // documentos propios).
      .filter((collectionInfo) => !collectionInfo.name.startsWith('system.'))
      .filter((collectionInfo) => collectionInfo.type !== 'view')
      .map((collectionInfo) => db.collection(collectionInfo.name).deleteMany({})),
  );
}

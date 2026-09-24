import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

/**
 * Helper compartido para los tests de integración: levanta/detiene una
 * instancia de MongoDB en memoria y permite limpiar la base entre tests.
 */

let mongod: MongoMemoryServer | undefined;

/** Levanta una instancia de MongoDB en memoria y conecta el singleton global de Mongoose a ella. */
export async function startInMemoryMongo(): Promise<string> {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  await mongoose.connect(uri, { dbName: 'crypto_tracker_test' });
  return uri;
}

/** Desconecta Mongoose y apaga la instancia de MongoDB en memoria. */
export async function stopInMemoryMongo(): Promise<void> {
  await mongoose.disconnect().catch(() => undefined);
  if (mongod) {
    await mongod.stop();
    mongod = undefined;
  }
}

/** Elimina todos los documentos de cada colección para que cada test arranque desde una base limpia. */
export async function clearDatabase(): Promise<void> {
  if (mongoose.connection.readyState !== mongoose.ConnectionStates.connected) {
    return;
  }

  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((collection) => collection.deleteMany({})));
}

import { MongoMemoryServer } from 'mongodb-memory-server';

/**
 * Global setup de Vitest: corre una sola vez, en el proceso principal, antes
 * de que se levanten los workers que ejecutan los archivos de test en
 * paralelo. Descarga (o reutiliza desde caché) el binario de MongoDB una
 * única vez, evitando que varios workers de tests de integración intenten
 * descargarlo al mismo tiempo y pisen el mismo archivo temporal — esa carrera
 * es la causa del ENOENT en `rename(....tgz.downloading -> ...tgz)` visto en CI.
 *
 * `MONGOMS_VERSION` ya llega seteada en `process.env` acá: Vitest aplica
 * `test.env` (vitest.config.ts) en el proceso principal antes de correr este
 * setup, así que se usa la misma versión que cada worker.
 */
export default async function setup(): Promise<void> {
  const mongod = await MongoMemoryServer.create();
  await mongod.stop();
}

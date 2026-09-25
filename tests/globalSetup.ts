import { MongoMemoryServer } from 'mongodb-memory-server';
import { MONGOMS_VERSION } from './helpers/mongoBinaryVersion.js';

/**
 * Global setup de Vitest: corre una sola vez, en el proceso principal, antes
 * de que se levanten los workers que ejecutan los archivos de test en
 * paralelo. Descarga (o reutiliza desde caché) el binario de MongoDB una
 * única vez, evitando que varios workers de tests de integración intenten
 * descargarlo al mismo tiempo y pisen el mismo archivo temporal — esa carrera
 * es la causa del ENOENT en `rename(....tgz.downloading -> ...tgz)` visto en CI.
 *
 * La versión se pasa explícita: `test.env` (vitest.config.ts) solo se inyecta
 * en el `process.env` de los workers que corren los test files, nunca en el
 * proceso principal donde corre este setup — si se dependiera de
 * `process.env.MONGOMS_VERSION` acá, este setup precalentaría la versión por
 * default de la librería (no necesariamente 8.0.11) y los workers, que sí
 * piden 8.0.11 vía su propio `MONGOMS_VERSION`, seguirían compitiendo por
 * descargarla igual que antes.
 */
export default async function setup(): Promise<void> {
  const mongod = await MongoMemoryServer.create({ binary: { version: MONGOMS_VERSION } });
  await mongod.stop();
}

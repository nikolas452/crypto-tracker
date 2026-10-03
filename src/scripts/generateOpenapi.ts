// Script que genera `openapi.json` a partir de las anotaciones de las rutas (detalle en `runGenerateOpenapi`).
import { renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildOpenapiDocument } from '../docs/buildOpenapiDocument.js';
import { openapiOutputPath } from '../docs/openapiPaths.js';

/**
 * `npm run openapi:generate`: genera `openapi.json` en la raíz del repositorio
 * a partir de las anotaciones `@openapi` de las rutas y de
 * `src/docs/components.yaml`. Corre en `npm run build` justo después de `tsc`.
 *
 * Importación de `swagger-jsdoc`: ver el comentario de
 * `src/docs/buildOpenapiDocument.ts` (import por defecto, sin `createRequire`).
 *
 * Ubicación de salida: `openapi.json` en la raíz del repo (no versionado, ver
 * `.gitignore`). La ruta se calcula desde la ubicación del archivo, así que el
 * servidor la resuelve igual en desarrollo (tsx) y en `dist/` (`node
 * dist/server.js` desde la raíz tras el build), sin depender de `process.cwd()`.
 *
 * Comportamiento: el JSON se arma completo en memoria y solo si la generación
 * y la validación tuvieron éxito se escribe a un archivo temporal que luego se
 * renombra, así nunca queda un `openapi.json` parcial. Un documento sin rutas
 * (aún sin anotar) es válido y termina con código 0; una anotación malformada o
 * un `$ref` roto termina con código distinto de 0 sin escribir nada.
 */
export async function runGenerateOpenapi(outputPath: string = openapiOutputPath): Promise<number> {
  const document = await buildOpenapiDocument();
  const json = `${JSON.stringify(document, null, 2)}\n`;

  const tempPath = `${outputPath}.tmp`;
  writeFileSync(tempPath, json, 'utf8');
  renameSync(tempPath, outputPath);

  return Object.keys(document.paths).length;
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  runGenerateOpenapi()
    .then((pathCount) => {
      console.log(`openapi:generate: wrote ${openapiOutputPath} (${pathCount} paths)`);
      process.exitCode = 0;
    })
    .catch((err: unknown) => {
      console.error('openapi:generate failed:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    });
}

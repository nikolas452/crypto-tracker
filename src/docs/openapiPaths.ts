/**
 * Ubicación del `openapi.json` generado, en un módulo sin efectos secundarios
 * (no lee archivos ni arma la definición) para que el servidor pueda importarla
 * sin arrastrar `swagger-jsdoc` ni la lectura de `package.json` que hace
 * `openapi.definition.ts`. La comparten el generador y el endpoint que sirve el
 * documento.
 *
 * La ruta se calcula desde la ubicación de este archivo: `src/docs/` y
 * `dist/docs/` están dos niveles bajo la raíz del repositorio, así que resuelve
 * igual en desarrollo (tsx), en Vitest y en `dist/` (`node dist/server.js`
 * ejecutado tras `npm run build`), sin depender de `process.cwd()`.
 */
import { fileURLToPath } from 'node:url';

/** Ruta absoluta del `openapi.json` generado, en la raíz del repositorio. */
export const openapiOutputPath = fileURLToPath(new URL('../../openapi.json', import.meta.url));

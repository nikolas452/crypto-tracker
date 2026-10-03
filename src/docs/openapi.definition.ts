/**
 * Definición base de la especificación OpenAPI 3.0.3 y lista de archivos que
 * `swagger-jsdoc` escanea (`apis`). Aquí viven el identificador del documento
 * (`info`, `servers`, tags por módulo); el resto (rutas y componentes) se
 * ensambla desde los bloques `@openapi` de las rutas y desde `components.yaml`.
 *
 * Resolución de rutas: las globs se anclan a la raíz del repositorio calculada
 * a partir de la ubicación de este archivo, no de `process.cwd()`. Tanto
 * `src/docs/` como `dist/docs/` están dos niveles bajo la raíz, así que el
 * cálculo es el mismo en desarrollo (tsx), en Vitest y en el build compilado.
 * Siempre se escanean los fuentes `src/**` (la generación corre desde el repo
 * en tiempo de build, nunca desde `dist/` en producción). `swagger-jsdoc` usa
 * `glob` de forma que en Windows las barras invertidas son caracteres de
 * escape, por eso las rutas se normalizan a `/`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Raíz del repositorio con separadores `/` y sin barra final. */
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
  .replaceAll('\\', '/')
  .replace(/\/$/, '');

/**
 * Ubicación del `openapi.json` generado. Vive en `openapiPaths.ts` (sin efectos
 * secundarios) para que el servidor la importe sin cargar esta definición; se
 * reexporta aquí para que el generador y los tests la sigan encontrando.
 */
export { openapiOutputPath } from './openapiPaths.js';

/** Versión de la API tomada de `package.json` (leído en tiempo de generación). */
function readPackageVersion(): string {
  const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new Error('package.json no define una "version" válida');
  }
  return parsed.version;
}

/** Archivos que contienen anotaciones `@openapi` o YAML de componentes. */
export const openapiApis: readonly string[] = [
  `${repoRoot}/src/modules/**/*.routes.ts`,
  `${repoRoot}/src/routes/*.routes.ts`,
  `${repoRoot}/src/docs/components.yaml`,
];

/** Definición base: `swagger-jsdoc` le agrega `paths` y `components`. */
export const openapiDefinition = {
  openapi: '3.0.3',
  info: {
    title: 'Crypto Tracker API',
    version: readPackageVersion(),
    description:
      'API REST de seguimiento de criptomonedas: precios e historial, watchlist, alertas por email y administración. ' +
      'Los endpoints autenticados esperan un token de ID de Firebase en `Authorization: Bearer <token>`. ' +
      'Todos los errores usan el envoltorio `{ error: { code, message, requestId, details? } }`.',
  },
  // Las rutas se documentan con su prefijo completo (`/api/v1/...`), así que
  // `/health` y `/health/ready` conviven en el mismo documento.
  servers: [{ url: '/' }],
  tags: [
    {
      name: 'coins',
      description: 'Catálogo de monedas, precio actual, historial y estadísticas (público).',
    },
    { name: 'status', description: 'Estado operativo de los jobs de ingesta (público).' },
    {
      name: 'health',
      description: 'Chequeos de vida y disponibilidad para plataformas de despliegue.',
    },
    { name: 'docs', description: 'Documentación de la propia API (esta especificación).' },
    { name: 'me', description: 'Perfil del usuario autenticado.' },
    { name: 'watchlist', description: 'Monedas seguidas por el usuario autenticado.' },
    { name: 'alerts', description: 'Alertas de precio del usuario autenticado.' },
    { name: 'notifications', description: 'Historial de notificaciones del usuario autenticado.' },
    { name: 'admin-coins', description: 'Administración del catálogo de monedas (rol admin).' },
    { name: 'admin-jobs', description: 'Listado y control de los jobs programados (rol admin).' },
    { name: 'admin-job-runs', description: 'Historial de ejecuciones de jobs (rol admin).' },
    {
      name: 'admin-notifications',
      description: 'Diagnóstico y reintento de notificaciones (rol admin).',
    },
  ],
};

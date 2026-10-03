/**
 * Handler de Express que sirve el `openapi.json` ya generado en
 * `GET /api/v1/openapi.json`: `application/json`, `ETag` fuerte calculado del
 * contenido, `Cache-Control` público y `304` sin cuerpo cuando `If-None-Match`
 * coincide.
 *
 * Estrategia de lectura (híbrida): el archivo se intenta leer UNA vez al crear
 * el handler (al construir la app) solo para dejar un aviso en el log al
 * arrancar si todavía no fue generado; el servidor nunca falla por eso. Si la
 * lectura inicial no encontró el archivo, cada petición vuelve a intentarlo
 * hasta que aparezca (por ejemplo, tras ejecutar `npm run openapi:generate` con
 * el servidor ya levantado en desarrollo) y recién entonces lo cachea en memoria
 * junto con su ETag. Un archivo ausente nunca queda cacheado como "ausente para
 * siempre". Una vez cargado no se vuelve a leer: el documento cambia solo con un
 * nuevo build y despliegue, así que reiniciar el proceso es lo que lo refresca.
 *
 * Mientras no exista, responde `404 NOT_FOUND` con el envoltorio de error
 * estándar (se delega en el manejador de errores centralizado, que añade el
 * `requestId`).
 *
 * No depende de `swagger-jsdoc` ni de `openapi.definition.ts`: solo lee el
 * archivo, por lo que es seguro importarlo desde el servidor en producción.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { RequestHandler } from 'express';
import type { Logger } from 'pino';
import { NotFoundError } from '../lib/errors.js';
import { openapiOutputPath } from './openapiPaths.js';

/** `Cache-Control` del documento: público y revalidable con el ETag. */
export const OPENAPI_CACHE_CONTROL = 'public, max-age=300';

export interface OpenapiHandlerOptions {
  /** Ruta del `openapi.json`. Por defecto, el archivo generado en la raíz del repositorio. */
  readonly filePath?: string;
  /** Logger para el aviso de archivo ausente o ilegible. */
  readonly logger: Logger;
}

interface LoadedDocument {
  readonly body: string;
  readonly etag: string;
}

/** ETag fuerte (con comillas) derivado del contenido exacto del documento. */
function computeEtag(body: string): string {
  return `"${createHash('sha1').update(body).digest('base64')}"`;
}

export function createOpenapiHandler(options: OpenapiHandlerOptions): RequestHandler {
  const filePath = options.filePath ?? openapiOutputPath;
  const { logger } = options;
  let loaded: LoadedDocument | null = null;

  /** Lee y cachea el archivo; devuelve `null` (sin lanzar) si no existe o no se puede leer. */
  function tryLoad(logOnFailure: boolean): LoadedDocument | null {
    try {
      const body = readFileSync(filePath, 'utf8');
      loaded = { body, etag: computeEtag(body) };
      return loaded;
    } catch (error) {
      if (logOnFailure) {
        logger.warn(
          { err: error, filePath },
          'openapi.json no disponible: GET /api/v1/openapi.json responderá 404 hasta que se genere (npm run openapi:generate)',
        );
      }
      return null;
    }
  }

  tryLoad(true);

  return (req, res, next) => {
    const document = loaded ?? tryLoad(false);

    if (!document) {
      next(new NotFoundError('La especificación OpenAPI no está generada'));
      return;
    }

    res.setHeader('ETag', document.etag);
    res.setHeader('Cache-Control', OPENAPI_CACHE_CONTROL);

    if (req.fresh) {
      res.status(304).end();
      return;
    }

    res.type('application/json').send(document.body);
  };
}

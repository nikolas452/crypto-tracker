import { Router } from 'express';
import type { Logger } from 'pino';
import { createOpenapiHandler } from '../docs/openapiHandler.js';

/**
 * `GET /api/v1/openapi.json`: sirve la especificación OpenAPI generada en el
 * build. Es público y se registra en `src/app.ts` antes del limitador de tasa
 * global y del manejador 404. La lógica de lectura, ETag y `304` vive en
 * `src/docs/openapiHandler.ts`; aquí solo se monta la ruta y se documenta.
 */
export function createOpenapiRouter(options: {
  readonly filePath?: string | undefined;
  readonly logger: Logger;
}): Router {
  const router = Router();
  const handler = createOpenapiHandler({
    logger: options.logger,
    ...(options.filePath !== undefined ? { filePath: options.filePath } : {}),
  });

  /**
   * @openapi
   * /api/v1/openapi.json:
   *   get:
   *     tags: [docs]
   *     summary: Especificación OpenAPI de la API
   *     description: >-
   *       Devuelve este mismo documento OpenAPI 3.0.3 en JSON, generado en el build
   *       a partir de las anotaciones de las rutas. Es público (no requiere token) y
   *       no está sujeto al límite de peticiones por IP. Incluye un `ETag` y es
   *       cacheable (`Cache-Control: public, max-age=300`): reenviar el `ETag` en
   *       `If-None-Match` devuelve `304` sin cuerpo. Si el archivo todavía no se
   *       generó (`npm run openapi:generate`), responde `404` con código `NOT_FOUND`.
   *     security: []
   *     parameters:
   *       - name: If-None-Match
   *         in: header
   *         required: false
   *         description: '`ETag` recibido en una respuesta anterior, para obtener `304` si el documento no cambió.'
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: Documento OpenAPI.
   *         headers:
   *           X-Request-Id: { $ref: '#/components/headers/XRequestId' }
   *           ETag: { $ref: '#/components/headers/ETag' }
   *           Cache-Control:
   *             description: Cacheable por cachés compartidas durante 5 minutos.
   *             schema:
   *               type: string
   *               enum: ['public, max-age=300']
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               description: Documento OpenAPI 3.0.3 completo.
   *               additionalProperties: true
   *               required: [openapi, info, paths]
   *               properties:
   *                 openapi:
   *                   type: string
   *                   example: 3.0.3
   *                 info:
   *                   type: object
   *                 paths:
   *                   type: object
   *       '304':
   *         description: >-
   *           El documento no cambió respecto del `ETag` enviado en `If-None-Match`;
   *           la respuesta no tiene cuerpo.
   *         headers:
   *           X-Request-Id: { $ref: '#/components/headers/XRequestId' }
   *           ETag: { $ref: '#/components/headers/ETag' }
   *           Cache-Control:
   *             description: Cacheable por cachés compartidas durante 5 minutos.
   *             schema:
   *               type: string
   *               enum: ['public, max-age=300']
   *       '404':
   *         description: >-
   *           El archivo `openapi.json` todavía no fue generado (`NOT_FOUND`); se
   *           resuelve ejecutando `npm run openapi:generate`.
   *         headers:
   *           X-Request-Id: { $ref: '#/components/headers/XRequestId' }
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  router.get('/api/v1/openapi.json', handler);

  return router;
}

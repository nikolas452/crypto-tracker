/**
 * Construye el documento OpenAPI en memoria: ejecuta `swagger-jsdoc` sobre las
 * rutas anotadas y `components.yaml`, y lo valida de forma estructural y de
 * referencias. Lo comparten el script generador (`npm run openapi:generate`) y
 * los tests de contrato, para que ambos vean exactamente el mismo documento.
 *
 * Solo para build y tests: el servidor nunca llama a esto en tiempo de
 * ejecución (sirve el `openapi.json` ya generado), y depende de
 * `@apidevtools/swagger-parser`, que es una dependencia de desarrollo.
 *
 * Forma de importación verificada de `swagger-jsdoc` (paquete CommonJS) desde
 * este proyecto ESM/NodeNext: import por defecto
 * (`import swaggerJsdoc from 'swagger-jsdoc'`). Funciona con tsx, con `tsc`
 * (NodeNext + `esModuleInterop`, usando `@types/swagger-jsdoc`), con el JS
 * compilado ejecutado por node y desde un test de Vitest; no hace falta
 * `createRequire`.
 */
import swaggerJsdoc from 'swagger-jsdoc';
import SwaggerParser from '@apidevtools/swagger-parser';
import { openapiApis, openapiDefinition } from './openapi.definition.js';

/** Forma mínima del documento generado; el resto se trata como JSON opaco. */
export interface OpenapiDocument {
  readonly openapi: string;
  readonly info: { readonly title: string; readonly version: string };
  readonly paths: Record<string, unknown>;
  readonly components?: { readonly schemas?: Record<string, unknown> };
  readonly [key: string]: unknown;
}

/**
 * Genera y valida el documento. Lanza si hay YAML malformado en una anotación
 * (`failOnErrors`), si el documento no cumple el esquema de OpenAPI 3.0 o si
 * algún `$ref` no se resuelve (esto último `swagger-jsdoc` no lo detecta por sí
 * solo, por eso se valida con swagger-parser). Un documento sin rutas es válido.
 */
export async function buildOpenapiDocument(): Promise<OpenapiDocument> {
  const spec = swaggerJsdoc({
    failOnErrors: true,
    definition: openapiDefinition,
    apis: [...openapiApis],
  }) as OpenapiDocument;

  // Guarda contra una glob que no encontró `components.yaml` (por ejemplo por
  // una ruta mal formada en Windows): sin él el documento saldría incompleto.
  if (!spec.components?.schemas || !('Error' in spec.components.schemas)) {
    throw new Error(
      'El documento generado no incluye components.schemas.Error: revise las rutas de `apis` en openapi.definition.ts',
    );
  }

  // `validate` resuelve y desreferencia el documento que recibe, así que se le
  // pasa una copia para no alterar el que se devuelve.
  await SwaggerParser.validate(structuredClone(spec) as never);

  return spec;
}

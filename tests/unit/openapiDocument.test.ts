/**
 * Tests de la base de la especificación OpenAPI: el documento se genera en
 * memoria desde Vitest (valida la importación de `swagger-jsdoc`), cumple el
 * esquema de OpenAPI 3.0 y expone la identidad, la seguridad y el envoltorio de
 * error compartidos definidos en `src/docs`.
 */
import { describe, expect, it } from 'vitest';
import { buildOpenapiDocument } from '../../src/docs/buildOpenapiDocument.js';

type Schema = {
  properties?: Record<string, Schema>;
  enum?: string[];
  required?: string[];
};

describe('buildOpenapiDocument', () => {
  it('genera un documento OpenAPI 3.0.3 válido con la identidad del servicio', async () => {
    const doc = await buildOpenapiDocument();

    expect(doc.openapi).toBe('3.0.3');
    expect(doc.info.title).toBeTruthy();
    expect(doc.info.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(doc['servers']).toEqual([{ url: '/' }]);
    expect(doc.paths).toBeTypeOf('object');
  });

  it('declara el esquema bearerAuth (HTTP bearer, JWT)', async () => {
    const doc = await buildOpenapiDocument();
    const components = doc['components'] as { securitySchemes: Record<string, unknown> };

    expect(components.securitySchemes['bearerAuth']).toMatchObject({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
  });

  it('enumera todos los códigos de error en el esquema Error', async () => {
    const doc = await buildOpenapiDocument();
    const error = doc.components?.schemas?.['Error'] as Schema;
    const codes = error.properties?.['error']?.properties?.['code']?.enum;

    expect(codes).toEqual([
      'VALIDATION_ERROR',
      'UNAUTHENTICATED',
      'TOKEN_EXPIRED',
      'TOKEN_REVOKED',
      'FORBIDDEN',
      'USER_DISABLED',
      'NOT_FOUND',
      'CONFLICT',
      'UNPROCESSABLE',
      'RATE_LIMITED',
      'UPSTREAM_ERROR',
      'FIREBASE_UNAVAILABLE',
      'SERVICE_UNAVAILABLE',
      'INTERNAL_ERROR',
    ]);
  });

  it('incluye las respuestas y parámetros reutilizables', async () => {
    const doc = await buildOpenapiDocument();
    const components = doc['components'] as {
      responses: Record<string, unknown>;
      parameters: Record<string, { schema: { pattern?: string } }>;
    };

    expect(Object.keys(components.responses)).toEqual(
      expect.arrayContaining([
        'BadRequest',
        'Unauthorized',
        'Forbidden',
        'NotFound',
        'RateLimited',
        'InternalError',
      ]),
    );
    expect(components.parameters['CoingeckoId']?.schema.pattern).toBe('^[a-z0-9-]+$');
  });
});

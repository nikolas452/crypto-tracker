/**
 * Tests de integración de `GET /api/v1/openapi.json` (spec openapi-serving):
 * respuesta pública con `ETag` y `304`, posición en la cadena de middlewares
 * (ni limitado ni tapado por el manejador 404), degradación elegante cuando el
 * archivo no existe y autodescripción del endpoint en el documento generado.
 * Usan un archivo temporal inyectado con `openapiFilePath`, así no dependen de
 * que el build haya generado el `openapi.json` de la raíz. No necesitan Mongo.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { buildOpenapiDocument } from '../../src/docs/buildOpenapiDocument.js';

const silentLogger = pino({ level: 'silent' });

let tempDir: string;

/** Documento mínimo y estable para los tests que no necesitan el real. */
const FIXTURE_DOCUMENT = {
  openapi: '3.0.3',
  info: { title: 'Fixture', version: '0.0.0' },
  paths: {},
};

/** Escribe un documento JSON en el directorio temporal y devuelve su ruta. */
function writeDocument(name: string, document: unknown): string {
  const filePath = join(tempDir, name);
  writeFileSync(filePath, JSON.stringify(document), 'utf8');
  return filePath;
}

describe('GET /api/v1/openapi.json (integration)', () => {
  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'openapi-serving-'));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('serves the document anonymously as application/json with openapi 3.0.3', async () => {
    const app = createApp({
      logger: silentLogger,
      openapiFilePath: writeDocument('ok.json', FIXTURE_DOCUMENT),
    });

    const response = await request(app).get('/api/v1/openapi.json');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.body.openapi).toBe('3.0.3');
    expect(response.body.info.title).toBe('Fixture');
    expect(response.headers.etag).toMatch(/^"[^"]+"$/);
    expect(response.headers['cache-control']).toBe('public, max-age=300');
    expect(response.headers['x-request-id']).toBeDefined();
  });

  it('answers 304 with no body when If-None-Match matches the ETag', async () => {
    const app = createApp({
      logger: silentLogger,
      openapiFilePath: writeDocument('etag.json', FIXTURE_DOCUMENT),
    });

    const first = await request(app).get('/api/v1/openapi.json');
    const etag = first.headers.etag;
    expect(etag).toBeDefined();

    const second = await request(app)
      .get('/api/v1/openapi.json')
      .set('If-None-Match', etag ?? '');

    expect(second.status).toBe(304);
    expect(second.text).toBe('');
    expect(second.headers.etag).toBe(etag);
    expect(second.headers['cache-control']).toBe('public, max-age=300');
  });

  it('answers 200 again when If-None-Match does not match', async () => {
    const app = createApp({
      logger: silentLogger,
      openapiFilePath: writeDocument('etag-miss.json', FIXTURE_DOCUMENT),
    });

    const response = await request(app).get('/api/v1/openapi.json').set('If-None-Match', '"otro"');

    expect(response.status).toBe(200);
    expect(response.body.openapi).toBe('3.0.3');
  });

  it('is not throttled by the global IP rate limiter nor shadowed by the not-found handler', async () => {
    const app = createApp({
      logger: silentLogger,
      rateLimitConfig: { RATE_LIMIT_MAX: 1, RATE_LIMIT_WINDOW_MIN: 15 },
      openapiFilePath: writeDocument('limit.json', FIXTURE_DOCUMENT),
    });

    // Con un presupuesto de 1 petición, una ruta cualquiera bajo /api agota el
    // límite (control positivo: el limitador sí está activo para el resto).
    const unknown1 = await request(app).get('/api/v1/does-not-exist');
    const unknown2 = await request(app).get('/api/v1/does-not-exist');
    expect(unknown1.status).toBe(404);
    expect(unknown2.status).toBe(429);

    // El endpoint de la especificación sigue respondiendo con el documento.
    for (let i = 0; i < 3; i += 1) {
      const response = await request(app).get('/api/v1/openapi.json');
      expect(response.status).toBe(200);
      expect(response.body.error).toBeUndefined();
      expect(response.body.openapi).toBe('3.0.3');
      expect(response.headers['ratelimit-limit']).toBeUndefined();
    }
  });

  describe('when the file has not been generated', () => {
    it('creates the app, logs a warning and answers 404 NOT_FOUND in the standard envelope', async () => {
      const lines: string[] = [];
      const capturingLogger = pino(
        { level: 'warn' },
        { write: (line: string) => lines.push(line) },
      );

      const app = createApp({
        logger: capturingLogger,
        openapiFilePath: join(tempDir, 'does-not-exist.json'),
      });

      const warnings = lines.map((line) => JSON.parse(line) as { level: number; msg: string });
      expect(
        warnings.some((entry) => entry.level === 40 && entry.msg.includes('openapi.json')),
      ).toBe(true);

      const response = await request(app).get('/api/v1/openapi.json');

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
      expect(typeof response.body.error.message).toBe('string');
      expect(response.body.error.requestId).toBe(response.headers['x-request-id']);
    });

    it('picks the file up on a later request once it appears (not cached as missing)', async () => {
      const filePath = join(tempDir, 'late.json');
      const app = createApp({ logger: silentLogger, openapiFilePath: filePath });

      const before = await request(app).get('/api/v1/openapi.json');
      expect(before.status).toBe(404);

      writeFileSync(filePath, JSON.stringify(FIXTURE_DOCUMENT), 'utf8');

      const after = await request(app).get('/api/v1/openapi.json');
      expect(after.status).toBe(200);
      expect(after.body.openapi).toBe('3.0.3');
    });
  });

  describe('with the generated document', () => {
    it('describes its own endpoint as a public operation', async () => {
      const document = await buildOpenapiDocument();
      const app = createApp({
        logger: silentLogger,
        openapiFilePath: writeDocument('generated.json', document),
      });

      const response = await request(app).get('/api/v1/openapi.json');

      expect(response.status).toBe(200);
      expect(response.body.openapi).toBe('3.0.3');

      const operation = response.body.paths['/api/v1/openapi.json']?.get;
      expect(operation).toBeDefined();
      expect(operation.security).toEqual([]);
      expect(operation.tags).toContain('docs');
      expect(Object.keys(operation.responses)).toEqual(
        expect.arrayContaining(['200', '304', '404']),
      );
    });
  });
});

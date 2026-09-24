import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { clearDatabase, startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';

/** Tests de integración de los endpoints de salud (`GET /health`, `GET /health/ready`). */

describe('health checks (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 120000);

  afterEach(async () => {
    await clearDatabase();
  });

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  // E0-1: GET /health devuelve 200 con status ok, uptimeSeconds y X-Request-Id.
  it('E0-1: GET /health returns liveness status without checking dependencies', async () => {
    const app = createApp();

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(typeof response.body.uptimeSeconds).toBe('number');
    expect(response.headers['x-request-id']).toBeDefined();
  });

  // E0-2: GET /health/ready devuelve 200 con checks.mongo: "up" cuando está conectado.
  it('E0-2: GET /health/ready returns ready when Mongo is connected', async () => {
    const app = createApp();

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ready');
    expect(response.body.checks.mongo).toBe('up');
  });

  // E0-3: con Mongo desconectado, GET /health/ready devuelve 503 con status not_ready.
  // Se ejecuta último entre los checks que dependen de Mongo: desconecta Mongoose
  // dentro del test a propósito y no se reconecta, según el escenario ("desconectar
  // Mongoose dentro del test"). Los tests restantes de abajo solo ejercitan /health
  // (liveness), que nunca toca la base de datos.
  it('E0-3: GET /health/ready returns 503 when Mongo is disconnected', async () => {
    const app = createApp();

    await mongoose.connection.close();

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body.status).toBe('not_ready');
    expect(response.body.checks.mongo).toBe('down');
  });

  // E0-4: enviar X-Request-Id devuelve el mismo valor de vuelta.
  it('E0-4: echoes a client-supplied X-Request-Id back on the response', async () => {
    const app = createApp();

    const response = await request(app).get('/health').set('X-Request-Id', 'abc-123');

    expect(response.headers['x-request-id']).toBe('abc-123');
  });

  it('generates a new X-Request-Id when the client-supplied one is too long', async () => {
    const app = createApp();
    const tooLong = 'a'.repeat(129);

    const response = await request(app).get('/health').set('X-Request-Id', tooLong);

    expect(response.headers['x-request-id']).toBeDefined();
    expect(response.headers['x-request-id']).not.toBe(tooLong);
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { createCoinGeckoReadinessCheck, createMongoReadinessCheck } from '../../src/lib/health.js';
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

  // Tarea 7.2 / spec health-checks: el chequeo `coingecko` está deshabilitado
  // por defecto (`COINGECKO_READINESS_ENABLED=false` en el entorno de test),
  // así que ni siquiera aparece en `checks`, y un CoinGecko inalcanzable
  // (acá, el cliente perezoso por defecto sin `COINGECKO_API_KEY`) nunca
  // afecta el 200 de readiness. Se ejecuta ANTES de E0-3 porque, igual que
  // E0-2, depende de que Mongo siga conectado.
  it('with the coingecko check disabled (default), GET /health/ready responds 200 with no checks.coingecko entry', async () => {
    const app = createApp();

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(200);
    expect(response.body.checks.coingecko).toBeUndefined();
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

  // Complementa el caso "deshabilitado" de arriba con el escenario "explícitamente
  // habilitado" de la spec (health-checks): reporta `checks.coingecko: "down"` y 503
  // cuando el chequeo se agrega manualmente vía `readinessChecks` y CoinGecko falla.
  it('when explicitly enabled and CoinGecko is unreachable, GET /health/ready includes checks.coingecko: "down"', async () => {
    const failingCoingecko = { ping: vi.fn(async () => Promise.reject(new Error('unreachable'))) };
    const app = createApp({
      readinessChecks: [
        createMongoReadinessCheck(),
        createCoinGeckoReadinessCheck(failingCoingecko),
      ],
    });

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body.checks.coingecko).toBe('down');
  });
});

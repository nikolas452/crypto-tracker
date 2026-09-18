import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { clearDatabase, startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';

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

  // E0-1: GET /health returns 200 with status ok, uptimeSeconds and X-Request-Id.
  it('E0-1: GET /health returns liveness status without checking dependencies', async () => {
    const app = createApp();

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(typeof response.body.uptimeSeconds).toBe('number');
    expect(response.headers['x-request-id']).toBeDefined();
  });

  // E0-2: GET /health/ready returns 200 with checks.mongo: "up" when connected.
  it('E0-2: GET /health/ready returns ready when Mongo is connected', async () => {
    const app = createApp();

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ready');
    expect(response.body.checks.mongo).toBe('up');
  });

  // E0-3: with Mongo disconnected, GET /health/ready returns 503 with status not_ready.
  // Runs last among the Mongo-dependent checks: it disconnects Mongoose within the
  // test on purpose and does not reconnect, per the scenario ("desconectar Mongoose
  // dentro del test"). The remaining tests below only exercise /health (liveness),
  // which never touches the database.
  it('E0-3: GET /health/ready returns 503 when Mongo is disconnected', async () => {
    const app = createApp();

    await mongoose.connection.close();

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body.status).toBe('not_ready');
    expect(response.body.checks.mongo).toBe('down');
  });

  // E0-4: sending X-Request-Id echoes the same value back.
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

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { logger } from '../../src/lib/logger.js';
import { startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';

describe('error handling (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 120000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // E0-5: unknown route returns the standard 404.
  it('E0-5: GET /no-existe returns 404 with the global error format', async () => {
    const app = createApp();

    const response = await request(app).get('/no-existe');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.error.requestId).toBeDefined();
    expect(response.body.error.message).toContain('GET');
    expect(response.body.error.message).toContain('/no-existe');
  });

  // E0-6: an unexpected error hides the stack in the response outside
  // development (the suite runs with NODE_ENV=test), but the full error
  // (with stack) is still logged via the shared logger.
  it('E0-6: an unexpected thrown error maps to 500 INTERNAL_ERROR without a stack in the response, logged with stack', async () => {
    const errorSpy = vi.spyOn(logger, 'error');
    const app = createApp({
      registerTestRoutes: (testApp) => {
        testApp.get('/__boom', () => {
          throw new Error('boom');
        });
      },
    });

    const response = await request(app).get('/__boom');

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('INTERNAL_ERROR');
    expect(response.body.error.details).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain('boom');

    expect(errorSpy).toHaveBeenCalled();
    const [loggedPayload] = errorSpy.mock.calls[0] as [{ err?: Error }];
    expect(loggedPayload.err?.stack).toContain('boom');
  });

  // E0-7: malformed JSON body returns 400 VALIDATION_ERROR.
  it('E0-7: malformed JSON body returns 400 VALIDATION_ERROR', async () => {
    const app = createApp();

    const response = await request(app)
      .post('/health')
      .set('Content-Type', 'application/json')
      .send('{"invalid": json}');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});

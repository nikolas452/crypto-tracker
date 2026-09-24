import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type { NextFunction, Request, Response } from 'express';
import { createErrorHandler } from '../../src/middlewares/errorHandler.js';
import { NotFoundError, ValidationError } from '../../src/lib/errors.js';

/**
 * Tests unitarios del middleware `createErrorHandler` de
 * `src/middlewares/errorHandler.ts`.
 */

interface FakeResponse {
  headersSent: boolean;
  statusCode: number;
  body: unknown;
  status(code: number): FakeResponse;
  json(body: unknown): FakeResponse;
}

function createFakeLogger(): Logger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    fatal: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  } as unknown as Logger;
}

function createFakeReq(id = 'req-1'): Request {
  return { id } as unknown as Request;
}

function createFakeRes(): FakeResponse {
  const res: FakeResponse = {
    headersSent: false,
    statusCode: 0,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}

function getErrorBody(res: FakeResponse): {
  error: { code: string; message: string; requestId: string; details?: unknown };
} {
  return res.body as {
    error: { code: string; message: string; requestId: string; details?: unknown };
  };
}

describe('createErrorHandler', () => {
  it('maps AppError derivatives to their fixed status and code', () => {
    const handler = createErrorHandler(createFakeLogger(), 'production');
    const req = createFakeReq();
    const res = createFakeRes();

    handler(new NotFoundError('no existe'), req, res as unknown as Response, vi.fn());

    expect(res.statusCode).toBe(404);
    expect(getErrorBody(res).error.code).toBe('NOT_FOUND');
    expect(getErrorBody(res).error.requestId).toBe('req-1');
  });

  it('maps a generic Error to 500 INTERNAL_ERROR', () => {
    const handler = createErrorHandler(createFakeLogger(), 'production');
    const req = createFakeReq();
    const res = createFakeRes();

    handler(new Error('unexpected'), req, res as unknown as Response, vi.fn());

    expect(res.statusCode).toBe(500);
    expect(getErrorBody(res).error.code).toBe('INTERNAL_ERROR');
  });

  it('hides the stack (and any details) for an unexpected error in production', () => {
    const handler = createErrorHandler(createFakeLogger(), 'production');
    const req = createFakeReq();
    const res = createFakeRes();

    handler(new Error('unexpected'), req, res as unknown as Response, vi.fn());

    expect(getErrorBody(res).error.details).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('unexpected');
  });

  it('includes details.stack for an unexpected error in development', () => {
    const handler = createErrorHandler(createFakeLogger(), 'development');
    const req = createFakeReq();
    const res = createFakeRes();

    handler(new Error('unexpected'), req, res as unknown as Response, vi.fn());

    const details = getErrorBody(res).error.details as { stack?: string } | undefined;
    expect(details?.stack).toBeDefined();
  });

  it('maps a Mongoose CastError to 400 VALIDATION_ERROR', () => {
    const handler = createErrorHandler(createFakeLogger(), 'production');
    const req = createFakeReq();
    const res = createFakeRes();
    const castError = new Error('Cast failed');
    castError.name = 'CastError';

    handler(castError, req, res as unknown as Response, vi.fn());

    expect(res.statusCode).toBe(400);
    expect(getErrorBody(res).error.code).toBe('VALIDATION_ERROR');
  });

  it('maps a malformed-JSON body-parser error to 400 VALIDATION_ERROR', () => {
    const handler = createErrorHandler(createFakeLogger(), 'production');
    const req = createFakeReq();
    const res = createFakeRes();
    const parseError = Object.assign(new SyntaxError('Unexpected token'), {
      type: 'entity.parse.failed',
    });

    handler(parseError, req, res as unknown as Response, vi.fn());

    expect(res.statusCode).toBe(400);
    expect(getErrorBody(res).error.code).toBe('VALIDATION_ERROR');
    expect(getErrorBody(res).error.message).toBe('JSON inválido');
  });

  it('maps an oversized-body error to 413 VALIDATION_ERROR', () => {
    const handler = createErrorHandler(createFakeLogger(), 'production');
    const req = createFakeReq();
    const res = createFakeRes();
    const tooLargeError = Object.assign(new Error('too large'), {
      type: 'entity.too.large',
    });

    handler(tooLargeError, req, res as unknown as Response, vi.fn());

    expect(res.statusCode).toBe(413);
    expect(getErrorBody(res).error.code).toBe('VALIDATION_ERROR');
  });

  it('delegates to next(err) when headers were already sent', () => {
    const handler = createErrorHandler(createFakeLogger(), 'production');
    const req = createFakeReq();
    const res = createFakeRes();
    res.headersSent = true;
    const next = vi.fn() as unknown as NextFunction;
    const err = new Error('too late');

    handler(err, req, res as unknown as Response, next);

    expect(next).toHaveBeenCalledWith(err);
    expect(res.body).toBeUndefined();
  });

  it.each([
    [new ValidationError(), 400, 'VALIDATION_ERROR'],
    [new NotFoundError(), 404, 'NOT_FOUND'],
  ] as const)('propagates the requestId through for %#', (err, status, code) => {
    const handler = createErrorHandler(createFakeLogger(), 'production');
    const req = createFakeReq('some-id');
    const res = createFakeRes();

    handler(err, req, res as unknown as Response, vi.fn());

    expect(res.statusCode).toBe(status);
    expect(getErrorBody(res).error.code).toBe(code);
    expect(getErrorBody(res).error.requestId).toBe('some-id');
  });
});

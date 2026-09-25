import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AppError,
  ConflictError,
  FirebaseUnavailableError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  RateLimitedError,
  ServiceUnavailableError,
  TokenExpiredError,
  TokenRevokedError,
  UnauthenticatedError,
  UnprocessableError,
  UpstreamError,
  UserDisabledError,
  ValidationError,
  validate,
} from '../../src/lib/errors.js';

/**
 * Tests unitarios de la jerarquía `AppError` y del helper `validate()` de
 * `src/lib/errors.ts`.
 */

describe('AppError hierarchy', () => {
  it.each([
    [ValidationError, 400, 'VALIDATION_ERROR'],
    [UnauthenticatedError, 401, 'UNAUTHENTICATED'],
    [TokenExpiredError, 401, 'TOKEN_EXPIRED'],
    [TokenRevokedError, 401, 'TOKEN_REVOKED'],
    [ForbiddenError, 403, 'FORBIDDEN'],
    [UserDisabledError, 403, 'USER_DISABLED'],
    [NotFoundError, 404, 'NOT_FOUND'],
    [ConflictError, 409, 'CONFLICT'],
    [UnprocessableError, 422, 'UNPROCESSABLE'],
    [RateLimitedError, 429, 'RATE_LIMITED'],
    [UpstreamError, 502, 'UPSTREAM_ERROR'],
    [FirebaseUnavailableError, 502, 'FIREBASE_UNAVAILABLE'],
    [ServiceUnavailableError, 503, 'SERVICE_UNAVAILABLE'],
    [InternalError, 500, 'INTERNAL_ERROR'],
  ] as const)('%s maps to status %d and code %s', (ErrorClass, status, code) => {
    const error = new ErrorClass();

    expect(error).toBeInstanceOf(AppError);
    expect(error.httpStatus).toBe(status);
    expect(error.code).toBe(code);
  });

  it('carries optional details and cause', () => {
    const cause = new Error('root cause');
    const error = new ValidationError('bad input', {
      details: [{ path: 'body.name', message: 'Required' }],
      cause,
    });

    expect(error.details).toEqual([{ path: 'body.name', message: 'Required' }]);
    expect(error.cause).toBe(cause);
  });
});

describe('validate()', () => {
  const schema = z.object({ limit: z.number().max(100) });

  it('returns parsed data on success', () => {
    const result = validate(schema, { limit: 20 }, 'query');
    expect(result).toEqual({ limit: 20 });
  });

  it('throws ValidationError with details prefixed by the given source', () => {
    try {
      validate(schema, { limit: 500 }, 'query');
      expect.unreachable('validate should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const validationError = error as ValidationError;
      expect(validationError.details).toBeDefined();
      expect(validationError.details?.[0]?.path).toBe('query.limit');
    }
  });

  it('prefixes with body. and params. for other sources', () => {
    try {
      validate(schema, { limit: 500 }, 'body');
      expect.unreachable('validate should have thrown');
    } catch (error) {
      const validationError = error as ValidationError;
      expect(validationError.details?.[0]?.path).toBe('body.limit');
    }

    try {
      validate(schema, { limit: 500 }, 'params');
      expect.unreachable('validate should have thrown');
    } catch (error) {
      const validationError = error as ValidationError;
      expect(validationError.details?.[0]?.path).toBe('params.limit');
    }
  });
});

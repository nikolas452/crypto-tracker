import type { ZodType } from 'zod';

/**
 * Fixed error-code table (see `requerimientos/00-indice-y-convenciones.md`,
 * section 5.2). Every `AppError` derivative maps 1:1 to one of these codes
 * and its corresponding HTTP status.
 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'TOKEN_EXPIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNPROCESSABLE'
  | 'RATE_LIMITED'
  | 'UPSTREAM_ERROR'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export interface ErrorDetail {
  readonly path: string;
  readonly message: string;
}

export interface AppErrorOptions {
  readonly details?: readonly ErrorDetail[];
  readonly cause?: unknown;
}

/**
 * Base class for every known, well-shaped application error. The centralized
 * error handler uses `instanceof AppError` as its single decision point for
 * "is this a known error, or an unexpected one".
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: readonly ErrorDetail[];

  constructor(code: ErrorCode, httpStatus: number, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = this.constructor.name;
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = options.details;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Datos inválidos', options: AppErrorOptions = {}) {
    super('VALIDATION_ERROR', 400, message, options);
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'No autenticado', options: AppErrorOptions = {}) {
    super('UNAUTHENTICATED', 401, message, options);
  }
}

export class TokenExpiredError extends AppError {
  constructor(message = 'Token vencido', options: AppErrorOptions = {}) {
    super('TOKEN_EXPIRED', 401, message, options);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'No tiene permiso', options: AppErrorOptions = {}) {
    super('FORBIDDEN', 403, message, options);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Recurso no encontrado', options: AppErrorOptions = {}) {
    super('NOT_FOUND', 404, message, options);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflicto con el estado actual', options: AppErrorOptions = {}) {
    super('CONFLICT', 409, message, options);
  }
}

export class UnprocessableError extends AppError {
  constructor(message = 'Petición no procesable', options: AppErrorOptions = {}) {
    super('UNPROCESSABLE', 422, message, options);
  }
}

export class RateLimitedError extends AppError {
  constructor(message = 'Límite de peticiones superado', options: AppErrorOptions = {}) {
    super('RATE_LIMITED', 429, message, options);
  }
}

export class UpstreamError extends AppError {
  constructor(message = 'Falló un servicio externo', options: AppErrorOptions = {}) {
    super('UPSTREAM_ERROR', 502, message, options);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'Servicio no disponible', options: AppErrorOptions = {}) {
    super('SERVICE_UNAVAILABLE', 503, message, options);
  }
}

export class InternalError extends AppError {
  constructor(message = 'Error interno', options: AppErrorOptions = {}) {
    super('INTERNAL_ERROR', 500, message, options);
  }
}

export type ValidationSource = 'body' | 'query' | 'params';

/**
 * Runs `schema` against `data`; on failure throws a {@link ValidationError}
 * whose `details` are built from the Zod issues, each `path` prefixed with
 * `source` (e.g. `query.limit`).
 */
export function validate<T>(schema: ZodType<T>, data: unknown, source: ValidationSource): T {
  const result = schema.safeParse(data);

  if (!result.success) {
    const details: ErrorDetail[] = result.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? `${source}.${issue.path.join('.')}` : source,
      message: issue.message,
    }));
    throw new ValidationError('Datos inválidos', { details });
  }

  return result.data;
}

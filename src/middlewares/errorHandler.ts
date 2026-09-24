import type { NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';
import { AppError, type ErrorCode, type ErrorDetail } from '../lib/errors.js';
import { config, type Config } from '../config/env.js';
import { readRequestId } from './requestId.js';

interface BodyParserLikeError extends Error {
  type?: string;
  status?: number;
  statusCode?: number;
}

function isBodyParserError(err: unknown): err is BodyParserLikeError {
  return err instanceof Error && typeof (err as BodyParserLikeError).type === 'string';
}

function isMongooseCastError(err: unknown): err is Error {
  return err instanceof Error && err.name === 'CastError';
}

function logByStatus(logger: Logger, status: number, requestId: string, err: unknown): void {
  const payload = { requestId, err };
  if (status >= 500) {
    logger.error(payload, 'Request failed');
  } else if (status >= 400) {
    logger.warn(payload, 'Request failed');
  } else {
    logger.info(payload, 'Request failed');
  }
}

function sendError(
  res: Response,
  status: number,
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: readonly ErrorDetail[] | { stack?: string },
): void {
  res.status(status).json({
    error: {
      code,
      message,
      requestId,
      ...(details !== undefined ? { details } : {}),
    },
  });
}

/**
 * Middleware único y centralizado de manejo de errores (se registra al
 * final). Mapea cualquier error lanzado en la cadena a la forma global del
 * proyecto `{ error: { code, message, details?, requestId } }`.
 *
 * `nodeEnv` toma por defecto `config.NODE_ENV` pero se puede sobrescribir,
 * lo que permite que los tests unitarios ejerciten tanto la rama
 * `development` (con stack incluido) como la `production` (con stack
 * oculto) sin necesitar un segundo proceso.
 */
export function createErrorHandler(logger: Logger, nodeEnv: Config['NODE_ENV'] = config.NODE_ENV) {
  return function errorHandler(
    err: unknown,
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    if (res.headersSent) {
      next(err);
      return;
    }

    const requestId = readRequestId(req);

    if (isBodyParserError(err) && err.type === 'entity.parse.failed') {
      logByStatus(logger, 400, requestId, err);
      sendError(res, 400, 'VALIDATION_ERROR', 'JSON inválido', requestId);
      return;
    }

    if (isBodyParserError(err) && err.type === 'entity.too.large') {
      logByStatus(logger, 413, requestId, err);
      sendError(res, 413, 'VALIDATION_ERROR', 'JSON inválido', requestId);
      return;
    }

    if (isMongooseCastError(err)) {
      logByStatus(logger, 400, requestId, err);
      sendError(res, 400, 'VALIDATION_ERROR', 'Identificador inválido', requestId);
      return;
    }

    if (err instanceof AppError) {
      logByStatus(logger, err.httpStatus, requestId, err);
      sendError(res, err.httpStatus, err.code, err.message, requestId, err.details);
      return;
    }

    const unexpected = err instanceof Error ? err : new Error('Unknown error', { cause: err });
    logger.error({ requestId, err: unexpected, cause: unexpected.cause }, 'Unhandled error');

    const details = nodeEnv === 'development' ? { stack: unexpected.stack } : undefined;
    sendError(res, 500, 'INTERNAL_ERROR', 'Error interno', requestId, details);
  };
}

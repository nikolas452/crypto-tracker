import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';
import { readRequestId } from './requestId.js';

/**
 * Request logging middleware built on `pino-http`, reusing the id already
 * assigned by the `requestId` middleware (mounted before this one). Logs
 * method, route, status and duration; never logs bodies or headers.
 */
export function createRequestLogger(logger: Logger) {
  return pinoHttp({
    logger,
    genReqId: (req) => readRequestId(req),
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    serializers: {
      req: (req) => ({ method: req.method, url: req.url }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
  });
}

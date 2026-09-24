import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';
import { readRequestId } from './requestId.js';

/**
 * Middleware de logging de requests construido sobre `pino-http`, que
 * reutiliza el id ya asignado por el middleware `requestId` (montado antes
 * que este). Loguea método, ruta, status y duración; nunca loguea bodies ni
 * headers.
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

import pino from 'pino';
import { config } from '../config/env.js';

/**
 * Instancia compartida de pino usada en toda la aplicación, con las rutas
 * sensibles redactadas antes de serializar cualquier línea de log.
 */

/**
 * Rutas que pino redacta antes de serializar cualquier línea de log. Cubre
 * tokens, API keys, contraseñas, el header `Authorization` (en cualquier
 * variante de mayúsculas/minúsculas que Express/Node normalice a minúsculas)
 * y la cadena de conexión completa de Mongo, dondequiera que puedan aparecer
 * en un objeto logueado.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'headers.authorization',
  '*.authorization',
  '*.password',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.apiKey',
  '*.api_key',
  '*.MONGODB_URI',
  '*.mongoUri',
  '*.uri',
  '*.secret',
  '*.COINGECKO_API_KEY',
  '*.coingeckoApiKey',
  'req.headers["x-cg-demo-api-key"]',
  'headers["x-cg-demo-api-key"]',
  '*.headers["x-cg-demo-api-key"]',
];

export const logger = pino({
  level: config.LOG_LEVEL,
  base: undefined,
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
  },
  transport:
    config.NODE_ENV === 'development'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
});

import pino from 'pino';
import { config } from '../config/env.js';

/**
 * Paths pino redacts before any log line is serialized. Covers tokens, API
 * keys, passwords, the `Authorization` header (in any casing Express/Node
 * normalizes to lowercase) and the full Mongo connection string, wherever
 * they might appear on a logged object.
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

import { describe, expect, it, vi } from 'vitest';
import { assertCoinGeckoApiKey, EnvValidationError, parseEnv } from '../../src/config/env.js';

/** Tests unitarios de `parseEnv` y `assertCoinGeckoApiKey` de `src/config/env.ts`. */

describe('parseEnv', () => {
  it('returns a fully-typed config with defaults applied for a valid source', () => {
    const config = parseEnv({ MONGODB_URI: 'mongodb://localhost:27017' });

    expect(config).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      MONGODB_URI: 'mongodb://localhost:27017',
      MONGODB_DB_NAME: 'crypto_tracker',
      LOG_LEVEL: 'info',
      SHUTDOWN_TIMEOUT_MS: 10000,
      COINGECKO_BASE_URL: 'https://api.coingecko.com/api/v3',
      COINGECKO_TIMEOUT_MS: 10000,
      COINGECKO_MAX_RETRIES: 2,
      COINGECKO_MAX_IDS_PER_CALL: 50,
      POLL_PRICES_CRON: '*/10 * * * *',
      POLL_PRICES_RUN_ON_START: true,
      SNAPSHOT_RETENTION_DAYS: 90,
      JOB_RUNS_RETENTION_DAYS: 30,
      STALE_RUN_THRESHOLD_MIN: 15,
      WORKER_SHUTDOWN_TIMEOUT_MS: 30000,
      TRUST_PROXY: 0,
      RATE_LIMIT_MAX: 300,
      RATE_LIMIT_WINDOW_MIN: 15,
      STALE_POLL_THRESHOLD_MIN: 30,
    });
  });

  it('returns a frozen object', () => {
    const config = parseEnv({ MONGODB_URI: 'mongodb://localhost:27017' });

    expect(Object.isFrozen(config)).toBe(true);
    expect(() => {
      // @ts-expect-error intento de mutación deliberado sobre una config de solo lectura
      config.PORT = 9999;
    }).toThrow();
  });

  it('accepts mongodb+srv:// URIs', () => {
    const config = parseEnv({ MONGODB_URI: 'mongodb+srv://user:pass@cluster.mongodb.net' });

    expect(config.MONGODB_URI).toBe('mongodb+srv://user:pass@cluster.mongodb.net');
  });

  it('throws EnvValidationError when MONGODB_URI is missing', () => {
    expect(() => parseEnv({})).toThrow(EnvValidationError);

    try {
      parseEnv({});
      expect.unreachable('parseEnv should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const envError = error as EnvValidationError;
      expect(envError.issues.some((issue) => issue.variable === 'MONGODB_URI')).toBe(true);
    }
  });

  it('throws EnvValidationError when MONGODB_URI has an invalid scheme', () => {
    expect(() => parseEnv({ MONGODB_URI: 'postgres://localhost/db' })).toThrow(EnvValidationError);
  });

  it('throws EnvValidationError when PORT is not numeric', () => {
    try {
      parseEnv({ MONGODB_URI: 'mongodb://localhost:27017', PORT: 'not-a-number' });
      expect.unreachable('parseEnv should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const envError = error as EnvValidationError;
      expect(envError.issues.some((issue) => issue.variable === 'PORT')).toBe(true);
    }
  });

  it('throws EnvValidationError when NODE_ENV is invalid', () => {
    try {
      parseEnv({ MONGODB_URI: 'mongodb://localhost:27017', NODE_ENV: 'staging' });
      expect.unreachable('parseEnv should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const envError = error as EnvValidationError;
      expect(envError.issues.some((issue) => issue.variable === 'NODE_ENV')).toBe(true);
    }
  });

  it('never includes offending values in the thrown issues', () => {
    try {
      parseEnv({ MONGODB_URI: 'super-secret-invalid-uri', PORT: 'garbage-value' });
      expect.unreachable('parseEnv should have thrown');
    } catch (error) {
      const envError = error as EnvValidationError;
      const serialized = JSON.stringify(envError.issues);
      expect(serialized).not.toContain('super-secret-invalid-uri');
      expect(serialized).not.toContain('garbage-value');
    }
  });

  it('applies documented defaults for all optional variables', () => {
    const config = parseEnv({ MONGODB_URI: 'mongodb://localhost:27017' });

    expect(config.NODE_ENV).toBe('development');
    expect(config.PORT).toBe(3000);
    expect(config.MONGODB_DB_NAME).toBe('crypto_tracker');
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.SHUTDOWN_TIMEOUT_MS).toBe(10000);
  });

  it('coerces numeric strings for PORT and SHUTDOWN_TIMEOUT_MS', () => {
    const config = parseEnv({
      MONGODB_URI: 'mongodb://localhost:27017',
      PORT: '4000',
      SHUTDOWN_TIMEOUT_MS: '5000',
    });

    expect(config.PORT).toBe(4000);
    expect(config.SHUTDOWN_TIMEOUT_MS).toBe(5000);
  });

  it('rejects a SHUTDOWN_TIMEOUT_MS below 1000', () => {
    expect(() =>
      parseEnv({ MONGODB_URI: 'mongodb://localhost:27017', SHUTDOWN_TIMEOUT_MS: '500' }),
    ).toThrow(EnvValidationError);
  });

  it('rejects an empty MONGODB_DB_NAME', () => {
    expect(() =>
      parseEnv({ MONGODB_URI: 'mongodb://localhost:27017', MONGODB_DB_NAME: '' }),
    ).toThrow(EnvValidationError);
  });

  it('leaves COINGECKO_API_KEY undefined when not provided', () => {
    const config = parseEnv({ MONGODB_URI: 'mongodb://localhost:27017' });

    expect(config.COINGECKO_API_KEY).toBeUndefined();
  });

  it('accepts a COINGECKO_API_KEY when provided', () => {
    const config = parseEnv({
      MONGODB_URI: 'mongodb://localhost:27017',
      COINGECKO_API_KEY: 'demo-key',
    });

    expect(config.COINGECKO_API_KEY).toBe('demo-key');
  });

  it('parses POLL_PRICES_RUN_ON_START as a boolean', () => {
    const config = parseEnv({
      MONGODB_URI: 'mongodb://localhost:27017',
      POLL_PRICES_RUN_ON_START: 'false',
    });

    expect(config.POLL_PRICES_RUN_ON_START).toBe(false);
  });

  it('defaults SNAPSHOT_RETENTION_DAYS to 90 when unset', () => {
    const config = parseEnv({ MONGODB_URI: 'mongodb://localhost:27017' });

    expect(config.SNAPSHOT_RETENTION_DAYS).toBe(90);
  });

  it('treats an empty SNAPSHOT_RETENTION_DAYS as no expiration (null)', () => {
    const config = parseEnv({
      MONGODB_URI: 'mongodb://localhost:27017',
      SNAPSHOT_RETENTION_DAYS: '',
    });

    expect(config.SNAPSHOT_RETENTION_DAYS).toBeNull();
  });

  it('coerces a numeric SNAPSHOT_RETENTION_DAYS string', () => {
    const config = parseEnv({
      MONGODB_URI: 'mongodb://localhost:27017',
      SNAPSHOT_RETENTION_DAYS: '30',
    });

    expect(config.SNAPSHOT_RETENTION_DAYS).toBe(30);
  });

  it('rejects a COINGECKO_MAX_RETRIES outside 0-5', () => {
    expect(() =>
      parseEnv({ MONGODB_URI: 'mongodb://localhost:27017', COINGECKO_MAX_RETRIES: '6' }),
    ).toThrow(EnvValidationError);
  });

  it('rejects a COINGECKO_MAX_IDS_PER_CALL outside 1-250', () => {
    expect(() =>
      parseEnv({ MONGODB_URI: 'mongodb://localhost:27017', COINGECKO_MAX_IDS_PER_CALL: '0' }),
    ).toThrow(EnvValidationError);
  });

  it('defaults TRUST_PROXY to 0 in development', () => {
    const config = parseEnv({ MONGODB_URI: 'mongodb://localhost:27017' });

    expect(config.TRUST_PROXY).toBe(0);
  });

  it('defaults TRUST_PROXY to 1 in production', () => {
    const config = parseEnv({ MONGODB_URI: 'mongodb://localhost:27017', NODE_ENV: 'production' });

    expect(config.TRUST_PROXY).toBe(1);
  });

  it('honors an explicit TRUST_PROXY over the NODE_ENV-derived default', () => {
    const config = parseEnv({
      MONGODB_URI: 'mongodb://localhost:27017',
      NODE_ENV: 'production',
      TRUST_PROXY: '2',
    });

    expect(config.TRUST_PROXY).toBe(2);
  });

  it('defaults RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MIN and STALE_POLL_THRESHOLD_MIN', () => {
    const config = parseEnv({ MONGODB_URI: 'mongodb://localhost:27017' });

    expect(config.RATE_LIMIT_MAX).toBe(300);
    expect(config.RATE_LIMIT_WINDOW_MIN).toBe(15);
    expect(config.STALE_POLL_THRESHOLD_MIN).toBe(30);
  });

  it('leaves ADMIN_API_KEY undefined when not provided', () => {
    const config = parseEnv({ MONGODB_URI: 'mongodb://localhost:27017' });

    expect(config.ADMIN_API_KEY).toBeUndefined();
  });

  it('accepts an ADMIN_API_KEY of at least 32 characters', () => {
    const config = parseEnv({
      MONGODB_URI: 'mongodb://localhost:27017',
      ADMIN_API_KEY: 'a'.repeat(32),
    });

    expect(config.ADMIN_API_KEY).toBe('a'.repeat(32));
  });

  it('rejects an ADMIN_API_KEY shorter than 32 characters', () => {
    expect(() =>
      parseEnv({ MONGODB_URI: 'mongodb://localhost:27017', ADMIN_API_KEY: 'too-short' }),
    ).toThrow(EnvValidationError);
  });
});

describe('assertCoinGeckoApiKey', () => {
  it('does not exit when COINGECKO_API_KEY is present', () => {
    const config = parseEnv({
      MONGODB_URI: 'mongodb://localhost:27017',
      COINGECKO_API_KEY: 'demo-key',
    });
    const logger = { fatal: vi.fn() };
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    assertCoinGeckoApiKey(config, logger);

    expect(logger.fatal).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('logs fatal and exits with code 1 when COINGECKO_API_KEY is missing', () => {
    const config = parseEnv({ MONGODB_URI: 'mongodb://localhost:27017' });
    const logger = { fatal: vi.fn() };
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    assertCoinGeckoApiKey(config, logger);

    expect(logger.fatal).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

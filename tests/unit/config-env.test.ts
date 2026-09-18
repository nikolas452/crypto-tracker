import { describe, expect, it } from 'vitest';
import { EnvValidationError, parseEnv } from '../../src/config/env.js';

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
    });
  });

  it('returns a frozen object', () => {
    const config = parseEnv({ MONGODB_URI: 'mongodb://localhost:27017' });

    expect(Object.isFrozen(config)).toBe(true);
    expect(() => {
      // @ts-expect-error intentional mutation attempt on a readonly config
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
});

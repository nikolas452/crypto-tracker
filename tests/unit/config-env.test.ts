import { describe, expect, it, vi } from 'vitest';
import {
  assertCoinGeckoApiKey,
  assertFirebaseCredentials,
  assertSmtpCredentials,
  EnvValidationError,
  parseEnv,
} from '../../src/config/env.js';
import { CONSTANTS } from '../../src/config/constants.js';

/** Tests unitarios de `parseEnv` y de las guardas `assert*` de `src/config/env.ts` (secretos, overrides de despliegue y constantes). */

describe('parseEnv', () => {
  it('merges the constants with the validated secrets and applies the derived TRUST_PROXY', () => {
    const config = parseEnv({ MONGODB_URI: 'mongodb://localhost:27017' });

    expect(config).toEqual({
      ...CONSTANTS,
      MONGODB_URI: 'mongodb://localhost:27017',
      TRUST_PROXY: 0,
    });
  });

  it('keeps the documented development defaults for the deployment overrides', () => {
    const config = parseEnv({ MONGODB_URI: 'mongodb://localhost:27017' });

    expect(config.NODE_ENV).toBe('development');
    expect(config.PORT).toBe(3000);
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.SMTP_HOST).toBe('localhost');
    expect(config.SMTP_PORT).toBe(1025);
    expect(config.MAIL_FROM).toBe('alerts@crypto-tracker.local');
    expect(config.FIREBASE_AUTH_EMULATOR_HOST).toBeUndefined();
  });

  it('exposes SNAPSHOT_RETENTION_DAYS as a number and COINGECKO_READINESS_ENABLED as a boolean', () => {
    const config = parseEnv({ MONGODB_URI: 'mongodb://localhost:27017' });

    expect(config.SNAPSHOT_RETENTION_DAYS).toBe(90);
    expect(config.COINGECKO_READINESS_ENABLED).toBe(false);
    expect(config.POLL_PRICES_RUN_ON_START).toBe(true);
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

  it('coerces and applies the PORT and SMTP_PORT overrides', () => {
    const config = parseEnv({
      MONGODB_URI: 'mongodb://localhost:27017',
      PORT: '4000',
      SMTP_PORT: '587',
    });

    expect(config.PORT).toBe(4000);
    expect(config.SMTP_PORT).toBe(587);
  });

  it('applies the SMTP_HOST, MAIL_FROM and LOG_LEVEL overrides', () => {
    const config = parseEnv({
      MONGODB_URI: 'mongodb://localhost:27017',
      SMTP_HOST: 'smtp.example.test',
      MAIL_FROM: 'alerts@example.test',
      LOG_LEVEL: 'silent',
    });

    expect(config.SMTP_HOST).toBe('smtp.example.test');
    expect(config.MAIL_FROM).toBe('alerts@example.test');
    expect(config.LOG_LEVEL).toBe('silent');
  });

  it('does not let an explicitly undefined override wipe the constant default', () => {
    const config = parseEnv({ MONGODB_URI: 'mongodb://localhost:27017', PORT: undefined });

    expect(config.PORT).toBe(3000);
  });

  it('rejects an out-of-range SMTP_PORT and an invalid LOG_LEVEL', () => {
    expect(() =>
      parseEnv({ MONGODB_URI: 'mongodb://localhost:27017', SMTP_PORT: '70000' }),
    ).toThrow(EnvValidationError);
    expect(() =>
      parseEnv({ MONGODB_URI: 'mongodb://localhost:27017', LOG_LEVEL: 'verbose' }),
    ).toThrow(EnvValidationError);
  });

  it('ignores environment variables that are now constants', () => {
    const config = parseEnv({
      MONGODB_URI: 'mongodb://localhost:27017',
      RATE_LIMIT_MAX: '1',
      SHUTDOWN_TIMEOUT_MS: '5000',
      MONGODB_DB_NAME: 'other_db',
      SNAPSHOT_RETENTION_DAYS: '',
    });

    expect(config.RATE_LIMIT_MAX).toBe(CONSTANTS.RATE_LIMIT_MAX);
    expect(config.SHUTDOWN_TIMEOUT_MS).toBe(CONSTANTS.SHUTDOWN_TIMEOUT_MS);
    expect(config.MONGODB_DB_NAME).toBe(CONSTANTS.MONGODB_DB_NAME);
    expect(config.SNAPSHOT_RETENTION_DAYS).toBe(CONSTANTS.SNAPSHOT_RETENTION_DAYS);
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

  it('leaves the Firebase and SMTP credentials undefined when not provided', () => {
    const config = parseEnv({ MONGODB_URI: 'mongodb://localhost:27017' });

    expect(config.FIREBASE_PROJECT_ID).toBeUndefined();
    expect(config.FIREBASE_CLIENT_EMAIL).toBeUndefined();
    expect(config.FIREBASE_PRIVATE_KEY).toBeUndefined();
    expect(config.FIREBASE_WEB_API_KEY).toBeUndefined();
    expect(config.FIREBASE_AUTH_EMULATOR_HOST).toBeUndefined();
    expect(config.SMTP_USER).toBeUndefined();
    expect(config.SMTP_PASS).toBeUndefined();
  });

  it('accepts the Firebase service-account variables when provided', () => {
    const config = parseEnv({
      MONGODB_URI: 'mongodb://localhost:27017',
      FIREBASE_PROJECT_ID: 'demo-project',
      FIREBASE_CLIENT_EMAIL: 'sa@demo-project.iam.gserviceaccount.com',
      FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
    });

    expect(config.FIREBASE_PROJECT_ID).toBe('demo-project');
    expect(config.FIREBASE_CLIENT_EMAIL).toBe('sa@demo-project.iam.gserviceaccount.com');
    expect(config.FIREBASE_PRIVATE_KEY).toContain('BEGIN PRIVATE KEY');
  });

  it('accepts SMTP_USER and SMTP_PASS when provided', () => {
    const config = parseEnv({
      MONGODB_URI: 'mongodb://localhost:27017',
      SMTP_USER: 'user',
      SMTP_PASS: 'pass',
    });

    expect(config.SMTP_USER).toBe('user');
    expect(config.SMTP_PASS).toBe('pass');
  });

  it('no longer parses ADMIN_API_KEY', () => {
    const config = parseEnv({
      MONGODB_URI: 'mongodb://localhost:27017',
      ADMIN_API_KEY: 'a'.repeat(32),
    });

    expect(config).not.toHaveProperty('ADMIN_API_KEY');
  });
});

describe('assertFirebaseCredentials', () => {
  it('does not exit when all three service-account variables are present', () => {
    const config = parseEnv({
      MONGODB_URI: 'mongodb://localhost:27017',
      FIREBASE_PROJECT_ID: 'demo-project',
      FIREBASE_CLIENT_EMAIL: 'sa@demo-project.iam.gserviceaccount.com',
      FIREBASE_PRIVATE_KEY: 'fake-key',
    });
    const logger = { fatal: vi.fn() };
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    assertFirebaseCredentials(config, logger);

    expect(logger.fatal).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('does not exit when no credentials are present but an emulator host is configured', () => {
    const config = parseEnv({
      MONGODB_URI: 'mongodb://localhost:27017',
      FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
    });
    const logger = { fatal: vi.fn() };
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    assertFirebaseCredentials(config, logger);

    expect(logger.fatal).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('logs fatal and exits with code 1 when credentials are missing and no emulator is configured', () => {
    const config = parseEnv({ MONGODB_URI: 'mongodb://localhost:27017' });
    const logger = { fatal: vi.fn() };
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    assertFirebaseCredentials(config, logger);

    expect(logger.fatal).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const [loggedPayload] = logger.fatal.mock.calls[0] as [{ invalidVariables: string[] }];
    expect(loggedPayload.invalidVariables).toEqual([
      'FIREBASE_PROJECT_ID',
      'FIREBASE_CLIENT_EMAIL',
      'FIREBASE_PRIVATE_KEY',
    ]);
    exitSpy.mockRestore();
  });

  it('never includes the private key value in the fatal log', () => {
    const config = parseEnv({
      MONGODB_URI: 'mongodb://localhost:27017',
      FIREBASE_PROJECT_ID: 'demo-project',
    });
    const logger = { fatal: vi.fn() };
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    assertFirebaseCredentials(config, logger);

    const serialized = JSON.stringify(logger.fatal.mock.calls);
    expect(serialized).not.toContain('fake-key');
    exitSpy.mockRestore();
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

describe('assertSmtpCredentials', () => {
  it('does not exit when SMTP_HOST and MAIL_FROM are both present', () => {
    const config = parseEnv({
      MONGODB_URI: 'mongodb://localhost:27017',
      SMTP_HOST: 'localhost',
      MAIL_FROM: 'alerts@example.test',
    });
    const logger = { fatal: vi.fn() };
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    assertSmtpCredentials(config, logger);

    expect(logger.fatal).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('logs fatal and exits with code 1 when SMTP_HOST and MAIL_FROM are both empty', () => {
    // Los defaults de CONSTANTS siempre los completan; se fuerzan vacíos a mano.
    const config = {
      ...parseEnv({ MONGODB_URI: 'mongodb://localhost:27017' }),
      SMTP_HOST: '',
      MAIL_FROM: '',
    };
    const logger = { fatal: vi.fn() };
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    assertSmtpCredentials(config, logger);

    expect(logger.fatal).toHaveBeenCalledTimes(1);
    expect(logger.fatal).toHaveBeenCalledWith(
      { invalidVariables: ['SMTP_HOST', 'MAIL_FROM'] },
      expect.any(String),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('logs fatal and exits with code 1 when only MAIL_FROM is empty', () => {
    const config = { ...parseEnv({ MONGODB_URI: 'mongodb://localhost:27017' }), MAIL_FROM: '' };
    const logger = { fatal: vi.fn() };
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    assertSmtpCredentials(config, logger);

    expect(logger.fatal).toHaveBeenCalledWith({ invalidVariables: ['MAIL_FROM'] }, expect.any(String));
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

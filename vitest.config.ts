import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    hookTimeout: 30000,
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
    },
    env: {
      NODE_ENV: 'test',
      PORT: '3000',
      MONGODB_URI: 'mongodb://127.0.0.1:27017/crypto_tracker_test_placeholder',
      MONGODB_DB_NAME: 'crypto_tracker_test',
      LOG_LEVEL: 'silent',
      SHUTDOWN_TIMEOUT_MS: '1000',
      MONGOMS_VERSION: '8.0.11',
    },
  },
});

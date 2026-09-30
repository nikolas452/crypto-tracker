// Configuración de Vitest: entorno de test, setup global y variables de entorno del proceso de tests.
import { defineConfig } from 'vitest/config';
import { MONGOMS_VERSION } from './tests/helpers/mongoBinaryVersion.js';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    // Descarga el binario de Mongo una sola vez antes de los workers — ver el comentario en el archivo.
    globalSetup: ['./tests/globalSetup.ts'],
    hookTimeout: 30000,
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
    },
    env: {
      // Solo overrides que siguen siendo variables de entorno; el resto son constantes.
      NODE_ENV: 'test',
      MONGODB_URI: 'mongodb://127.0.0.1:27017/crypto_tracker_test_placeholder',
      LOG_LEVEL: 'silent',
      MONGOMS_VERSION,
    },
  },
});

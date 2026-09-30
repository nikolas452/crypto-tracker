import { fileURLToPath } from 'node:url';
import { config } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { connectDb, disconnectDb } from '../db/connect.js';
import { ensureCollections } from '../db/ensureCollections.js';
import { setUserRoleByEmail } from '../modules/users/users.service.js';
import { parseSetRoleArgs } from './support/utils.js';

/**
 * Script `user:set-role` (spec auth-dev-scripts, tarea 9.3): busca el perfil
 * de `users` por email y le asigna `role`, imprimiendo la transición
 * anterior -> nueva. A diferencia de `auth:create-test-user`/`auth:token`,
 * este script no toca Firebase y sí tiene sentido en producción (es la única
 * forma de promover al primer admin — ver design.md, "Migration Plan"), así
 * que deliberadamente NO usa `assertNotProduction`.
 */
async function main(): Promise<void> {
  const args = parseSetRoleArgs(process.argv.slice(2));

  await connectDb(config.MONGODB_URI, config.MONGODB_DB_NAME, logger, {
    isProduction: config.NODE_ENV === 'production',
  });
  await ensureCollections(logger);

  const transition = await setUserRoleByEmail(args.email, args.role);

  if (!transition) {
    console.error(
      `user:set-role: no Mongo profile found for ${args.email}. ` +
        'The user must call any authenticated endpoint at least once with a valid Firebase ' +
        'ID token (which provisions their profile), or be created first with ' +
        '"npm run auth:create-test-user".',
    );
    await disconnectDb();
    process.exitCode = 1;
    return;
  }

  console.log(`Role for ${args.email}: ${transition.previousRole} -> ${transition.newRole}`);

  await disconnectDb();
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  main().catch((err: unknown) => {
    logger.fatal({ err }, 'user:set-role failed');
    process.exitCode = 1;
  });
}

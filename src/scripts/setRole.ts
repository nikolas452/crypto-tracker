import { fileURLToPath } from 'node:url';
import { config } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { connectDb, disconnectDb } from '../db/connect.js';
import { ensureCollections } from '../db/ensureCollections.js';
import { USER_ROLES, type UserRole } from '../modules/users/users.model.js';
import { setUserRoleByEmail } from '../modules/users/users.service.js';

/**
 * Script `user:set-role` (spec auth-dev-scripts, tarea 9.3): busca el perfil
 * de `users` por email y le asigna `role`, imprimiendo la transición
 * anterior -> nueva. A diferencia de `auth:create-test-user`/`auth:token`,
 * este script no toca Firebase y sí tiene sentido en producción (es la única
 * forma de promover al primer admin — ver design.md, "Migration Plan"), así
 * que deliberadamente NO usa `assertNotProduction`.
 */

export interface SetRoleArgs {
  readonly email: string;
  readonly role: UserRole;
}

const USAGE = `Usage: npm run user:set-role -- --email <email> --role <${USER_ROLES.join('|')}>`;

function isUserRole(value: string): value is UserRole {
  return (USER_ROLES as readonly string[]).includes(value);
}

/** Parsea `--email <email> --role <role>`. Lanza con un mensaje de uso ante una entrada inválida. */
export function parseArgs(argv: readonly string[]): SetRoleArgs {
  let email: string | undefined;
  let role: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--email') {
      i += 1;
      email = argv[i];
    } else if (arg === '--role') {
      i += 1;
      role = argv[i];
    }
  }

  if (!email || !role || !isUserRole(role)) {
    throw new Error(USAGE);
  }

  return { email, role };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

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

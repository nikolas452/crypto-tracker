import { fileURLToPath } from 'node:url';
import { getAuth } from 'firebase-admin/auth';
import { assertFirebaseCredentials, assertNotProduction, config } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { connectDb, disconnectDb } from '../db/connect.js';
import { ensureCollections } from '../db/ensureCollections.js';
import { initializeFirebaseAdmin } from '../integrations/firebase/admin.js';
import { resolveFromIdentity, setUserRoleByEmail } from '../modules/users/users.service.js';
import type { VerifiedIdentity } from '../integrations/firebase/tokenVerifier.js';
import { parseCreateTestUserArgs } from './support/utils.js';

/**
 * Script `auth:create-test-user` (spec auth-dev-scripts, tarea 9.1): crea un
 * usuario de Firebase con email/password y `emailVerified: true`, útil para
 * desarrollo local y para el flujo del emulador de Auth documentado en el
 * README (no hay frontend de registro en este proyecto). Con `--admin`
 * además provisiona su perfil de Mongo y lo promueve a `role: "admin"` en el
 * mismo paso, reutilizando `resolveFromIdentity` (el mismo camino de
 * aprovisionamiento just-in-time que recorre cualquier request autenticado
 * real) y `setUserRoleByEmail` (compartido con el script `user:set-role`) en
 * lugar de escribir el documento de `users` a mano.
 *
 * Se niega a correr en producción (tarea 9.4, `assertNotProduction`): un
 * script que crea cuentas con contraseñas conocidas no debe poder ejecutarse
 * contra un proyecto real.
 */

async function main(): Promise<void> {
  assertNotProduction(config, logger, 'auth:create-test-user');

  const args = parseCreateTestUserArgs(process.argv.slice(2));

  assertFirebaseCredentials(config, logger);
  const app = initializeFirebaseAdmin(config, logger);

  const userRecord = await getAuth(app).createUser({
    email: args.email,
    password: args.password,
    emailVerified: true,
  });

  console.log(`Created Firebase user: uid=${userRecord.uid} email=${args.email}`);

  if (args.admin) {
    await connectDb(config.MONGODB_URI, config.MONGODB_DB_NAME, logger, {
      isProduction: false,
    });
    await ensureCollections(logger);

    const identity: VerifiedIdentity = {
      uid: userRecord.uid,
      email: args.email,
      emailVerified: true,
      name: null,
    };
    // Aprovisiona el perfil (role: "user" por defecto, igual que un request
    // real) y a continuación lo promueve — así nunca duplicamos la lógica de
    // upsert de resolveFromIdentity solo para forzar un role distinto en la
    // inserción.
    await resolveFromIdentity(identity, new Date());
    const transition = await setUserRoleByEmail(args.email, 'admin');

    if (!transition) {
      throw new Error(
        `auth:create-test-user: Mongo profile for ${args.email} not found right after provisioning it`,
      );
    }

    console.log(`Mongo profile role: ${transition.previousRole} -> ${transition.newRole}`);

    await disconnectDb();
  }
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  main().catch((err: unknown) => {
    logger.fatal({ err }, 'auth:create-test-user failed');
    process.exitCode = 1;
  });
}

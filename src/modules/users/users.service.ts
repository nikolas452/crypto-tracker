import type { Types } from 'mongoose';
import { config, type Config } from '../../config/env.js';
import { logger as defaultLogger } from '../../lib/logger.js';
import { maskEmail } from '../../lib/maskEmail.js';
import { UserModel, type UserRole } from './users.model.js';
import type { VerifiedIdentity } from '../../integrations/firebase/tokenVerifier.js';

/**
 * Capa de servicio del módulo de usuarios: el aprovisionamiento just-in-time
 * y la sincronización de campos desde la identidad verificada de Firebase
 * (spec user-profile). `resolveFromIdentity` es el único punto de escritura
 * de `users`, y respeta el presupuesto de a lo sumo una lectura y una
 * escritura por request autenticado (RNF-3.5).
 */

/** Vista plana de un documento de `users`, la forma que consume el resto de la app (Fase B: `req.user`). */
export interface UserRecord {
  readonly id: string;
  readonly firebaseUid: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly displayName: string | null;
  readonly role: UserRole;
  readonly lastSeenAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Subconjunto lean de un documento de `users` del que lee este servicio. */
export interface UserLean {
  readonly _id: Types.ObjectId;
  readonly firebaseUid: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly displayName: string | null;
  readonly role: UserRole;
  readonly lastSeenAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SyncedFields {
  readonly email?: string | null;
  readonly emailVerified?: boolean;
  readonly lastSeenAt?: Date;
}

/**
 * Contrato de repositorio para `users`. Se inyecta en `resolveFromIdentity`
 * (por defecto, la implementación real respaldada por Mongoose) para que los
 * tests unitarios de la lógica de sincronización/throttle puedan usar un fake
 * de objeto plano, sin tocar Mongo — el mismo patrón que `CoinsRepo` /
 * `JobRunsRepo`. El manejo de la carrera `E11000` vive en el servicio, no
 * acá: este repositorio deja pasar el error del `findOneAndUpdate` upsert tal
 * cual lo lanza Mongoose/MongoDB.
 */
export interface UsersRepo {
  findByFirebaseUid(firebaseUid: string): Promise<UserLean | null>;
  /** Upsert de aprovisionamiento. Lanza el error nativo de MongoDB (`code: 11000`) ante una carrera perdida. */
  insertOnFirstSight(identity: VerifiedIdentity, now: Date): Promise<UserLean>;
  /** `null` si el documento desapareció entre el `findOne` inicial y este `updateOne` (caso extremo, no esperado en operación normal). */
  updateSyncedFields(firebaseUid: string, setFields: SyncedFields): Promise<UserLean | null>;
}

export function createUsersRepo(): UsersRepo {
  return {
    async findByFirebaseUid(firebaseUid) {
      return UserModel.findOne({ firebaseUid }).lean<UserLean | null>().exec();
    },

    async insertOnFirstSight(identity, now) {
      return UserModel.findOneAndUpdate(
        { firebaseUid: identity.uid },
        {
          $setOnInsert: {
            role: 'user' satisfies UserRole,
            displayName: null,
          },
          $set: {
            email: identity.email,
            emailVerified: identity.emailVerified,
            lastSeenAt: now,
          },
        },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
      )
        .lean<UserLean>()
        .exec();
    },

    async updateSyncedFields(firebaseUid, setFields) {
      return UserModel.findOneAndUpdate(
        { firebaseUid },
        { $set: setFields },
        { returnDocument: 'after' },
      )
        .lean<UserLean | null>()
        .exec();
    },
  };
}

/** `true` cuando `error` es el error de clave duplicada de MongoDB (E11000). */
function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
}

function toUserRecord(doc: UserLean): UserRecord {
  return {
    id: doc._id.toString(),
    firebaseUid: doc.firebaseUid,
    email: doc.email,
    emailVerified: doc.emailVerified,
    displayName: doc.displayName,
    role: doc.role,
    lastSeenAt: doc.lastSeenAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * Resuelve el perfil de usuario a partir de una identidad ya verificada,
 * aprovisionándolo la primera vez que se ve su `firebaseUid` (spec
 * user-profile). `now` se recibe como parámetro (en lugar de leerse del
 * reloj del sistema) para que la lógica de sincronización/throttle sea
 * determinística en los tests.
 *
 * - Usuario desconocido: `findOneAndUpdate` con `upsert: true`,
 *   `$setOnInsert` para `role`/`displayName` y `$set` para
 *   `email`/`emailVerified`/`lastSeenAt`. Si dos requests concurrentes
 *   pierden la misma carrera, el `E11000` del perdedor se resuelve con un
 *   único reintento vía `findOne` (spec: "un burst de 10 requests
 *   concurrentes crea un único documento", E3-5).
 * - Usuario existente: se sincronizan `email`/`emailVerified` solo si
 *   difieren, y `lastSeenAt` solo si es más antiguo que
 *   `now - LAST_SEEN_THROTTLE_MIN`; ambos cambios (si aplican) se combinan en
 *   un único `updateOne`, y no se emite ninguna escritura si no hace falta
 *   nada de lo anterior (E3-6, E3-7).
 */
export async function resolveFromIdentity(
  identity: VerifiedIdentity,
  now: Date,
  cfg: Pick<Config, 'LAST_SEEN_THROTTLE_MIN'> = config,
  repo: UsersRepo = createUsersRepo(),
): Promise<UserRecord> {
  const existing = await repo.findByFirebaseUid(identity.uid);

  if (!existing) {
    return provisionNewUser(identity, now, repo);
  }

  return syncExistingUser(existing, identity, now, cfg, repo);
}

async function provisionNewUser(
  identity: VerifiedIdentity,
  now: Date,
  repo: UsersRepo,
): Promise<UserRecord> {
  try {
    const created = await repo.insertOnFirstSight(identity, now);

    defaultLogger.info(
      {
        userId: created._id.toString(),
        ...(identity.email ? { maskedEmail: maskEmail(identity.email) } : {}),
      },
      'User profile created',
    );

    return toUserRecord(created);
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }

    // E11000: otro request concurrente ganó la carrera de inserción. Un
    // único reintento con findOne alcanza porque firebaseUid nunca cambia
    // una vez creado (spec user-profile, E3-5).
    const winner = await repo.findByFirebaseUid(identity.uid);

    if (!winner) {
      throw error;
    }

    return toUserRecord(winner);
  }
}

async function syncExistingUser(
  existing: UserLean,
  identity: VerifiedIdentity,
  now: Date,
  cfg: Pick<Config, 'LAST_SEEN_THROTTLE_MIN'>,
  repo: UsersRepo,
): Promise<UserRecord> {
  const incomingEmail = identity.email ?? null;
  const needsFieldSync =
    existing.email !== incomingEmail || existing.emailVerified !== identity.emailVerified;

  const throttleMs = cfg.LAST_SEEN_THROTTLE_MIN * 60_000;
  const isStale = now.getTime() - existing.lastSeenAt.getTime() >= throttleMs;

  if (!needsFieldSync && !isStale) {
    return toUserRecord(existing);
  }

  const setFields: SyncedFields = {
    ...(needsFieldSync ? { email: incomingEmail, emailVerified: identity.emailVerified } : {}),
    ...(isStale ? { lastSeenAt: now } : {}),
  };

  const updated = await repo.updateSyncedFields(identity.uid, setFields);

  return toUserRecord(updated ?? existing);
}

/**
 * Actualiza `displayName` del perfil identificado por su `_id` de Mongo
 * (spec me-endpoints: `PATCH /api/v1/me`). `displayName: null` lo borra. `id`
 * ya fue resuelto por `requireAuth`/`getUser`, así que siempre corresponde a
 * un documento existente en operación normal; `null` solo cubre el caso
 * extremo de que el documento haya desaparecido entre el request y esta
 * escritura.
 */
export async function updateDisplayName(
  id: string,
  displayName: string | null,
): Promise<UserRecord | null> {
  const updated = await UserModel.findByIdAndUpdate(
    id,
    { $set: { displayName } },
    { returnDocument: 'after' },
  )
    .lean<UserLean | null>()
    .exec();

  return updated ? toUserRecord(updated) : null;
}

/**
 * Elimina el documento de `users` identificado por su `_id` de Mongo (spec
 * me-endpoints: `DELETE /api/v1/me`). Nunca toca la cuenta de Firebase — un
 * request posterior con un token todavía válido vuelve a aprovisionar un
 * perfil vacío a través de `resolveFromIdentity` (design.md, documentado
 * también en el README).
 */
export async function deleteUserById(id: string): Promise<boolean> {
  const result = await UserModel.deleteOne({ _id: id }).exec();
  return result.deletedCount > 0;
}

export interface RoleTransition {
  readonly previousRole: UserRole;
  readonly newRole: UserRole;
}

/**
 * Busca un perfil de `users` por email y le asigna `role` (spec
 * auth-dev-scripts: scripts `user:set-role` y `auth:create-test-user
 * --admin`, tareas 9.1/9.3). Devuelve `null` cuando no existe ningún perfil
 * de Mongo con ese email — el caso que ambos scripts reportan como "el
 * usuario todavía no llamó a la API ni fue creado con
 * auth:create-test-user", ya que el aprovisionamiento just-in-time es lo
 * único que crea un documento de `users` en operación normal.
 */
export async function setUserRoleByEmail(
  email: string,
  role: UserRole,
): Promise<RoleTransition | null> {
  const existing = await UserModel.findOne({ email: email.toLowerCase() })
    .lean<UserLean | null>()
    .exec();

  if (!existing) {
    return null;
  }

  if (existing.role === role) {
    return { previousRole: existing.role, newRole: role };
  }

  await UserModel.updateOne({ _id: existing._id }, { $set: { role } }).exec();

  return { previousRole: existing.role, newRole: role };
}

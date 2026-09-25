import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * Modelo de Mongoose para `users`: perfiles de la aplicación, aprovisionados
 * just-in-time a partir de la identidad verificada de Firebase (spec
 * user-profile). `_id` se usa como `userId` por el resto de las colecciones
 * en etapas posteriores (watchlists, alertas).
 */

export const USER_ROLES = ['user', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * `users`: una colección normal. `firebaseUid` es la clave natural que
 * vincula el documento con la cuenta de Firebase; nunca cambia después de la
 * creación. `lastSeenAt` no lleva default a nivel de schema porque siempre lo
 * fija explícitamente `usersService.resolveFromIdentity` (tanto en la
 * creación como en la sincronización), nunca un valor implícito del schema.
 */
const userSchema = new Schema(
  {
    firebaseUid: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    email: {
      type: String,
      default: null,
      lowercase: true,
      trim: true,
    },
    emailVerified: {
      type: Boolean,
      required: true,
      default: false,
    },
    displayName: {
      type: String,
      default: null,
      trim: true,
      minlength: 1,
      maxlength: 50,
    },
    role: {
      type: String,
      required: true,
      enum: USER_ROLES,
      default: 'user',
    },
    lastSeenAt: {
      type: Date,
      required: true,
    },
  },
  {
    collection: 'users',
    timestamps: true,
    versionKey: false,
  },
);

// Índice único que hace segura la carrera de aprovisionamiento concurrente
// (spec user-profile: "un burst de requests concurrentes crea un único
// documento"). El índice no-único de email sirve la búsqueda del script de
// desarrollo `user:set-role` (Fase B) sin necesitar un collection scan.
userSchema.index({ email: 1 });

export type UserDocument = HydratedDocument<InferSchemaType<typeof userSchema>>;

export const UserModel = model('User', userSchema);

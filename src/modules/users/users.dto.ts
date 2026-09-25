import type { UserRecord } from './users.service.js';
import type { UserRole } from './users.model.js';

/**
 * DTO de salida de `GET`/`PATCH /api/v1/me` (spec me-endpoints) y el builder
 * que lo arma a partir de un `UserRecord`. Explícito campo por campo (design.md:
 * "los DTOs de salida son explícitos, no transforms de `toJSON`") — en
 * particular, nunca incluye `firebaseUid`, `lastSeenAt` ni `updatedAt`, que no
 * forman parte del contrato público de este endpoint.
 */
export interface UserMeDto {
  readonly id: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly displayName: string | null;
  readonly role: UserRole;
  readonly createdAt: Date;
}

export function toUserMeDto(user: UserRecord): UserMeDto {
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
    displayName: user.displayName,
    role: user.role,
    createdAt: user.createdAt,
  };
}

import { z } from 'zod';

/**
 * Schema de Zod para `PATCH /api/v1/me` (spec me-endpoints): estricto, con un
 * único campo aceptado, `displayName` (string de 1 a 50 caracteres recortada,
 * o `null` para borrarlo). `.strict()` ya rechaza cualquier campo fuera del
 * schema (incluidos `email` y `role`, ninguno editable por esta vía) con 400
 * `VALIDATION_ERROR`; el `.refine()` de abajo agrega el mismo código cuando
 * `displayName` ni siquiera está presente, así un body vacío (`{}`) también
 * se rechaza en lugar de tratarse como "no hay nada que actualizar".
 */
const rawPatchMeBodySchema = z
  .object({
    displayName: z.union([z.string().trim().min(1).max(50), z.null()]).optional(),
  })
  .strict();

export const patchMeBodySchema = rawPatchMeBodySchema.refine(
  (data) => data.displayName !== undefined,
  { message: 'Debe proporcionar al menos un campo', path: ['displayName'] },
);

export type PatchMeBody = z.infer<typeof patchMeBodySchema>;

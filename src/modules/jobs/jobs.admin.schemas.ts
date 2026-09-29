import { z } from 'zod';

/**
 * Schemas de Zod para las rutas de admin de jobs (spec admin-jobs-api).
 * `name` se valida solo como string no vacío acá: la pertenencia a
 * `JOB_NAMES` se chequea en la ruta y produce 404 `NOT_FOUND`, no 400
 * `VALIDATION_ERROR` (spec: "An unknown job name is not found").
 */

export const adminJobsListQuerySchema = z
  .object({ includeOneOff: z.enum(['true', 'false']).optional() })
  .strict()
  .transform((data) => ({ includeOneOff: data.includeOneOff === 'true' }));

export type AdminJobsListQuery = z.infer<typeof adminJobsListQuerySchema>;

export const jobNameParamSchema = z.object({ name: z.string().min(1) }).strict();

export type JobNameParam = z.infer<typeof jobNameParamSchema>;

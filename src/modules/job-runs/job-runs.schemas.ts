import { z } from 'zod';
import { Types } from 'mongoose';
import { JOB_STATUSES, type JobStatus } from './job-runs.model.js';

/**
 * Schemas de Zod para las rutas de admin de job-runs: query de listado
 * (con filtros y paginación) y parámetro de id de ruta.
 */

/**
 * Schema de query estricto para `GET /api/v1/admin/job-runs` (spec
 * admin-job-runs-api). `status` acepta uno o más valores separados por coma;
 * cada uno debe ser un {@link JobStatus} conocido, validado (y separado) en
 * el `.transform()` de abajo vía `ctx.addIssue`, el mismo patrón que usa
 * `historyQuerySchema` para sus reglas entre campos.
 */
const rawJobRunListQuerySchema = z
  .object({
    jobName: z.string().min(1).optional(),
    status: z.string().min(1).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const jobRunListQuerySchema = rawJobRunListQuerySchema.transform((data, ctx) => {
  let status: JobStatus[] | undefined;

  if (data.status !== undefined) {
    const values = data.status.split(',');
    const invalid = values.filter((value) => !JOB_STATUSES.includes(value as JobStatus));

    if (invalid.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message: `Valores de status inválidos: ${invalid.join(', ')}`,
      });
    } else {
      status = values as JobStatus[];
    }
  }

  return {
    jobName: data.jobName,
    status,
    from: data.from ? new Date(data.from) : undefined,
    to: data.to ? new Date(data.to) : undefined,
    page: data.page,
    limit: data.limit,
  };
});

export type JobRunListQuery = z.infer<typeof jobRunListQuerySchema>;

/**
 * Schema del parámetro de ruta para `GET /api/v1/admin/job-runs/:id`. Valida
 * por adelantado que el id sea un `ObjectId` de Mongo bien formado, así uno
 * malformado es un 400 `VALIDATION_ERROR` de `validate()` en lugar de un
 * `CastError` de Mongoose (spec admin-job-runs-api).
 */
export const jobRunIdParamSchema = z
  .object({
    id: z.string().refine((value) => Types.ObjectId.isValid(value), 'Identificador inválido'),
  })
  .strict();

export type JobRunIdParam = z.infer<typeof jobRunIdParamSchema>;

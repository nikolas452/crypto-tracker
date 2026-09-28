import { z } from 'zod';
import { Types } from 'mongoose';
import { NOTIFICATION_STATUSES, type NotificationStatus } from './notifications.model.js';

/**
 * Schemas de Zod para las rutas de administración de notifications: query de
 * listado (paginado, con filtros `status`/`userId`/`from`/`to`) y parámetro
 * de ruta `id` para el reintento. Mismo estilo que `job-runs.schemas.ts`
 * (closest date-range/status-list precedent de este proyecto).
 */

/**
 * Schema de query estricto para `GET /api/v1/admin/notifications` (spec
 * admin-notifications-api). `status` acepta uno o más valores separados por
 * coma; cada uno debe ser un {@link NotificationStatus} conocido, validado
 * (y separado) en el `.transform()` de abajo vía `ctx.addIssue`, el mismo
 * patrón que usa `jobRunListQuerySchema`.
 */
const rawAdminNotificationListQuerySchema = z
  .object({
    status: z.string().min(1).optional(),
    userId: z.string().refine((value) => Types.ObjectId.isValid(value), 'Identificador inválido').optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const adminNotificationListQuerySchema = rawAdminNotificationListQuerySchema.transform(
  (data, ctx) => {
    let status: NotificationStatus[] | undefined;

    if (data.status !== undefined) {
      const values = data.status.split(',');
      const invalid = values.filter(
        (value) => !NOTIFICATION_STATUSES.includes(value as NotificationStatus),
      );

      if (invalid.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['status'],
          message: `Valores de status inválidos: ${invalid.join(', ')}`,
        });
      } else {
        status = values as NotificationStatus[];
      }
    }

    return {
      status,
      userId: data.userId,
      from: data.from ? new Date(data.from) : undefined,
      to: data.to ? new Date(data.to) : undefined,
      page: data.page,
      limit: data.limit,
    };
  },
);

export type AdminNotificationListQuery = z.infer<typeof adminNotificationListQuerySchema>;

/**
 * Schema del parámetro de ruta para `POST
 * /api/v1/admin/notifications/:id/retry`. Valida por adelantado que el id
 * sea un `ObjectId` de Mongo bien formado, así uno malformado es un 400
 * `VALIDATION_ERROR` de `validate()` en lugar de un `CastError` de Mongoose
 * (mismo patrón que `jobRunIdParamSchema`).
 */
export const adminNotificationIdParamSchema = z
  .object({
    id: z.string().refine((value) => Types.ObjectId.isValid(value), 'Identificador inválido'),
  })
  .strict();

export type AdminNotificationIdParam = z.infer<typeof adminNotificationIdParamSchema>;

/**
 * Body estricto de `POST /api/v1/admin/notifications/test-email`: no
 * requiere ningún campo (el destinatario siempre es el propio admin
 * autenticado, nunca un valor provisto por el cliente), pero se valida como
 * objeto estricto para que cualquier campo inesperado falle con 400
 * `VALIDATION_ERROR` en lugar de ser ignorado silenciosamente.
 */
export const adminTestEmailBodySchema = z.object({}).strict();

export type AdminTestEmailBody = z.infer<typeof adminTestEmailBodySchema>;

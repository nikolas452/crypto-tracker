import { z } from 'zod';
import { NOTIFICATION_STATUSES } from './notifications.model.js';

/**
 * Schema de Zod para la ruta de listado de notifications: query estricto de
 * `GET /api/v1/me/notifications`.
 */

/** Página/límite por defecto y máximo, mismo par de valores que `job-runs.schemas.ts` (único otro listado paginado del proyecto). */
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Schema de query estricto para `GET /api/v1/me/notifications` (spec
 * notification-outbox): cualquier clave fuera de `status`/`page`/`limit`
 * falla la validación con 400 `VALIDATION_ERROR`. A diferencia de
 * `job-runs.schemas.ts`, `status` acepta un único valor (no una lista
 * separada por comas) — la spec solo pide "one of the 5 status enum
 * values".
 */
export const notificationListQuerySchema = z
  .object({
    status: z.enum(NOTIFICATION_STATUSES).optional(),
    page: z.coerce.number().int().min(1).default(DEFAULT_PAGE),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  })
  .strict();

export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;

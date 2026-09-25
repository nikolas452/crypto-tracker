import { Router, type RequestHandler } from 'express';
import { validate } from '../../lib/errors.js';
import { getUser } from '../../lib/getUser.js';
import { requireAuth } from '../../middlewares/requireAuth.js';
import { patchMeBodySchema } from './users.schemas.js';
import { toUserMeDto } from './users.dto.js';
import { deleteUserById, updateDisplayName } from './users.service.js';

/**
 * `GET`/`PATCH`/`DELETE /api/v1/me` (specs me-endpoints): perfil del usuario
 * autenticado. Cada ruta llama a `requireAuth` con las opciones que le
 * corresponden (`DELETE` exige `checkRevoked: true`, spec: "operación
 * destructiva" — las otras dos usan el valor por defecto `false`), así que no
 * puede montarse una única vez a nivel de router. `userRateLimiter` se recibe
 * como dependencia (en lugar de construirse acá) para que `app.ts` pase la
 * misma instancia compartida que usan las rutas de admin — un solo
 * presupuesto por uid entre todas las rutas autenticadas (spec
 * user-rate-limiting). Los handlers solo validan la entrada y dan forma a la
 * respuesta HTTP; la escritura vive en `users.service.ts`.
 */
export function createUsersRouter(userRateLimiter: RequestHandler): Router {
  const router = Router();

  router.get('/', requireAuth(), userRateLimiter, (req, res, next) => {
    try {
      res.status(200).json({ data: toUserMeDto(getUser(req)) });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/', requireAuth(), userRateLimiter, async (req, res, next) => {
    try {
      const body = validate(patchMeBodySchema, req.body, 'body');
      const currentUser = getUser(req);
      const updated = await updateDisplayName(currentUser.id, body.displayName ?? null);

      res.status(200).json({ data: toUserMeDto(updated ?? currentUser) });
    } catch (error) {
      next(error);
    }
  });

  router.delete(
    '/',
    requireAuth({ checkRevoked: true }),
    userRateLimiter,
    async (req, res, next) => {
      try {
        const currentUser = getUser(req);
        await deleteUserById(currentUser.id);

        res.status(204).send();
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

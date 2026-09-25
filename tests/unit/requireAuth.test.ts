import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { requireAuth } from '../../src/middlewares/requireAuth.js';
import { createFakeTokenVerifier } from '../../src/integrations/firebase/fakeTokenVerifier.js';
import { TokenExpiredError, UnauthenticatedError } from '../../src/lib/errors.js';
import type { TokenVerifier } from '../../src/integrations/firebase/tokenVerifier.js';

/**
 * Tests unitarios del middleware `requireAuth` (spec auth-middleware), con un
 * `TokenVerifier` falso/espiado en `req.app.locals.tokenVerifier` — nunca un
 * proyecto de Firebase real.
 */

function createFakeReq(options: {
  authorization?: string;
  tokenVerifier: TokenVerifier;
  query?: Record<string, string>;
}): Request {
  return {
    header(name: string) {
      return name.toLowerCase() === 'authorization' ? options.authorization : undefined;
    },
    query: options.query ?? {},
    app: { locals: { tokenVerifier: options.tokenVerifier } },
  } as unknown as Request;
}

describe('requireAuth', () => {
  // E3-1.
  it('E3-1: calls next() with UnauthenticatedError when the Authorization header is missing', async () => {
    const verify = vi.fn();
    const req = createFakeReq({ tokenVerifier: { verify } });
    const next = vi.fn();

    await requireAuth()(req, {} as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]?.[0]).toBeInstanceOf(UnauthenticatedError);
    expect(verify).not.toHaveBeenCalled();
  });

  // E3-2.
  it('E3-2: calls next() with UnauthenticatedError for a non-Bearer scheme', async () => {
    const verify = vi.fn();
    const req = createFakeReq({ authorization: 'Basic xxx', tokenVerifier: { verify } });
    const next = vi.fn();

    await requireAuth()(req, {} as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]?.[0]).toBeInstanceOf(UnauthenticatedError);
    expect(verify).not.toHaveBeenCalled();
  });

  it('calls next() with UnauthenticatedError for a Bearer scheme with an empty token', async () => {
    const verify = vi.fn();
    const req = createFakeReq({ authorization: 'Bearer', tokenVerifier: { verify } });
    const next = vi.fn();

    await requireAuth()(req, {} as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]?.[0]).toBeInstanceOf(UnauthenticatedError);
    expect(verify).not.toHaveBeenCalled();
  });

  // E3-3.
  it('E3-3: surfaces TOKEN_EXPIRED for an expired token', async () => {
    const tokenVerifier = createFakeTokenVerifier({
      failures: { 'expired-token': 'TOKEN_EXPIRED' },
    });
    const req = createFakeReq({ authorization: 'Bearer expired-token', tokenVerifier });
    const next = vi.fn();

    await requireAuth()(req, {} as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]?.[0]).toBeInstanceOf(TokenExpiredError);
  });

  // Tarea 5.2 y 5.8: token de más de 4096 caracteres, rechazado sin invocar al verificador.
  it('rejects a token longer than 4096 characters without calling the verifier', async () => {
    const verify = vi.fn();
    const oversizedToken = 'a'.repeat(4097);
    const req = createFakeReq({
      authorization: `Bearer ${oversizedToken}`,
      tokenVerifier: { verify },
    });
    const next = vi.fn();

    await requireAuth()(req, {} as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]?.[0]).toBeInstanceOf(UnauthenticatedError);
    expect(verify).not.toHaveBeenCalled();
  });

  // Tarea 5.5 y 5.8: un token en la query string, sin header, se ignora.
  it('ignores a token supplied only as a query string parameter', async () => {
    const verify = vi.fn();
    const req = createFakeReq({
      tokenVerifier: { verify },
      query: { token: 'a-valid-looking-token' },
    });
    const next = vi.fn();

    await requireAuth()(req, {} as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]?.[0]).toBeInstanceOf(UnauthenticatedError);
    expect(verify).not.toHaveBeenCalled();
  });

  // Tarea 5.3: checkRevoked se reenvía tal cual al verificador, incluso
  // cuando la verificación falla (evita depender de Mongo en un test
  // unitario: la resolución de `req.user` vía `resolveFromIdentity` solo se
  // ejercita en los tests de integración de `/me` y `/admin`).
  it('forwards checkRevoked: true to the verifier', async () => {
    const verify = vi.fn().mockRejectedValue(new UnauthenticatedError());
    const req = createFakeReq({ authorization: 'Bearer some-token', tokenVerifier: { verify } });
    const next = vi.fn();

    await requireAuth({ checkRevoked: true })(req, {} as Response, next);

    expect(verify).toHaveBeenCalledWith('some-token', { checkRevoked: true });
  });
});

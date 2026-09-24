import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createRequireAdminKey } from '../../src/middlewares/requireAdminKey.js';
import { NotFoundError, UnauthenticatedError } from '../../src/lib/errors.js';

/** Tests unitarios del middleware `createRequireAdminKey` de `src/middlewares/requireAdminKey.ts`. */

const ADMIN_KEY = 'a'.repeat(32);

function createFakeReq(headers: Record<string, string> = {}): Request {
  return {
    method: 'GET',
    path: '/api/v1/admin/job-runs',
    header(name: string) {
      return headers[name.toLowerCase()];
    },
  } as unknown as Request;
}

describe('createRequireAdminKey', () => {
  // 9.5: clave sin configurar — toda la superficie admin devuelve 404, no 401.
  it('calls next() with a NotFoundError when ADMIN_API_KEY is unconfigured', () => {
    const middleware = createRequireAdminKey(undefined);
    const next = vi.fn();

    middleware(createFakeReq({ 'x-admin-key': ADMIN_KEY }), {} as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]?.[0]).toBeInstanceOf(NotFoundError);
  });

  // 9.5: sin header.
  it('calls next() with an UnauthenticatedError when the header is missing', () => {
    const middleware = createRequireAdminKey(ADMIN_KEY);
    const next = vi.fn();

    middleware(createFakeReq(), {} as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]?.[0]).toBeInstanceOf(UnauthenticatedError);
  });

  // 9.5: clave incorrecta, de la misma longitud que la configurada — ejercita
  // la rama de timingSafeEqual en sí, no solo el chequeo previo de longitud.
  it('calls next() with an UnauthenticatedError when the key is wrong (same length)', () => {
    const middleware = createRequireAdminKey(ADMIN_KEY);
    const next = vi.fn();

    middleware(createFakeReq({ 'x-admin-key': 'b'.repeat(32) }), {} as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]?.[0]).toBeInstanceOf(UnauthenticatedError);
  });

  // 9.5: longitud distinta — debe rechazarse sin llegar a llamar a
  // timingSafeEqual (que lanza si hay un desajuste de longitud de buffer).
  it('rejects a key of a different length without throwing', () => {
    const middleware = createRequireAdminKey(ADMIN_KEY);
    const next = vi.fn();

    expect(() =>
      middleware(createFakeReq({ 'x-admin-key': 'a'.repeat(10) }), {} as Response, next),
    ).not.toThrow();

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]?.[0]).toBeInstanceOf(UnauthenticatedError);
  });

  // 9.5: clave correcta.
  it('calls next() with no error when the key matches', () => {
    const middleware = createRequireAdminKey(ADMIN_KEY);
    const next = vi.fn();

    middleware(createFakeReq({ 'x-admin-key': ADMIN_KEY }), {} as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]?.[0]).toBeUndefined();
  });
});

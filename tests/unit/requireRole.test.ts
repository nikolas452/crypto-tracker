import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { requireRole } from '../../src/middlewares/requireRole.js';
import { ForbiddenError, UnauthenticatedError } from '../../src/lib/errors.js';
import type { UserRecord } from '../../src/modules/users/users.service.js';

/** Tests unitarios del middleware `requireRole` (spec role-authorization). */

function createFakeReq(user?: Pick<UserRecord, 'role'>): Request {
  return { user } as unknown as Request;
}

describe('requireRole', () => {
  it('calls next() with no error when the user has an accepted role', () => {
    const middleware = requireRole('admin');
    const next = vi.fn();

    middleware(createFakeReq({ role: 'admin' }), {} as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]?.[0]).toBeUndefined();
  });

  it('calls next() with a ForbiddenError when the user role is not accepted', () => {
    const middleware = requireRole('admin');
    const next = vi.fn();

    middleware(createFakeReq({ role: 'user' }), {} as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]?.[0]).toBeInstanceOf(ForbiddenError);
  });

  it('calls next() with an UnauthenticatedError when req.user is missing', () => {
    const middleware = requireRole('admin');
    const next = vi.fn();

    middleware(createFakeReq(undefined), {} as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]?.[0]).toBeInstanceOf(UnauthenticatedError);
  });

  it('accepts any of several listed roles', () => {
    const middleware = requireRole('admin', 'user');
    const next = vi.fn();

    middleware(createFakeReq({ role: 'user' }), {} as Response, next);

    expect(next.mock.calls[0]?.[0]).toBeUndefined();
  });
});

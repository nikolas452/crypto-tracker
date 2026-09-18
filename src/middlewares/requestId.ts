import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const REQUEST_ID_HEADER = 'x-request-id';
const MAX_REQUEST_ID_LENGTH = 128;

/**
 * `req.id` is typed as pino-http's `ReqId` (`string | number | object`)
 * because `pino-http`'s own type declarations augment `http.IncomingMessage`
 * globally (and Express's `Request` extends `IncomingMessage`). This app
 * only ever assigns a `string` to it — see {@link readRequestId} for the
 * narrowing helper used wherever call sites need a `string`.
 */

/**
 * Reuses the incoming `X-Request-Id` header when present and no longer than
 * 128 characters; otherwise generates a new UUID v4. Stores the result on
 * `req.id` and echoes it back via the `X-Request-Id` response header.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(REQUEST_ID_HEADER);
  const id = incoming && incoming.length > 0 && incoming.length <= MAX_REQUEST_ID_LENGTH
    ? incoming
    : randomUUID();

  req.id = id;
  res.setHeader('X-Request-Id', id);
  next();
}

/**
 * Narrows `req.id` (typed as pino-http's `ReqId` union) back to `string` for
 * call sites that need it — this app never assigns anything else to it.
 * Accepts anything with an `id` property so it works for both the plain
 * `IncomingMessage` pino-http hands to `genReqId` and the Express `Request`.
 */
export function readRequestId(req: { id?: unknown }): string {
  return typeof req.id === 'string' ? req.id : String(req.id ?? '');
}

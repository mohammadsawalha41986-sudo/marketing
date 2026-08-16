/** Typed application errors, so route handlers never leak internals to clients. */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details);

export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'UNAUTHORIZED', message);

/**
 * Used for both "you may not" and "it is not yours". Returning 404 for another
 * tenant's row would be better still, and `notFound` is what the scope helpers
 * actually throw — this is for action-level denials.
 */
export const forbidden = (message = 'You do not have access to this resource') =>
  new AppError(403, 'FORBIDDEN', message);

export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);

export const conflict = (message: string) => new AppError(409, 'CONFLICT', message);

/**
 * The resource existed but its bytes are gone.
 *
 * Distinct from 404 on purpose: the row is still there and the id is still
 * valid, so "not found" would send someone looking for a lookup bug. 410 says
 * the reference is good and the object behind it is missing — which on an
 * ephemeral filesystem is the expected outcome of a redeploy.
 */
export const gone = (message: string) => new AppError(410, 'STORED_OBJECT_MISSING', message);

export const tooLarge = (message: string) => new AppError(413, 'PAYLOAD_TOO_LARGE', message);

/**
 * Object storage failures, kept apart from generic 500s.
 *
 * Storage is the one dependency whose failure mode is routinely a *configuration*
 * problem rather than a bug, and the three cases need different responses from
 * whoever is looking at it: nothing is configured (fix the environment), the
 * bucket refused a write (check credentials and permissions), the bucket refused
 * a read (the object may be there but unreachable). Collapsing them into
 * "Something went wrong" is what made the ephemeral-filesystem data loss take so
 * long to identify.
 */
export const storageNotConfigured = (message: string) =>
  new AppError(503, 'STORAGE_NOT_CONFIGURED', message);

export const storageUploadFailed = (message: string) =>
  new AppError(502, 'STORAGE_UPLOAD_FAILED', message);

export const storageReadFailed = (message: string) =>
  new AppError(502, 'STORAGE_READ_FAILED', message);

export const storageDeleteFailed = (message: string) =>
  new AppError(502, 'STORAGE_DELETE_FAILED', message);

export const unprocessable = (message: string, details?: unknown) =>
  new AppError(422, 'UNPROCESSABLE', message, details);

/** Wraps an async handler so a rejected promise reaches the error middleware. */
export function asyncHandler<T extends RequestHandler>(handler: T): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    void Promise.resolve(handler(req, res, next)).catch(next);
  };
}

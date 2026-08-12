/** Zod request validation. Replaces req.body/query with the parsed value. */

import type { RequestHandler } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { badRequest } from '../lib/errors.js';

function fieldErrors(error: ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}

export function validateBody<T extends ZodTypeAny>(schema: T): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      next(badRequest('Invalid request body', fieldErrors(result.error)));
      return;
    }
    req.body = result.data;
    next();
  };
}

export function validateQuery<T extends ZodTypeAny>(schema: T): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      next(badRequest('Invalid query parameters', fieldErrors(result.error)));
      return;
    }
    // Express 4 allows reassigning req.query; keep the parsed value for handlers.
    Object.defineProperty(req, 'query', { value: result.data, writable: true, configurable: true });
    next();
  };
}

export function validateParams<T extends ZodTypeAny>(schema: T): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      next(badRequest('Invalid path parameters', fieldErrors(result.error)));
      return;
    }
    Object.defineProperty(req, 'params', { value: result.data, writable: true, configurable: true });
    next();
  };
}

export type Infer<T extends ZodTypeAny> = z.infer<T>;

/** Authentication and CSRF. */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { forbidden, unauthorized } from '../lib/errors.js';
import { CSRF_COOKIE, SESSION_COOKIE, resolveSession, safeEqual } from '../lib/session.js';
import type { Actor } from '../lib/actor.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Populates `req.actor` when a valid session cookie is present. Never throws. */
export const loadActor: RequestHandler = (req, _res, next) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token !== 'string' || token.length === 0) {
    next();
    return;
  }

  void resolveSession(token)
    .then((session) => {
      if (session) {
        const { user } = session;
        req.actor = {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        } satisfies Actor;
        req.sessionToken = token;
      }
      next();
    })
    .catch(next);
};

/**
 * The only gate in the application.
 *
 * There are no roles to check beyond this. The product has one operator, so
 * "signed in" and "allowed" are the same question — a role matrix here would be
 * scaffolding around a set with one element.
 */
export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.actor) {
    next(unauthorized());
    return;
  }
  next();
};

/**
 * Double-submit CSRF. Applied only to authenticated mutations: an unauthenticated
 * POST (login) has no session to ride on, so there is nothing to forge.
 */
export const csrfGuard = (req: Request, _res: Response, next: NextFunction): void => {
  if (!MUTATING.has(req.method) || !req.actor) {
    next();
    return;
  }
  const cookie = req.cookies?.[CSRF_COOKIE];
  const header = req.get('x-csrf-token');

  if (typeof cookie !== 'string' || typeof header !== 'string' || !safeEqual(cookie, header)) {
    next(forbidden('CSRF token missing or invalid'));
    return;
  }
  next();
};

/** Convenience accessor for handlers that run behind `requireAuth`. */
export function actorOf(req: Request): Actor {
  if (!req.actor) throw unauthorized();
  return req.actor;
}

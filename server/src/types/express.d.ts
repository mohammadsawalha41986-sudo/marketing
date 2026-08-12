import type { Actor } from '../lib/scope.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by `requireAuth`. Absent on public routes. */
      actor?: Actor;
      sessionToken?: string;
    }
  }
}

export {};

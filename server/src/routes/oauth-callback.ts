/**
 * The provider's redirect back, on its own unauthenticated router.
 *
 * This is the one integration route the browser reaches without a session:
 * Meta redirects here directly, carrying no cookie of ours. Everything that
 * identifies the tenant therefore comes out of the signed, single-use OAuth
 * state, never out of the query string — a callback is not a place to be told
 * whose connection this is.
 *
 * Mounted at /api/integrations, ahead of the authenticated router, so
 * /api/integrations/meta/callback resolves here rather than being challenged
 * for a session it cannot have.
 */

import { Router } from 'express';
import { Platform } from '@prisma/client';
import { z } from 'zod';

import { asyncHandler } from '../lib/errors.js';
import { validateQuery } from '../middleware/validate.js';
import { completeCallback } from '../services/integrations/connect-flow.js';
import { env } from '../env.js';

export const oauthCallbackRouter: Router = Router();

/**
 * Where the browser is sent afterwards.
 *
 * The result is carried as query parameters, never the code or the token. A
 * failure sends the operator back to the same screen with the provider's own
 * message rather than to a dead end.
 */
function callbackRedirect(outcome: { ok: true; integrationId: string } | { ok: false; reason: string }): string {
  const url = new URL('/app/integrations', env.APP_URL);
  if (outcome.ok) {
    url.searchParams.set('connected', 'meta');
    url.searchParams.set('integration', outcome.integrationId);
  } else {
    url.searchParams.set('error', outcome.reason.slice(0, 300));
  }
  return url.toString();
}

oauthCallbackRouter.get(
  '/meta/callback',
  validateQuery(
    z.object({
      // Meta sends either (code, state) or its own error triple.
      code: z.string().min(1).max(2000).optional(),
      state: z.string().min(1).max(200).optional(),
      error: z.string().max(200).optional(),
      error_reason: z.string().max(200).optional(),
      error_description: z.string().max(500).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const query = req.query as {
      code?: string; state?: string; error?: string; error_description?: string;
    };

    // The operator pressed Cancel on Meta's dialog. Not an error worth a 500.
    if (query.error) {
      res.redirect(callbackRedirect({ ok: false, reason: query.error_description ?? query.error }));
      return;
    }
    if (!query.code || !query.state) {
      res.redirect(callbackRedirect({ ok: false, reason: 'Meta returned no authorization code' }));
      return;
    }

    try {
      const result = await completeCallback({
        platform: Platform.FACEBOOK,
        state: query.state,
        code: query.code,
        fetchImpl: fetch as unknown as Parameters<typeof completeCallback>[0]['fetchImpl'],
      });
      res.redirect(callbackRedirect({ ok: true, integrationId: result.integrationId }));
    } catch (error) {
      // completeCallback has already parked the integration in ERROR with the
      // reason. Provider messages never carry the code or the token.
      res.redirect(callbackRedirect({ ok: false, reason: (error as Error).message }));
    }
  }),
);

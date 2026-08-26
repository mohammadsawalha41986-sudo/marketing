/**
 * The provider's redirect back, on its own unauthenticated router.
 *
 * This is the one integration route the browser reaches without a session:
 * the provider redirects here directly, carrying no cookie of ours. Everything
 * that identifies the tenant therefore comes out of the signed, single-use
 * OAuth state, never out of the query string — a callback is not a place to be
 * told whose connection this is.
 *
 * Mounted at /api/integrations, ahead of the authenticated router, so
 * /api/integrations/meta/callback resolves here rather than being challenged
 * for a session it cannot have.
 *
 * Every provider gets its own path, and the path is what names the platform
 * passed to `completeCallback`. That is deliberate and it is a security
 * property, not bookkeeping: the OAuth state is bound to one platform, and the
 * route is the independent witness of which provider actually redirected. Were
 * the platform read out of the state instead, the state would be checked
 * against itself and the binding would assert nothing. It is also why YouTube
 * has a route of its own despite sharing Google's OAuth client.
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
function callbackRedirect(
  outcome: { ok: true; integrationId: string } | { ok: false; reason: string },
  provider = 'meta',
): string {
  const url = new URL('/app/integrations', env.APP_URL);
  if (outcome.ok) {
    url.searchParams.set('connected', provider);
    url.searchParams.set('integration', outcome.integrationId);
  } else {
    url.searchParams.set('error', outcome.reason.slice(0, 300));
  }
  return url.toString();
}

/**
 * The query every provider sends back, as the union of what they each use.
 *
 * One schema rather than five: the providers disagree about which refusal
 * fields they populate — Meta sends `error_reason`, TikTok adds `errCode`,
 * Google sends a bare `error`, LinkedIn an `error_description` — but they agree
 * on `code`, `state` and `error`, and every extra field is optional. Rejecting
 * a callback because a provider sent one field more than another would fail the
 * connection at the last step for no reason.
 */
const callbackQuery = z.object({
  code: z.string().min(1).max(2000).optional(),
  state: z.string().min(1).max(200).optional(),
  scope: z.string().max(2000).optional(),
  error: z.string().max(200).optional(),
  error_reason: z.string().max(200).optional(),
  error_description: z.string().max(500).optional(),
  errCode: z.string().max(50).optional(),
});

/**
 * Mount one provider's callback.
 *
 * The handler is identical for all of them because the work is
 * `completeCallback`'s; what differs is only the platform the route stands for
 * and the label the operator sees on return.
 */
function mountCallback(input: { slug: string; platform: Platform; label: string }): void {
  oauthCallbackRouter.get(
    `/${input.slug}/callback`,
    validateQuery(callbackQuery),
    asyncHandler(async (req, res) => {
      const query = req.query as {
        code?: string; state?: string; error?: string; error_description?: string;
      };

      // The operator pressed Cancel on the provider's dialog. Not an error
      // worth a 500, and its own message is better than one we invent.
      if (query.error) {
        res.redirect(
          callbackRedirect({ ok: false, reason: query.error_description ?? query.error }, input.slug),
        );
        return;
      }
      if (!query.code || !query.state) {
        res.redirect(
          callbackRedirect({ ok: false, reason: `${input.label} returned no authorization code` }, input.slug),
        );
        return;
      }

      try {
        const result = await completeCallback({
          platform: input.platform,
          state: query.state,
          code: query.code,
          fetchImpl: fetch as unknown as Parameters<typeof completeCallback>[0]['fetchImpl'],
        });
        res.redirect(callbackRedirect({ ok: true, integrationId: result.integrationId }, input.slug));
      } catch (error) {
        // completeCallback has already parked the integration in ERROR with the
        // reason. Provider messages never carry the code or the token.
        res.redirect(callbackRedirect({ ok: false, reason: (error as Error).message }, input.slug));
      }
    }),
  );
}

/*
 * Meta's slug is `meta` while its platform is FACEBOOK, because one Meta login
 * covers both Facebook and Instagram and the integration row for the pair is
 * keyed on FACEBOOK.
 */
mountCallback({ slug: 'meta', platform: Platform.FACEBOOK, label: 'Meta' });
mountCallback({ slug: 'tiktok', platform: Platform.TIKTOK, label: 'TikTok' });
mountCallback({ slug: 'google', platform: Platform.GOOGLE_BUSINESS, label: 'Google' });
mountCallback({ slug: 'youtube', platform: Platform.YOUTUBE, label: 'YouTube' });
mountCallback({ slug: 'linkedin', platform: Platform.LINKEDIN, label: 'LinkedIn' });

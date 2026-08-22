/**
 * OAuth callback routes for ad platform integrations.
 *
 * Each platform's callback lands here after the user authorizes on the
 * provider's login page. The route validates the OAuth state (bound to one
 * client and one provider, single-use, time-limited), exchanges the
 * authorization code for tokens, validates those tokens with a real API call,
 * and discovers the accounts the user can manage. Nothing is marked CONNECTED
 * yet; the operator selects which accounts to attach on the next screen.
 */

import { Router } from 'express';
import { Platform } from '@prisma/client';

import { asyncHandler, badRequest } from '../lib/errors.js';
import { completeCallback } from '../services/integrations/connect-flow.js';
import { InvalidOAuthStateError } from '../services/integrations/oauth-state.js';

export const oauthCallbackRouter: Router = Router();

/**
 * Meta (Facebook, Instagram) OAuth callback.
 *
 * GET /api/integrations/meta/callback?state=...&code=...&error=...
 *
 * Meta redirects here after the user authorizes (or denies) the application.
 * The state proves which client and provider this callback belongs to.
 * The code is exchanged for an access token. The token is validated with a
 * real API call (/me), and all accessible accounts are discovered. None are
 * attached yet; the browser is redirected to a screen where the operator
 * selects which to use.
 *
 * If anything fails, the user is redirected to an error screen naming the
 * reason in plain language.
 */
oauthCallbackRouter.get(
  '/meta/callback',
  asyncHandler(async (req, res) => {
    const { state, code, error, error_description } = req.query as {
      state?: string;
      code?: string;
      error?: string;
      error_description?: string;
    };

    // Meta rejected the authorization request
    if (error) {
      const reason = error_description ? ` (${error_description})` : '';
      return res.redirect(
        `/integrations/connect-error?provider=meta&reason=${encodeURIComponent(`${error}${reason}`)}`
      );
    }

    // Missing required parameters
    if (!state) throw badRequest('Meta callback missing state parameter');
    if (!code) throw badRequest('Meta callback missing code parameter');

    try {
      const result = await completeCallback({
        platform: Platform.FACEBOOK,
        state: String(state),
        code: String(code),
        fetchImpl: fetch,
      });

      // Discovery succeeded. Redirect to account selection.
      // The frontend will fetch discovered accounts and let the operator choose.
      res.redirect(
        `/integrations/account-selection?integrationId=${encodeURIComponent(result.integrationId)}&clientId=${encodeURIComponent(result.clientId)}`
      );
    } catch (err) {
      if (err instanceof InvalidOAuthStateError) {
        // State validation failed: unknown, expired, replayed, or mismatched client/provider.
        // The error message is deliberately vague to the user so the callback endpoint
        // is not an oracle that reveals whether a state was issued or not.
        return res.redirect(
          `/integrations/connect-error?provider=meta&reason=${encodeURIComponent('The authorization could not be verified. Please start again.')}`
        );
      }

      // Provider API error (token exchange failed, validation failed, discovery failed)
      const message = (err as Error).message.slice(0, 200); // Truncate for URL safety
      res.redirect(
        `/integrations/connect-error?provider=meta&reason=${encodeURIComponent(`Connection failed: ${message}`)}`
      );
    }
  })
);

/**
 * Placeholder routes for other providers (Phase 2+).
 * These will follow the same pattern once each provider adapter is implemented.
 */

oauthCallbackRouter.get(
  '/google/callback',
  asyncHandler(async (_req, res) => {
    res.redirect(
      `/integrations/connect-error?provider=google&reason=${encodeURIComponent('Google Ads integration is not yet available. Check back soon.')}`
    );
  })
);

oauthCallbackRouter.get(
  '/tiktok/callback',
  asyncHandler(async (_req, res) => {
    res.redirect(
      `/integrations/connect-error?provider=tiktok&reason=${encodeURIComponent('TikTok integration is not yet available. Check back soon.')}`
    );
  })
);

oauthCallbackRouter.get(
  '/snapchat/callback',
  asyncHandler(async (_req, res) => {
    res.redirect(
      `/integrations/connect-error?provider=snapchat&reason=${encodeURIComponent('Snapchat integration is not yet available. Check back soon.')}`
    );
  })
);

oauthCallbackRouter.get(
  '/linkedin/callback',
  asyncHandler(async (_req, res) => {
    res.redirect(
      `/integrations/connect-error?provider=linkedin&reason=${encodeURIComponent('LinkedIn integration is not yet available. Check back soon.')}`
    );
  })
);

oauthCallbackRouter.get(
  '/x/callback',
  asyncHandler(async (_req, res) => {
    res.redirect(
      `/integrations/connect-error?provider=x&reason=${encodeURIComponent('X (Twitter) integration is not yet available. Check back soon.')}`
    );
  })
);

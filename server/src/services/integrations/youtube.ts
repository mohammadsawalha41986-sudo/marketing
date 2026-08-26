/**
 * YouTube, as a provider adapter — Google's OAuth, a YouTube-shaped grant.
 *
 * This file is deliberately thin. YouTube authorises through Google, so every
 * token operation here *is* `google.ts`: the same code exchange, the same
 * refresh, the same `ProviderApiError`, the same refusal of a token response
 * with no refresh token. Re-implementing any of that would give this deployment
 * two Google OAuth clients to keep in step, and the second one would be the one
 * nobody remembered to fix.
 *
 * Three things are genuinely YouTube's own, and they are all that is below.
 *
 * **The scope.** `youtube.upload` is what the publishing adapter in
 * `publishing/youtube.ts` needs, and it is not in the Business Profile grant.
 * Asking Google for a Business Profile scope and then uploading a video fails
 * at the upload with a 403 that reads like a broken connection rather than a
 * missing consent — which is exactly the class of defect this phase exists to
 * remove. `youtube.readonly` comes along because discovery has to list the
 * channels before an operator can choose one.
 *
 * **The asset.** A Google login administers channels, not accounts, so
 * discovery asks the Data API which channels this login owns. A channel is a
 * PROFILE rather than a PAGE, for the same reason a TikTok creator account is:
 * it is the identity itself, not something administered on a business's behalf.
 *
 * **The callback.** YouTube gets its own callback route and therefore its own
 * redirect URI, because the OAuth state is bound to one platform and the
 * callback route is what proves which provider actually redirected. Sharing
 * Business Profile's route would mean deriving the platform from the state
 * instead of checking the state against the route, which is the check itself.
 * The variable is optional: unset, `beginAuthorization` derives the URI from
 * APP_URL, and only the Google console entry has to match.
 */

import { Platform } from '@prisma/client';

import { ProviderNotConfiguredError } from './index.js';
import { ProviderApiError, type DiscoveredAccount, type FetchLike } from './meta.js';
import type { GoogleConfig } from './google.js';

const CHANNELS_API = 'https://www.googleapis.com/youtube/v3/channels';

/**
 * What this integration asks for.
 *
 * `youtube.upload` is the one the publisher cannot work without; Google grants
 * per-scope, so the caller checks what actually came back rather than assuming
 * the request was honoured.
 */
export const YOUTUBE_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
] as const;

export const UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';

/** Which variables YouTube needs beyond the Google client it shares. */
const REQUIRED = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as const;

/**
 * The Google OAuth client, pointed at YouTube's callback.
 *
 * `GOOGLE_REDIRECT_URI` is deliberately not read: it ends at Business Profile's
 * callback route, and redeeming a YouTube code there would fail the state's
 * platform binding. An empty `redirectUri` is the documented signal to
 * `beginAuthorization` that it should derive one from the request host.
 */
export function youtubeConfig(env: NodeJS.ProcessEnv = process.env): GoogleConfig {
  const missing = REQUIRED.filter((key) => !env[key]?.trim());
  if (missing.length > 0) throw new ProviderNotConfiguredError(Platform.YOUTUBE, 'YouTube', [...missing]);

  return {
    clientId: env.GOOGLE_CLIENT_ID!.trim(),
    clientSecret: env.GOOGLE_CLIENT_SECRET!.trim(),
    redirectUri: env.YOUTUBE_REDIRECT_URI?.trim() ?? '',
  };
}

export function youtubeConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return REQUIRED.every((key) => Boolean(env[key]?.trim()));
}

interface ChannelPayload {
  id?: string;
  snippet?: { title?: string; customUrl?: string; thumbnails?: Record<string, { url?: string }> };
}

/**
 * The channels this login owns.
 *
 * `mine=true` scopes the answer to the authorising account, so there is no way
 * for this call to return a channel the operator does not control. A login with
 * no channel is a real state — a Google account that has never created one —
 * and it surfaces as an empty selection list rather than an error, because the
 * fix is on YouTube's side, not this deployment's.
 */
export async function discoverAccounts(input: {
  accessToken: string;
  fetchImpl: FetchLike;
}): Promise<DiscoveredAccount[]> {
  const url = new URL(CHANNELS_API);
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('mine', 'true');
  url.searchParams.set('maxResults', '50');

  const response = await input.fetchImpl(url.toString(), {
    method: 'GET',
    headers: { authorization: `Bearer ${input.accessToken}` },
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  const error = payload.error as { message?: string } | undefined;
  if (error) {
    throw new ProviderApiError(
      Platform.YOUTUBE,
      response.status,
      `YouTube channels: ${error.message ?? 'YouTube rejected the request'}`,
    );
  }
  if (!response.ok) {
    throw new ProviderApiError(Platform.YOUTUBE, response.status, `YouTube channels: HTTP ${response.status}`);
  }

  const items = Array.isArray(payload.items) ? (payload.items as ChannelPayload[]) : [];

  return items
    .filter((item) => typeof item.id === 'string' && item.id.length > 0)
    .map((item) => ({
      // PROFILE, not PAGE: a channel is the identity itself.
      kind: 'PROFILE' as DiscoveredAccount['kind'],
      externalId: item.id!,
      name: item.snippet?.title ?? 'YouTube channel',
      username: item.snippet?.customUrl ?? undefined,
      // One credential covers every channel this login owns; YouTube has no
      // per-asset token to fetch, so the same token is carried through.
      accessToken: input.accessToken,
      metadata: { thumbnailUrl: item.snippet?.thumbnails?.default?.url ?? null },
    }));
}

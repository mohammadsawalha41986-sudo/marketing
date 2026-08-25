/**
 * TikTok, as a provider adapter — Login Kit v2 and the Content Posting API.
 *
 * Shaped deliberately like `meta.ts`: config, authorization URL, code exchange,
 * token validation, account discovery. `connect-flow.ts` dispatches to one or
 * the other, so the connection lifecycle — signed state, encrypted tokens,
 * operator-chosen accounts, tenant isolation — is the existing one and not a
 * second implementation of it.
 *
 * Two things about TikTok that shape everything below.
 *
 * First, TikTok has no notion of a "page" a user administers. The credential
 * *is* the creator's own account, so discovery returns exactly one account
 * carrying the same token the exchange produced. There is no per-asset token to
 * fetch, and no equivalent of Meta's Page-token step.
 *
 * Second, and this is the honest limit of the integration: TikTok gates direct
 * posting on app audit. An unaudited client may only post to the creator's own
 * private view, and the set of privacy levels the creator can actually use is
 * not knowable from configuration — it must be read back per creator from
 * `creator_info/query`. So this adapter reads it rather than assuming, and the
 * publisher refuses a privacy level the creator's own account does not offer
 * instead of sending one TikTok will reject.
 */

import { Platform } from '@prisma/client';

import { ProviderNotConfiguredError } from './index.js';
import { ProviderApiError, type DiscoveredAccount, type FetchLike, type TokenSet } from './meta.js';

const AUTHORIZE = 'https://www.tiktok.com/v2/auth/authorize/';
const API = 'https://open.tiktokapis.com/v2';

/**
 * What the integration asks for.
 *
 * `video.publish` is what makes a direct post possible; `video.upload` alone
 * puts the video in the creator's drafts, which is a different product. Both
 * are requested because TikTok grants per-scope and the publisher checks which
 * one actually came back rather than assuming the request was honoured.
 */
export const TIKTOK_SCOPES = ['user.info.basic', 'video.publish', 'video.upload'] as const;
export const PUBLISH_SCOPE = 'video.publish';

export interface TikTokConfig {
  clientKey: string;
  clientSecret: string;
  redirectUri: string;
}

export function tiktokConfig(env: NodeJS.ProcessEnv = process.env): TikTokConfig {
  const missing = (['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET', 'TIKTOK_REDIRECT_URI'] as const).filter(
    (key) => !env[key]?.trim(),
  );
  if (missing.length > 0) throw new ProviderNotConfiguredError(Platform.TIKTOK, 'TikTok', missing);

  // Trimmed on the way in, for the same reason Meta's are: these are pasted by
  // hand into a hosting dashboard, and a trailing newline is invisible in every
  // UI that edits them but fatal in an OAuth parameter.
  return {
    clientKey: env.TIKTOK_CLIENT_KEY!.trim(),
    clientSecret: env.TIKTOK_CLIENT_SECRET!.trim(),
    redirectUri: env.TIKTOK_REDIRECT_URI!.trim(),
  };
}

/** Whether TikTok is configured at all, without throwing. For diagnostics. */
export function tiktokConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return (['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET', 'TIKTOK_REDIRECT_URI'] as const).every(
    (key) => Boolean(env[key]?.trim()),
  );
}

export function authorizationUrl(input: { config: TikTokConfig; state: string }): string {
  const url = new URL(AUTHORIZE);
  // TikTok names it client_key, not client_id. Sending client_id returns an
  // error page that does not mention the parameter name.
  url.searchParams.set('client_key', input.config.clientKey);
  url.searchParams.set('scope', TIKTOK_SCOPES.join(','));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', input.config.redirectUri);
  url.searchParams.set('state', input.state);
  return url.toString();
}

/**
 * TikTok reports failure in-band: HTTP 200 with an `error` object whose `code`
 * is something other than "ok". Trusting the status alone is how a rejected
 * call gets treated as a success with empty data.
 */
async function readJson(
  response: Awaited<ReturnType<FetchLike>>,
  context: string,
): Promise<Record<string, unknown>> {
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  const error = payload.error as { code?: string; message?: string } | undefined;
  if (error && error.code && error.code !== 'ok') {
    throw new ProviderApiError(
      Platform.TIKTOK,
      response.status,
      `${context}: ${error.message ?? error.code}`,
    );
  }

  if (!response.ok) {
    throw new ProviderApiError(Platform.TIKTOK, response.status, `${context}: HTTP ${response.status}`);
  }
  return payload;
}

export async function exchangeCode(input: {
  config: TikTokConfig;
  code: string;
  fetchImpl: FetchLike;
  now?: Date;
}): Promise<TokenSet> {
  const now = input.now ?? new Date();

  // Form-encoded, not JSON. TikTok's token endpoint rejects a JSON body.
  const body = new URLSearchParams({
    client_key: input.config.clientKey,
    client_secret: input.config.clientSecret,
    code: input.code,
    grant_type: 'authorization_code',
    redirect_uri: input.config.redirectUri,
  });

  const payload = await readJson(
    await input.fetchImpl(`${API}/oauth/token/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }),
    'TikTok token exchange',
  );

  const accessToken = payload.access_token as string | undefined;
  if (!accessToken) {
    throw new ProviderApiError(Platform.TIKTOK, 502, 'TikTok token exchange returned no access token');
  }

  const expiresIn = payload.expires_in as number | undefined;
  const scope = payload.scope as string | undefined;

  return {
    accessToken,
    // TikTok access tokens are short-lived and always come with a refresh
    // token; storing it is what makes a reconnect unnecessary later.
    refreshToken: (payload.refresh_token as string | undefined) ?? null,
    expiresAt: typeof expiresIn === 'number' ? new Date(now.getTime() + expiresIn * 1000) : null,
    // The grant, not the request — TikTok grants per scope and the publisher
    // reads this to decide whether it may direct-post at all.
    scopes: scope ? scope.split(',').map((entry) => entry.trim()).filter(Boolean) : [],
  };
}

export interface TikTokIdentity {
  id: string;
  name: string;
  username?: string;
  avatarUrl?: string;
}

/** The connection is only real once TikTok answers with this token. */
export async function validateToken(input: {
  accessToken: string;
  fetchImpl: FetchLike;
}): Promise<TikTokIdentity> {
  const url = new URL(`${API}/user/info/`);
  url.searchParams.set('fields', 'open_id,union_id,display_name,avatar_url,username');

  const payload = await readJson(
    await input.fetchImpl(url.toString(), {
      method: 'GET',
      headers: { authorization: `Bearer ${input.accessToken}` },
    }),
    'TikTok token validation',
  );

  const user = (payload.data as { user?: Record<string, unknown> } | undefined)?.user;
  const openId = user?.open_id as string | undefined;
  if (!openId) {
    throw new ProviderApiError(Platform.TIKTOK, 502, 'TikTok token validation returned no open_id');
  }

  return {
    id: openId,
    name: (user?.display_name as string | undefined) ?? 'TikTok creator',
    username: user?.username as string | undefined,
    avatarUrl: user?.avatar_url as string | undefined,
  };
}

/**
 * What the creator's own account allows, read back rather than assumed.
 *
 * This is the call that makes an honest publish possible. It reports the
 * privacy levels this creator may actually use — an unaudited app sees only
 * SELF_ONLY — along with the interaction toggles their account disables and the
 * maximum video duration. Guessing any of these produces a post TikTok rejects
 * at the last step, after the bytes have already been uploaded.
 */
export interface TikTokCreatorInfo {
  nickname: string;
  privacyOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoPostDurationSec: number | null;
}

export async function creatorInfo(input: {
  accessToken: string;
  fetchImpl: FetchLike;
}): Promise<TikTokCreatorInfo> {
  const payload = await readJson(
    await input.fetchImpl(`${API}/post/publish/creator_info/query/`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        'content-type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({}),
    }),
    'TikTok creator info',
  );

  const data = (payload.data ?? {}) as Record<string, unknown>;
  const options = Array.isArray(data.privacy_level_options)
    ? (data.privacy_level_options as unknown[]).map(String)
    : [];

  return {
    nickname: (data.creator_nickname as string | undefined) ?? 'TikTok creator',
    privacyOptions: options,
    commentDisabled: Boolean(data.comment_disabled),
    duetDisabled: Boolean(data.duet_disabled),
    stitchDisabled: Boolean(data.stitch_disabled),
    maxVideoPostDurationSec:
      typeof data.max_video_post_duration_sec === 'number' ? data.max_video_post_duration_sec : null,
  };
}

/**
 * The creator's own account, as the one discoverable asset.
 *
 * Returned with the same token the exchange produced, because on TikTok there
 * is no second credential to fetch: the account that authorised is the account
 * that posts. `connect-flow` encrypts it before it reaches the database, the
 * same way it does a Facebook Page token.
 */
export async function discoverAccounts(input: {
  accessToken: string;
  fetchImpl: FetchLike;
}): Promise<DiscoveredAccount[]> {
  const identity = await validateToken(input);

  return [
    {
      // PROFILE rather than PAGE: a TikTok creator account is not administered
      // on behalf of a business the way a Page is, and the existing enum
      // already carries the right word for it.
      kind: 'PROFILE' as DiscoveredAccount['kind'],
      externalId: identity.id,
      name: identity.name,
      username: identity.username,
      accessToken: input.accessToken,
      metadata: { avatarUrl: identity.avatarUrl ?? null },
    },
  ];
}

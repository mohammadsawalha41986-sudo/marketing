/**
 * Instagram API with Instagram Login — the connection that needs no Facebook Page.
 *
 * This is a different product from the Meta connection in `meta.ts`, not a
 * variation of it, and the difference is the whole point: a restaurant whose
 * Instagram Professional account was never linked to a Facebook Page cannot
 * complete Facebook Login for Business, and every Page-derived call fails for
 * it. Instagram Login authorises the Instagram account directly, issues a token
 * scoped to that account, and is served from `graph.instagram.com` rather than
 * `graph.facebook.com`.
 *
 * Three facts about this flow that the code below exists to respect:
 *
 * **The short-lived token is not the one to keep.** `POST /oauth/access_token`
 * returns a token valid for about an hour. Storing it would produce a
 * connection that works during testing and is dead the next morning, so it is
 * immediately exchanged for the 60-day long-lived token, and only that is
 * returned to the caller for encryption.
 *
 * **The grant comes back with the token.** The exchange response carries
 * `permissions`, so there is no second call to ask what was granted — and no
 * reason to record the request instead of the grant.
 *
 * **The credential is the account.** There is no Page token to fetch and no
 * asset list to walk: the login *is* one Instagram Professional account. So
 * discovery returns exactly one account, carrying that same token, which is
 * what lets the existing publisher post through it unchanged.
 *
 * Everything else — state, encryption, tenant binding, account selection —
 * belongs to `connect-flow.ts` and is deliberately not repeated here.
 */

import { Platform } from '@prisma/client';

import { ProviderNotConfiguredError } from './index.js';
import { ProviderApiError, type DiscoveredAccount, type FetchLike, type TokenSet } from './meta.js';

/** Instagram's own Graph host. A Facebook-issued token does not work here, and
 *  an Instagram-issued one does not work on graph.facebook.com. */
export const INSTAGRAM_GRAPH_VERSION = process.env.INSTAGRAM_GRAPH_VERSION ?? 'v23.0';
export const INSTAGRAM_GRAPH = `https://graph.instagram.com/${INSTAGRAM_GRAPH_VERSION}`;
const AUTHORIZE = 'https://www.instagram.com/oauth/authorize';
const TOKEN = 'https://api.instagram.com/oauth/access_token';
const LONG_LIVED = 'https://graph.instagram.com/access_token';
const REFRESH = 'https://graph.instagram.com/refresh_access_token';

/**
 * What this connection asks for.
 *
 * Basic identity, publishing, and the insights the analytics layer already
 * knows how to read. Messaging and comment moderation are deliberately absent:
 * nothing in this application uses them, and a consent screen that asks for a
 * permission the product never exercises is asking the operator to grant access
 * for nothing.
 */
export const INSTAGRAM_SCOPES = [
  'instagram_business_basic',
  'instagram_business_content_publish',
  'instagram_business_manage_insights',
] as const;

/** The one grant that decides whether the attached account can post. */
export const PUBLISH_SCOPE = 'instagram_business_content_publish';
/** The grant behind organic post insights. */
export const INSIGHTS_SCOPE = 'instagram_business_manage_insights';

/**
 * Recorded on the discovered account so everything downstream can tell the two
 * Instagram connections apart.
 *
 * A publisher holding a token cannot infer which host issued it, and calling
 * the wrong one fails with an error that names neither. `IntegrationAccount`
 * already carries a metadata object for exactly this kind of provider-shaped
 * fact, so the marker rides there rather than in a new column.
 */
export const INSTAGRAM_LOGIN_API = 'instagram_login';

export function isInstagramLoginAccount(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  return (metadata as { api?: unknown }).api === INSTAGRAM_LOGIN_API;
}

/**
 * Which Graph host serves this account.
 *
 * The default is Meta's, because an account discovered through the Facebook
 * connection — every account that existed before this module — is a Page-linked
 * Instagram account whose token is a Page token.
 */
export function instagramGraphBase(metadata: unknown, version: string): string {
  return isInstagramLoginAccount(metadata)
    ? `https://graph.instagram.com/${version}`
    : `https://graph.facebook.com/${version}`;
}

export interface InstagramConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
}

const REQUIRED = ['INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET', 'INSTAGRAM_REDIRECT_URI'] as const;

/**
 * The Instagram app's own credentials.
 *
 * Separate variables from Meta's on purpose. In the Meta console this is a
 * distinct product with its own Instagram app id and secret, and the redirect
 * URI is registered against that product rather than against Facebook Login —
 * reusing `META_APP_ID` here would send an operator to debug a Facebook app for
 * an Instagram failure.
 */
export function instagramConfig(env: NodeJS.ProcessEnv = process.env): InstagramConfig {
  const missing = REQUIRED.filter((key) => !env[key]?.trim());
  if (missing.length > 0) {
    throw new ProviderNotConfiguredError(Platform.INSTAGRAM, 'Instagram', [...missing]);
  }

  // Trimmed on the way in, as every other adapter does: these are pasted into a
  // hosting dashboard by hand, and a trailing newline is invisible in the UI
  // that edits them while being fatal in an OAuth parameter.
  return {
    appId: env.INSTAGRAM_APP_ID!.trim(),
    appSecret: env.INSTAGRAM_APP_SECRET!.trim(),
    redirectUri: env.INSTAGRAM_REDIRECT_URI!.trim(),
  };
}

/** Whether Instagram is configured at all, without throwing. For diagnostics. */
export function instagramConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return REQUIRED.every((key) => Boolean(env[key]?.trim()));
}

export function authorizationUrl(input: { config: InstagramConfig; state: string }): string {
  const url = new URL(AUTHORIZE);
  url.searchParams.set('client_id', input.config.appId);
  url.searchParams.set('redirect_uri', input.config.redirectUri);
  url.searchParams.set('response_type', 'code');
  // Instagram takes a comma-separated list, unlike the space-separated OAuth
  // convention Google and LinkedIn use.
  url.searchParams.set('scope', INSTAGRAM_SCOPES.join(','));
  url.searchParams.set('state', input.state);
  return url.toString();
}

interface JsonResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

/**
 * Read one Instagram response, or raise with what it actually said.
 *
 * Instagram reports failures two ways — an `error` object like the rest of the
 * Graph API, and a flat `error_type`/`error_message` pair on the OAuth
 * endpoints. Both are surfaced; neither ever carries the credential that was
 * sent, because the message is built from the provider's fields rather than
 * from the request.
 */
async function readJson(response: JsonResponse, context: string): Promise<Record<string, unknown>> {
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    const graphError = payload.error as { message?: string } | undefined;
    const flat = typeof payload.error_message === 'string' ? payload.error_message : undefined;
    const detail = graphError?.message ?? flat;
    throw new ProviderApiError(
      Platform.INSTAGRAM,
      response.status,
      detail ? `${context}: ${detail}` : `${context}: Instagram returned HTTP ${response.status}`,
    );
  }
  return payload;
}

const expiryFrom = (seconds: unknown, now: Date): Date | null =>
  typeof seconds === 'number' && Number.isFinite(seconds)
    ? new Date(now.getTime() + seconds * 1000)
    : null;

/** `permissions` comes back as a comma-separated string, or occasionally a list. */
function grantedFrom(payload: Record<string, unknown>): string[] {
  const raw = payload.permissions;
  if (Array.isArray(raw)) return raw.filter((entry): entry is string => typeof entry === 'string');
  if (typeof raw === 'string') return raw.split(',').map((entry) => entry.trim()).filter(Boolean);
  return [];
}

/**
 * Authorization code → the long-lived token, in two calls.
 *
 * The short-lived token exists only inside this function. Returning it would
 * hand `connect-flow` an hour-long credential to encrypt and store, and the
 * connection would read CONNECTED long after it had stopped working.
 */
export async function exchangeCode(input: {
  config: InstagramConfig;
  code: string;
  fetchImpl: FetchLike;
  now?: Date;
}): Promise<TokenSet> {
  const now = input.now ?? new Date();

  const shortLived = await readJson(
    await input.fetchImpl(TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: input.config.appId,
        client_secret: input.config.appSecret,
        grant_type: 'authorization_code',
        redirect_uri: input.config.redirectUri,
        code: input.code,
      }).toString(),
    }),
    'Instagram code exchange',
  );

  const shortToken = shortLived.access_token;
  if (typeof shortToken !== 'string' || shortToken.length === 0) {
    throw new ProviderApiError(Platform.INSTAGRAM, 502, 'Instagram code exchange returned no access token');
  }
  const granted = grantedFrom(shortLived);

  const exchange = new URL(LONG_LIVED);
  exchange.searchParams.set('grant_type', 'ig_exchange_token');
  exchange.searchParams.set('client_secret', input.config.appSecret);
  exchange.searchParams.set('access_token', shortToken);

  const longLived = await readJson(
    await input.fetchImpl(exchange.toString(), { method: 'GET' }),
    'Instagram long-lived token exchange',
  );

  const accessToken = longLived.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new ProviderApiError(Platform.INSTAGRAM, 502, 'Instagram returned no long-lived access token');
  }

  return {
    accessToken,
    // Instagram has no refresh token: a long-lived token is re-exchanged
    // against itself, which is what `refreshAccessToken` below does.
    refreshToken: null,
    expiresAt: expiryFrom(longLived.expires_in, now),
    scopes: granted,
  };
}

/**
 * Extend a long-lived token before it expires.
 *
 * Instagram's long-lived token lasts 60 days and can be refreshed with itself
 * once it is at least 24 hours old — there is no separate refresh credential,
 * which is why `TokenSet.refreshToken` is null and this takes the access token.
 */
export async function refreshAccessToken(input: {
  accessToken: string;
  fetchImpl: FetchLike;
  now?: Date;
}): Promise<{ accessToken: string; expiresAt: Date | null }> {
  const now = input.now ?? new Date();
  const url = new URL(REFRESH);
  url.searchParams.set('grant_type', 'ig_refresh_token');
  url.searchParams.set('access_token', input.accessToken);

  const payload = await readJson(
    await input.fetchImpl(url.toString(), { method: 'GET' }),
    'Instagram token refresh',
  );

  const accessToken = payload.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new ProviderApiError(Platform.INSTAGRAM, 502, 'Instagram token refresh returned no access token');
  }
  return { accessToken, expiresAt: expiryFrom(payload.expires_in, now) };
}

interface InstagramProfile {
  id?: string;
  user_id?: string;
  username?: string;
  name?: string;
  account_type?: string;
  profile_picture_url?: string;
}

async function profile(input: { accessToken: string; fetchImpl: FetchLike }): Promise<InstagramProfile> {
  const url = new URL(`${INSTAGRAM_GRAPH}/me`);
  url.searchParams.set('fields', 'user_id,username,name,account_type,profile_picture_url');
  url.searchParams.set('access_token', input.accessToken);

  return (await readJson(
    await input.fetchImpl(url.toString(), { method: 'GET' }),
    'Instagram profile',
  )) as InstagramProfile;
}

/**
 * Prove the token works, and say whose account it is.
 *
 * `user_id` is the Instagram Professional account id the publishing and
 * insights endpoints are addressed by; `id` is returned by older versions of
 * the same endpoint. Either is accepted, neither is invented — a response
 * carrying no id at all fails the connection rather than attaching an account
 * nothing can be posted to.
 */
export async function validateToken(input: {
  accessToken: string;
  fetchImpl: FetchLike;
}): Promise<{ id: string; name: string }> {
  const me = await profile(input);
  const id = me.user_id ?? me.id;
  if (!id) {
    throw new ProviderApiError(Platform.INSTAGRAM, 502, 'Instagram returned no account id for this login');
  }
  return { id: String(id), name: me.username ?? me.name ?? 'Instagram account' };
}

/**
 * The one account this login is.
 *
 * It carries the same token as the integration, because with Instagram Login
 * the account token *is* the login token — unlike Meta, where a Page has its
 * own credential. Handing it to the account row is what lets the existing
 * publisher work through this connection without a second code path.
 */
export async function discoverAccounts(input: {
  accessToken: string;
  fetchImpl: FetchLike;
}): Promise<DiscoveredAccount[]> {
  const me = await profile(input);
  const id = me.user_id ?? me.id;
  if (!id) return [];

  return [
    {
      kind: 'INSTAGRAM',
      externalId: String(id),
      name: me.username ?? me.name ?? 'Instagram account',
      username: me.username,
      accessToken: input.accessToken,
      metadata: {
        api: INSTAGRAM_LOGIN_API,
        accountType: me.account_type ?? null,
        profilePictureUrl: me.profile_picture_url ?? null,
      },
    },
  ];
}

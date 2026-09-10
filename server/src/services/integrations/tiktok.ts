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
/*
 * `video.list` is what `video/query` needs in order to read a published
 * video's like, comment, share and view counts. It is requested alongside the
 * publishing scopes rather than in a second consent trip, and because TikTok
 * grants per scope, a creator who declines it still connects and still
 * publishes — metric ingestion reports MISSING_PERMISSION and everything else
 * carries on. Metrics are not worth breaking a publish over.
 */
export const TIKTOK_SCOPES = ['user.info.basic', 'video.publish', 'video.upload', 'video.list'] as const;
export const PUBLISH_SCOPE = 'video.publish';
/** What reading a published video's statistics requires. */
export const METRICS_SCOPE = 'video.list';

export interface TikTokConfig {
  clientKey: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * What a TikTok client key looks like — for *reporting*, not for refusing.
 *
 * The keys TikTok issues are alphanumeric, but this is an opaque identifier
 * whose format is the provider's to change, and a rule tighter than the format
 * warrants would refuse a legitimate key with total confidence. So an unusual
 * charset is reported in diagnostics and never blocks a connection. The
 * separate check below refuses only what cannot be a credential at all.
 */
const CLIENT_KEY_FORMAT = /^[A-Za-z0-9_-]{4,64}$/;

/**
 * Characters that mean the value was pasted wrong, not that the key is unusual.
 *
 * An interior space, a quote or a line break cannot be part of any identifier:
 * they arrive from copying a `.env` line or a rendered page, they survive
 * `.trim()`, and they reach TikTok percent-encoded — which is reported as an
 * invalid `client_key` with no mention of a quote.
 */
const IMPOSSIBLE_IN_CREDENTIAL = /["'\s]/;

/**
 * Sandbox keys are a different app.
 *
 * TikTok issues a separate key for an application's sandbox, prefixed `sbaw`,
 * and the live authorization endpoint does not accept it — it answers with the
 * same "correct the following: client_key" page as a key that does not exist.
 * Worth naming, because the two keys sit side by side in the same console.
 */
const SANDBOX_PREFIX = 'sbaw';

/**
 * Strip what a hosting dashboard adds and a person cannot see.
 *
 * `.trim()` alone is not enough. A value pasted from a `.env` line arrives
 * wrapped in quotes, and quotes survive trimming — `client_key="aw…"` is then
 * sent to TikTok with the quote characters percent-encoded into it. Zero-width
 * and control characters come the same way, from copying out of a rendered web
 * page rather than an input field.
 */
function normalizeCredential(raw: string | undefined): string {
  if (!raw) return '';
  // eslint-disable-next-line no-control-regex
  const stripped = raw.replace(/[\u0000-\u001f\u007f\u200b-\u200f\ufeff]/g, '').trim();
  const unquoted = /^(["']).*\1$/.test(stripped) ? stripped.slice(1, -1).trim() : stripped;
  return unquoted;
}

export function tiktokConfig(env: NodeJS.ProcessEnv = process.env): TikTokConfig {
  const missing = (['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET', 'TIKTOK_REDIRECT_URI'] as const).filter(
    (key) => !normalizeCredential(env[key]),
  );
  if (missing.length > 0) throw new ProviderNotConfiguredError(Platform.TIKTOK, 'TikTok', missing);

  const clientKey = normalizeCredential(env.TIKTOK_CLIENT_KEY);

  /*
   * Refuse a malformed client key here rather than at TikTok.
   *
   * TikTok's login page answers with "correct the following: client_key" and
   * nothing else — no mention of which of our variables carries it, and only
   * after the operator has already been redirected away. The common way to get
   * there is pasting the right value with the wrong characters around it.
   *
   * The value never appears in the message. It is not the secret, but the two
   * sit next to each other in the same console and echoing either one trains
   * everybody to expect credentials in error text.
   */
  if (IMPOSSIBLE_IN_CREDENTIAL.test(clientKey)) {
    throw new ProviderNotConfiguredError(Platform.TIKTOK, 'TikTok', ['TIKTOK_CLIENT_KEY'], {
      detail:
        'TIKTOK_CLIENT_KEY carries a quote, a space or a line break inside the value, which no client key '
        + 'contains. Re-paste it from the TikTok developer console without the surrounding quotes.',
    });
  }

  // Trimmed on the way in, for the same reason Meta's are: these are pasted by
  // hand into a hosting dashboard, and a trailing newline is invisible in every
  // UI that edits them but fatal in an OAuth parameter.
  return {
    clientKey,
    clientSecret: normalizeCredential(env.TIKTOK_CLIENT_SECRET),
    redirectUri: normalizeCredential(env.TIKTOK_REDIRECT_URI),
  };
}

/** Whether TikTok is configured at all, without throwing. For diagnostics. */
export function tiktokConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return (['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET', 'TIKTOK_REDIRECT_URI'] as const).every(
    (key) => Boolean(normalizeCredential(env[key])),
  );
}

/**
 * Enough of a credential to recognise it, never enough to use it.
 *
 * First three and last three characters. A TikTok client key is checkable
 * against the console at a glance from that much, and an operator comparing
 * "what the server holds" against "what the console shows" needs nothing more.
 */
export function redactCredential(value: string): string {
  if (value.length === 0) return 'unset';
  if (value.length < 8) return '***';
  return `${value.slice(0, 3)}…${value.slice(-3)}`;
}

/** The callback path a TikTok redirect URI has to end at. */
const CALLBACK_PATH = '/api/integrations/tiktok/callback';

/**
 * What can be said about the TikTok configuration without saying any of it.
 *
 * Every field is a shape or a verdict, which is what makes it safe to log at
 * boot: an operator whose login was refused needs to know whether the server
 * holds the key they think it does, whether anything invisible rode along with
 * it, and whether it is the sandbox key — and never needs the value.
 */
export interface TikTokConfigDiagnostics {
  clientKeyConfigured: boolean;
  clientKeyLength: number;
  /** First three and last three characters, or `unset`. */
  clientKeyRedacted: string;
  clientKeyCharsetValid: boolean;
  /** True when the raw variable carried quotes, whitespace or invisible characters. */
  clientKeyNeededCleaning: boolean;
  /** True for a key issued to the application's sandbox, which cannot log in live. */
  clientKeyLooksSandbox: boolean;
  clientSecretConfigured: boolean;
  redirectUriConfigured: boolean;
  /** True when the redirect URI ends at the callback route that is mounted. */
  redirectUriPathValid: boolean;
  /** True when everything needed to build an authorization URL is present and sane. */
  valid: boolean;
}

export function tiktokConfigDiagnostics(env: NodeJS.ProcessEnv = process.env): TikTokConfigDiagnostics {
  const rawKey = env.TIKTOK_CLIENT_KEY ?? '';
  const clientKey = normalizeCredential(rawKey);
  const redirectUri = normalizeCredential(env.TIKTOK_REDIRECT_URI);

  const clientKeyConfigured = clientKey.length > 0;
  // A warning, not a verdict: an unfamiliar shape is worth reporting and never
  // worth refusing a connection over.
  const clientKeyCharsetValid = CLIENT_KEY_FORMAT.test(clientKey);
  const clientSecretConfigured = normalizeCredential(env.TIKTOK_CLIENT_SECRET).length > 0;
  const redirectUriConfigured = redirectUri.length > 0;

  let redirectUriPathValid = false;
  if (redirectUriConfigured) {
    try {
      redirectUriPathValid = new URL(redirectUri).pathname.endsWith(CALLBACK_PATH);
    } catch {
      redirectUriPathValid = false;
    }
  }

  return {
    clientKeyConfigured,
    // A length is not a value, and it is the one number that separates "pasted
    // the secret" from "pasted the key" without revealing either.
    clientKeyLength: clientKey.length,
    clientKeyRedacted: redactCredential(clientKey),
    clientKeyCharsetValid,
    clientKeyNeededCleaning: clientKeyConfigured && rawKey !== clientKey,
    clientKeyLooksSandbox: clientKey.toLowerCase().startsWith(SANDBOX_PREFIX),
    clientSecretConfigured,
    redirectUriConfigured,
    redirectUriPathValid,
    valid:
      clientKeyConfigured && !IMPOSSIBLE_IN_CREDENTIAL.test(clientKey) && clientSecretConfigured
      && redirectUriConfigured && redirectUriPathValid,
  };
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

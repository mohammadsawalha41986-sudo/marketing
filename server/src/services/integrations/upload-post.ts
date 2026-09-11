/**
 * Upload-Post, as a provider adapter — one API, many networks.
 *
 * Every other adapter in this directory speaks to the network it publishes to.
 * This one does not: Upload-Post is a *fan-out* service that holds the
 * operator's TikTok, Instagram, Facebook, LinkedIn, X, YouTube and Google
 * Business connections on their behalf and publishes to them from a single
 * call. That difference shapes everything below.
 *
 * **There is no OAuth here, and no per-client credential.** The deployment
 * holds one API key (`UPLOAD_POST_API_KEY`) and every request is authorised
 * with it. What is per-client is the *profile*: Upload-Post calls them users,
 * each one owns its own set of linked social accounts, and a restaurant's
 * accounts live under a profile named for that restaurant and no other. The
 * operator links accounts on Upload-Post's own hosted page, reached through a
 * short-lived JWT this module mints for exactly one profile.
 *
 * So the tenant boundary is the profile name, and it is derived from the client
 * id rather than chosen — see `profileUsernameFor`. A profile name that could
 * collide across clients, or be supplied by a caller, would be one restaurant's
 * Instagram account publishing another restaurant's posts.
 *
 * **The API key never leaves this process.** It is read from the environment
 * inside this module, attached to the request, and never returned, logged, or
 * serialised into an error — `describeError` reads only the provider's own
 * message. The browser is given a connection URL and a profile name; it is
 * never given anything it could authenticate with.
 *
 * Wire format verified against the official clients (`upload-post` on npm
 * v2.14.0 and `upload-post` on PyPI), which are the normative description of
 * the HTTP surface:
 *
 *   base            https://api.upload-post.com/api
 *   authorisation   `Authorization: Apikey <key>`
 *   uploads         multipart/form-data, platforms repeated as `platform[]`
 *   media           a file part, or an https URL sent as a plain field
 *   idempotency     `Idempotency-Key` header, collapsing duplicates for 24h
 *
 * Nothing here is guessed. A field this module does not know the exact name of
 * is a field this module does not send.
 */

import { Platform } from '@prisma/client';

import { ProviderNotConfiguredError } from './index.js';
import type { DiscoveredAccount, DiscoveryResult, FetchLike } from './meta.js';

const BASE_URL = 'https://api.upload-post.com/api';

/** The one variable this integration needs. Named in every refusal. */
const API_KEY_VARIABLE = 'UPLOAD_POST_API_KEY';

export interface UploadPostConfig {
  apiKey: string;
}

export function uploadPostConfig(env: NodeJS.ProcessEnv = process.env): UploadPostConfig {
  const apiKey = env[API_KEY_VARIABLE]?.trim();
  if (!apiKey) {
    throw new ProviderNotConfiguredError(Platform.UPLOAD_POST, 'Upload-Post', [API_KEY_VARIABLE]);
  }
  // Trimmed on the way in, as every other provider's credentials are: these are
  // pasted into a hosting dashboard by hand, and a trailing newline is
  // invisible in the UI that edits them while being fatal in an HTTP header.
  return { apiKey };
}

/** Whether Upload-Post is configured at all, without throwing. For diagnostics. */
export function uploadPostConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[API_KEY_VARIABLE]?.trim());
}

// ------------------------------------------------------------- platform map

/**
 * Upload-Post's platform identifiers, for the networks NORIVA publishes to.
 *
 * Deliberately a partial map. Upload-Post reaches twenty-odd networks; these
 * are the ones this product already models as a `Platform`, and a network with
 * no entry is one this application cannot route — which is a refusal, not a
 * silent no-op.
 *
 * `SNAPCHAT` and `GOOGLE_ADS` have no entry and never will: Upload-Post does
 * not publish to Snapchat, and Google Ads is advertising rather than an organic
 * posting surface. `UPLOAD_POST` itself has none because it is the route, not a
 * destination.
 */
const UPLOAD_POST_PLATFORM: Partial<Record<Platform, string>> = {
  [Platform.FACEBOOK]: 'facebook',
  [Platform.INSTAGRAM]: 'instagram',
  [Platform.TIKTOK]: 'tiktok',
  [Platform.LINKEDIN]: 'linkedin',
  [Platform.YOUTUBE]: 'youtube',
  [Platform.X]: 'x',
  [Platform.GOOGLE_BUSINESS]: 'google_business',
};

/** The reverse map, built once, so the two can never disagree. */
const PLATFORM_BY_UPLOAD_POST = new Map<string, Platform>(
  Object.entries(UPLOAD_POST_PLATFORM).map(([platform, slug]) => [slug, platform as Platform]),
);

/** What Upload-Post calls this network, or null when it cannot reach it. */
export function uploadPostPlatform(platform: Platform): string | null {
  return UPLOAD_POST_PLATFORM[platform] ?? null;
}

/** What this application calls one of Upload-Post's networks, when it models it. */
export function platformForUploadPost(slug: string): Platform | null {
  return PLATFORM_BY_UPLOAD_POST.get(slug.trim().toLowerCase()) ?? null;
}

/** Every network a NORIVA post can be routed through Upload-Post to. */
export function routablePlatforms(): Platform[] {
  return Object.keys(UPLOAD_POST_PLATFORM) as Platform[];
}

// ---------------------------------------------------------------- profiles

/**
 * The Upload-Post profile that belongs to one restaurant, and only that one.
 *
 * Derived, never chosen. Upload-Post profile names are a flat namespace under
 * one API key, so two restaurants that could be given the same name would share
 * a set of linked social accounts — one brand's Instagram publishing another
 * brand's posts, with nothing in either system saying so. The client id is
 * already globally unique and already the tenant boundary everywhere else in
 * this application, so it is the name.
 *
 * The prefix exists so that a profile list read in Upload-Post's own dashboard
 * is legible as this deployment's, rather than a wall of bare ids.
 */
export function profileUsernameFor(clientId: string): string {
  return `noriva-${clientId}`;
}

/** Whether a profile name belongs to this deployment at all. */
export function isNorivaProfile(username: string): boolean {
  return username.startsWith('noriva-');
}

// ------------------------------------------------------------------ errors

/**
 * Why a call failed, in terms that decide what happens next.
 *
 * The split that matters is between "this will fail identically forever" and
 * "this would very likely work in a minute": the publishing service retries one
 * and hands the other to a person. Getting it wrong in either direction is
 * expensive — a retried permanent failure burns rate limit and buries the real
 * cause; a permanent-classified blip loses a post that would have gone out.
 */
export type UploadPostFailure =
  | 'NOT_CONFIGURED'
  | 'INVALID_KEY'
  | 'PROFILE_NOT_FOUND'
  | 'ACCOUNT_NOT_LINKED'
  | 'INVALID_MEDIA'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'INVALID_REQUEST';

export function classifyUploadPostError(message: string, status: number): UploadPostFailure {
  const text = message.toLowerCase();

  if (/invalid.?api.?key|unauthori[sz]ed|authentication failed/.test(text) || status === 401) {
    return 'INVALID_KEY';
  }
  if (/profile.?not.?found|user.?not.?found|unknown user/.test(text)) return 'PROFILE_NOT_FOUND';
  if (/not.?(linked|connected)|no.?(linked|connected).?account|missing.?connection/.test(text)) {
    return 'ACCOUNT_NOT_LINKED';
  }
  if (/media|video|image|file|format|duration|aspect|too large/.test(text)) return 'INVALID_MEDIA';
  if (/quota|rate.?limit|too many requests/.test(text) || status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'PROVIDER_UNAVAILABLE';
  if (status === 403) return 'ACCOUNT_NOT_LINKED';
  return 'INVALID_REQUEST';
}

/** What an operator should be told, per failure. Never a stack, never the key. */
export const UPLOAD_POST_EXPLANATION: Record<UploadPostFailure, string> = {
  NOT_CONFIGURED:
    `Upload-Post is not configured on this deployment. Set ${API_KEY_VARIABLE} on the server and restart.`,
  INVALID_KEY:
    'Upload-Post rejected this deployment\'s API key. It may have been rotated or revoked — set a current '
    + `${API_KEY_VARIABLE} on the server. Reconnecting this restaurant cannot fix it.`,
  PROFILE_NOT_FOUND:
    'Upload-Post has no profile for this restaurant any more. Connect Upload-Post again to recreate it.',
  ACCOUNT_NOT_LINKED:
    'This social account is no longer linked to the restaurant\'s Upload-Post profile. Open Upload-Post from '
    + 'Integrations and link it again.',
  INVALID_MEDIA:
    'Upload-Post refused the attached media for this network. Check its format, size and duration against '
    + 'the network\'s own limits.',
  RATE_LIMITED: 'Upload-Post is rate limiting this deployment. The post will be retried.',
  PROVIDER_UNAVAILABLE: 'Upload-Post is temporarily unavailable. The post will be retried.',
  INVALID_REQUEST: 'Upload-Post rejected the request.',
};

/**
 * The same failures, said to someone who pressed Connect.
 *
 * The map above is publishing's, and it leaked: pressing Connect answered
 * "Upload-Post is temporarily unavailable. **The post will be retried**" — a
 * sentence about a post, on a screen where no post exists and nothing will be
 * retried, because a failed Connect is simply a button that did not work.
 *
 * Only the entries whose wording or remedy actually differs are overridden.
 * Everything else falls through, because duplicating a sentence that is already
 * right is how the two copies drift.
 */
const CONNECT_EXPLANATION: Partial<Record<UploadPostFailure, string>> = {
  RATE_LIMITED:
    'Upload-Post is rate limiting this deployment. Wait a moment and press Connect again.',
  PROVIDER_UNAVAILABLE:
    'Upload-Post did not answer this request. Nothing was connected — press Connect again in a moment, '
    + 'and if it repeats, the detail is in the server log for this attempt.',
  PROFILE_NOT_FOUND:
    'Upload-Post has no profile for this restaurant yet. Press Connect again to create one.',
  ACCOUNT_NOT_LINKED:
    'Upload-Post refused access to this restaurant\'s profile. Check the account behind this '
    + `deployment's ${API_KEY_VARIABLE} on Upload-Post.`,
};

/** What to tell the operator, in the language of the thing they were doing. */
export type UploadPostOperation = 'CONNECT' | 'PUBLISH';

export function explainUploadPostFailure(
  failure: UploadPostFailure,
  operation: UploadPostOperation,
): string {
  if (operation === 'CONNECT') return CONNECT_EXPLANATION[failure] ?? UPLOAD_POST_EXPLANATION[failure];
  return UPLOAD_POST_EXPLANATION[failure];
}

/**
 * Extends `Error` directly rather than `ProviderApiError`, for the reason
 * `GoogleAdsError` does: `index.ts` imports this module for the adapter's
 * descriptor and `meta.ts` — where `ProviderApiError` lives — imports
 * `index.ts`. Subclassing across that cycle evaluates `extends` while `meta.ts`
 * is still initialising, so the base class is undefined and the server fails to
 * boot. The shape is kept identical (`platform`, `status`).
 */
export class UploadPostError extends Error {
  readonly platform = Platform.UPLOAD_POST;
  readonly status: number;
  readonly failure: UploadPostFailure;
  /** Which call failed, as a path. Never carries a query string or a token. */
  readonly endpoint: string | null;

  constructor(
    status: number,
    message: string,
    failure?: UploadPostFailure,
    endpoint?: string | null,
  ) {
    super(message);
    this.name = 'UploadPostError';
    this.status = status;
    this.failure = failure ?? classifyUploadPostError(message, status);
    this.endpoint = endpoint ?? null;
  }

  /** Safe for a UI: no key material, no stack, and it names Upload-Post. */
  get explanation(): string {
    return UPLOAD_POST_EXPLANATION[this.failure];
  }

  /** The same, said to someone who pressed Connect rather than Publish. */
  get connectExplanation(): string {
    return explainUploadPostFailure(this.failure, 'CONNECT');
  }
}

/**
 * Upload-Post reports failure as `{ message }` or `{ detail }`, sometimes
 * alongside a 200. Both official clients read those two keys in that order and
 * fall back to the status, so this does the same rather than inventing a third.
 */
function describeError(payload: Record<string, unknown>, status: number): string {
  const message = payload.message ?? payload.detail ?? payload.error;
  if (typeof message === 'string' && message.trim()) return message.trim();
  return `HTTP ${status}`;
}

// ------------------------------------------------------------------ client

/**
 * `fetch`, narrowed to what this module uses.
 *
 * Wider than the shared `FetchLike` in one respect — the body may be a
 * `FormData` — because uploads are multipart. Declared here rather than
 * widening the shared type so no other adapter inherits a body shape it does
 * not accept.
 */
export type UploadPostFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
  /**
   * Optional, because the shared `FetchLike` does not declare it and the test
   * stubs that satisfy that type must keep satisfying this one. Read only for
   * diagnostics — a JSON content type says the API answered, an HTML one says
   * something in front of it did, and that distinction is most of the triage.
   */
  headers?: { get(name: string): string | null };
}>;

function authHeaders(config: UploadPostConfig): Record<string, string> {
  /*
   * Authorisation, and deliberately nothing else.
   *
   * This used to also send `X-Upload-Post-Source: noriva-marketing-os`, which
   * was my invention: both official clients send that header with a value from
   * their own small set (`npm`, `pip`), and it exists to attribute an SDK. We
   * are not one of their SDKs, so there is no correct value for us to send —
   * and sending an unrecognised one was the single respect in which this
   * client's requests differed from a known-good one, while production
   * answered a consistent 5xx. A header that buys nothing is not worth being
   * the difference between a request that works and one that does not.
   */
  return { authorization: `Apikey ${config.apiKey}` };
}

/**
 * What may be written to a log about a failed call.
 *
 * Everything here is chosen rather than passed through: the method, the path
 * with no query string, the status, the content type, and the provider's own
 * message. Headers are never logged at all, so the key cannot leak by
 * accident — and `scrubSecret` removes it from the provider's message too, on
 * the assumption that any upstream may one day echo a request back.
 *
 * This exists because its absence is what made a production failure
 * undiagnosable: the browser showed a sentence, the server recorded nothing,
 * and no one could say which of three calls had failed or what it answered.
 */
function scrubSecret(text: string, apiKey: string): string {
  if (!apiKey) return text;
  return text.split(apiKey).join('[redacted]');
}

function logUploadPostFailure(input: {
  method: string;
  path: string;
  status: number;
  contentType: string | null;
  message: string;
  apiKey: string;
}): void {
  const detail = scrubSecret(input.message, input.apiKey).replace(/\s+/g, ' ').trim().slice(0, 300);

  // One line, one failure, and every field safe to read over someone's
  // shoulder. `console.error` because this is the application's only voice.
  console.error(
    `[upload-post] ${input.method} ${input.path} failed: HTTP ${input.status}`
    + ` content-type=${input.contentType ?? 'none'} detail="${detail}"`,
  );
}

async function readJson(
  response: Awaited<ReturnType<UploadPostFetch>>,
  context: string,
  call?: { method: string; path: string; apiKey: string },
): Promise<Record<string, unknown>> {
  const text = await response.text();

  /*
   * Read before anything can throw, because it is one of the few facts that
   * distinguishes "the API answered" from "something in front of it did": a
   * JSON body is theirs, an HTML one is a gateway's.
   */
  const contentType = typeof response.headers?.get === 'function'
    ? response.headers.get('content-type')
    : null;

  const report = (status: number, message: string) => {
    if (call) {
      logUploadPostFailure({
        method: call.method,
        path: call.path,
        status,
        contentType,
        message,
        apiKey: call.apiKey,
      });
    }
  };

  let payload: Record<string, unknown> = {};
  if (text) {
    try {
      const parsed = JSON.parse(text) as unknown;
      payload = (parsed ?? {}) as Record<string, unknown>;
    } catch {
      /*
       * Not JSON. Almost always an edge or gateway page rather than the API, so
       * the status is the diagnostic. A short, tag-stripped prefix of the body
       * is included because the page usually says which hop answered — and
       * swallowing it into "unreadable response" is what makes this class of
       * failure take an afternoon.
       */
      const body = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
      report(response.status, `non-JSON body: ${body}`);
      throw new UploadPostError(
        response.status,
        `${context}: Upload-Post returned HTTP ${response.status} with a non-JSON body. ${body}`,
        undefined,
        call?.path ?? null,
      );
    }
  }

  /*
   * `success: false` with a 200 is a real answer shape here, so the status
   * alone is not the verdict. Checked explicitly rather than trusted, because
   * treating a refusal as a success is how a post that never published gets
   * marked PUBLISHED.
   */
  if (!response.ok || payload.success === false) {
    const described = describeError(payload, response.status);
    report(response.status, described);
    throw new UploadPostError(
      response.status,
      `${context}: ${described}`,
      undefined,
      call?.path ?? null,
    );
  }
  return payload;
}

async function request(input: {
  config: UploadPostConfig;
  path: string;
  method: 'GET' | 'POST' | 'DELETE';
  json?: unknown;
  form?: unknown;
  query?: Record<string, string>;
  idempotencyKey?: string;
  fetchImpl: UploadPostFetch;
  context: string;
  timeoutMs?: number;
}): Promise<Record<string, unknown>> {
  const url = new URL(`${BASE_URL}${input.path}`);
  for (const [key, value] of Object.entries(input.query ?? {})) url.searchParams.set(key, value);

  const headers = authHeaders(input.config);
  if (input.json !== undefined) headers['content-type'] = 'application/json';
  /*
   * The provider's own duplicate guard, and the reason a retry is safe at all:
   * two uploads carrying the same key within 24 hours are collapsed into one
   * post. Without it a retried publish reaches the restaurant's followers
   * twice, and nothing in either system records that it happened.
   *
   * Deliberately not set on reads — it means nothing there — and never derived
   * from anything a caller supplies: every caller passes a row id we own.
   */
  if (input.idempotencyKey) headers['idempotency-key'] = input.idempotencyKey;

  // Multipart bodies set their own content-type, boundary included; setting one
  // here would replace it with a boundary-less header the server cannot parse.
  const body = input.json !== undefined ? JSON.stringify(input.json) : input.form;

  const response = await input.fetchImpl(url.toString(), {
    method: input.method,
    headers,
    ...(body === undefined ? {} : { body }),
    ...(input.timeoutMs ? { signal: AbortSignal.timeout(input.timeoutMs) } : {}),
  });

  /*
   * The path, not the URL: the query string can carry a request id and there is
   * no reason for a log line to grow one. The key is passed only so the
   * provider's own message can be scrubbed of it before it is written.
   */
  return readJson(response, input.context, {
    method: input.method,
    path: input.path,
    apiKey: input.config.apiKey,
  });
}

// --------------------------------------------------------------- profiles

export interface UploadPostProfile {
  username: string;
  /** Per network, whatever Upload-Post knows about the linked account. */
  socialAccounts: Record<string, unknown>;
  createdAt: string | null;
}

function toProfile(row: Record<string, unknown>): UploadPostProfile | null {
  const username = typeof row.username === 'string' ? row.username.trim() : '';
  if (!username) return null;

  const accounts = row.social_accounts;
  return {
    username,
    socialAccounts:
      accounts && typeof accounts === 'object' && !Array.isArray(accounts)
        ? (accounts as Record<string, unknown>)
        : {},
    createdAt: typeof row.created_at === 'string' ? row.created_at : null,
  };
}

/** Every profile under this deployment's API key. */
export async function listProfiles(input: {
  config: UploadPostConfig;
  fetchImpl: UploadPostFetch;
}): Promise<UploadPostProfile[]> {
  const payload = await request({
    config: input.config,
    path: '/uploadposts/users',
    method: 'GET',
    fetchImpl: input.fetchImpl,
    context: 'Upload-Post profiles',
  });

  const profiles = Array.isArray(payload.profiles) ? payload.profiles : [];
  return profiles
    .map((row) => toProfile((row ?? {}) as Record<string, unknown>))
    .filter((profile): profile is UploadPostProfile => profile !== null);
}

/** One profile by name, or null. A read, so a missing profile is not an error. */
export async function findProfile(input: {
  config: UploadPostConfig;
  username: string;
  fetchImpl: UploadPostFetch;
}): Promise<UploadPostProfile | null> {
  const profiles = await listProfiles(input);
  return profiles.find((profile) => profile.username === input.username) ?? null;
}

/**
 * Ensure this restaurant has its own profile, and return it.
 *
 * Idempotent on purpose: pressing Connect twice, or reconnecting after linking
 * an extra network, must not strand the accounts already linked under a second
 * profile. An existing profile is returned untouched.
 */
export async function ensureProfile(input: {
  config: UploadPostConfig;
  username: string;
  fetchImpl: UploadPostFetch;
}): Promise<UploadPostProfile> {
  const existing = await findProfile(input);
  if (existing) return existing;

  await request({
    config: input.config,
    path: '/uploadposts/users',
    method: 'POST',
    json: { username: input.username },
    fetchImpl: input.fetchImpl,
    context: 'Upload-Post create profile',
  });

  /*
   * Re-read rather than trusting the create response to carry the full profile.
   * A freshly created profile has no linked accounts, and the shape that
   * matters downstream is the one `listProfiles` returns — reading it once here
   * means discovery has exactly one code path instead of two.
   */
  return (
    (await findProfile(input)) ?? { username: input.username, socialAccounts: {}, createdAt: null }
  );
}

/** Remove this restaurant's profile from Upload-Post entirely. */
export async function deleteProfile(input: {
  config: UploadPostConfig;
  username: string;
  fetchImpl: UploadPostFetch;
}): Promise<void> {
  await request({
    config: input.config,
    path: '/uploadposts/users',
    method: 'DELETE',
    json: { username: input.username },
    fetchImpl: input.fetchImpl,
    context: 'Upload-Post delete profile',
  });
}

// -------------------------------------------------------------- connection

export interface ConnectionLink {
  /** Where the operator links their social accounts. Short-lived. */
  url: string;
}

/**
 * A link to Upload-Post's hosted account-linking page, scoped to one profile.
 *
 * This is what replaces OAuth for this provider. The JWT is minted server-side
 * against the deployment's API key and is bound to exactly one profile, so the
 * URL handed to the browser can only ever link accounts to that restaurant. The
 * key itself is never part of it.
 *
 * `platforms` narrows the page to the networks this application can actually
 * route to — offering the operator a Discord button that nothing here would
 * ever publish to is an invitation to connect something and wonder why it never
 * posts.
 */
export async function connectionUrl(input: {
  config: UploadPostConfig;
  username: string;
  redirectUrl: string;
  platforms?: string[];
  fetchImpl: UploadPostFetch;
}): Promise<ConnectionLink> {
  const payload = await request({
    config: input.config,
    path: '/uploadposts/users/generate-jwt',
    method: 'POST',
    json: {
      username: input.username,
      redirect_url: input.redirectUrl,
      platforms: input.platforms ?? routablePlatforms().map(uploadPostPlatform).filter(Boolean),
    },
    fetchImpl: input.fetchImpl,
    context: 'Upload-Post connection link',
  });

  const url = payload.connection_url;
  if (typeof url !== 'string' || !url.trim()) {
    throw new UploadPostError(502, 'Upload-Post connection link: no connection URL was returned.');
  }
  return { url: url.trim() };
}

// --------------------------------------------------------------- discovery

/** How a linked network maps onto the kinds this application already models. */
const ACCOUNT_KIND: Partial<Record<Platform, DiscoveredAccount['kind']>> = {
  [Platform.FACEBOOK]: 'PAGE',
  [Platform.INSTAGRAM]: 'INSTAGRAM',
  [Platform.GOOGLE_BUSINESS]: 'BUSINESS',
};

/**
 * What Upload-Post tells us about one linked account, flattened.
 *
 * The per-network objects are not uniform — each carries whatever that network
 * exposes — so this reads the handful of keys that recur and keeps the rest
 * verbatim in metadata rather than dropping it. A network that starts returning
 * a display name under a key not listed here degrades to the username, which is
 * always present, instead of to an empty row.
 */
function accountIdentity(value: unknown): { id: string; name: string; username: string | null } | null {
  if (typeof value === 'string') {
    // The simplest shape Upload-Post uses: the linked account's username.
    const username = value.trim();
    return username ? { id: username, name: username, username } : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const row = value as Record<string, unknown>;
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const candidate = row[key];
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
      if (typeof candidate === 'number') return String(candidate);
    }
    return null;
  };

  const username = pick('username', 'handle', 'screen_name');
  const name = pick('display_name', 'name', 'page_name', 'title') ?? username;
  const id = pick('id', 'account_id', 'page_id', 'user_id', 'social_id') ?? username;

  if (!id || !name) return null;
  return { id, name, username };
}

/**
 * The social accounts linked to one restaurant's profile, as attachable assets.
 *
 * Shaped exactly like every other provider's discovery so `connect-flow`'s
 * invariants hold unchanged: nothing is attached that the operator did not
 * choose, and re-running discovery refreshes names without duplicating rows.
 *
 * A network Upload-Post reports that this application does not model is
 * skipped, not guessed at — there is nowhere for a Discord post to come from in
 * this product, and inventing a Platform for it would put a row on the
 * selection screen that can never publish.
 */
export function discoverFromProfile(profile: UploadPostProfile): DiscoveryResult {
  const accounts: DiscoveredAccount[] = [];
  const refusals: Array<{ externalId: string; message: string }> = [];

  for (const [slug, value] of Object.entries(profile.socialAccounts)) {
    const platform = platformForUploadPost(slug);
    if (!platform) continue;

    const identity = accountIdentity(value);
    if (!identity) {
      /*
       * Linked, according to the profile, but described in a shape this reader
       * cannot identify an account from. Reported rather than dropped: an
       * operator who linked Instagram and cannot find it on the selection
       * screen needs to know it arrived and was unreadable, not be left to
       * conclude the linking failed.
       */
      refusals.push({
        externalId: slug,
        message: `Upload-Post reported a linked ${slug} account without an identifier this application could read.`,
      });
      continue;
    }

    accounts.push({
      kind: ACCOUNT_KIND[platform] ?? 'PROFILE',
      externalId: identity.id,
      name: identity.name,
      username: identity.username ?? undefined,
      metadata: {
        /*
         * The two facts the publishing route is resolved from, and the reason
         * they live on the account rather than being re-derived: an Upload-Post
         * account is addressed by (profile, network), and a post routed to the
         * wrong one of either publishes to a different restaurant or a
         * different network.
         */
        uploadPostProfile: profile.username,
        uploadPostPlatform: slug,
        /** Whatever else the network told us, kept rather than discarded. */
        uploadPostAccount: value,
      },
      /*
       * No per-account credential, and deliberately none invented. Upload-Post
       * authorises the *deployment*; the linked account is addressed by name
       * under a profile. `connect-flow` records the account with no token, and
       * the publishing route — not a stored secret — is what says it can post.
       */
    });
  }

  return { accounts, refusals };
}

/** Read the profile and turn it into attachable assets, in one call. */
export async function discoverAccounts(input: {
  config: UploadPostConfig;
  username: string;
  fetchImpl: UploadPostFetch;
}): Promise<DiscoveryResult> {
  const profile = await findProfile(input);
  if (!profile) {
    throw new UploadPostError(
      404,
      `Upload-Post profiles: no profile named ${input.username} exists.`,
      'PROFILE_NOT_FOUND',
    );
  }
  return discoverFromProfile(profile);
}

// ---------------------------------------------------------------- publish

export interface UploadPostMedia {
  kind: 'IMAGE' | 'VIDEO';
  data: Uint8Array;
  mimeType: string;
  filename: string;
}

export interface UploadPostPublishInput {
  config: UploadPostConfig;
  /** The restaurant's own profile. Never a default, never another client's. */
  username: string;
  /** Upload-Post's identifier for the one network this post is going to. */
  platform: string;
  caption: string;
  media: UploadPostMedia[];
  /**
   * Collapses a retry into the post it is retrying, for 24 hours.
   *
   * Required rather than optional: every caller already holds a durable row id
   * for the post being published, and a publish sent without one is a publish
   * that will duplicate the moment anything retries it.
   */
  idempotencyKey: string;
  fetchImpl: UploadPostFetch;
  timeoutMs?: number;
}

export interface UploadPostPublishResult {
  /** Upload-Post's own id for the upload. Never synthesised. */
  requestId: string | null;
  /** The live post, when the network returned one. */
  url: string | null;
  /** Per-network outcomes, as reported. */
  platforms: Array<{ name: string; url: string | null; error: string | null }>;
}

/**
 * Read the per-platform results out of an upload response.
 *
 * Upload-Post nests them under `data.platforms`, and each entry carries its own
 * `error`. A response that is `success: true` overall can still contain a
 * network that refused, so this is read rather than assumed — reporting an
 * upload as published because the envelope said success is exactly the lie the
 * publishing service is built to prevent.
 */
function readPlatformResults(payload: Record<string, unknown>): UploadPostPublishResult['platforms'] {
  const data = (payload.data ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(data.platforms) ? data.platforms : [];

  return rows.flatMap((entry) => {
    const row = (entry ?? {}) as Record<string, unknown>;
    const name = typeof row.name === 'string' ? row.name : null;
    if (!name) return [];
    return [{
      name,
      url: typeof row.url === 'string' && row.url.trim() ? row.url.trim() : null,
      error: typeof row.error === 'string' && row.error.trim() ? row.error.trim() : null,
    }];
  });
}

/**
 * Publish one post to one network through Upload-Post.
 *
 * One network per call, not the fan-out the API also allows, and that is the
 * central decision in this integration. NORIVA already models a post per
 * platform — a `PlatformPost` row, its own status, its own retry count, its own
 * external id — and the scheduler drives them independently. A single call
 * publishing to four networks would give four rows one shared outcome: one
 * network's rejection would either fail three posts that went out fine, or be
 * swallowed to keep them green. Neither is acceptable, and per-call routing
 * costs nothing but an HTTP request.
 *
 * `scheduled_date` is deliberately never sent. NORIVA's own scheduler owns when
 * a post goes out — it is what the calendar shows and what an operator edits —
 * and handing the time to Upload-Post as well would mean two schedulers for one
 * post, with this application marking content PUBLISHED on the strength of an
 * acknowledgement that nothing had published yet. The post is sent at the
 * moment it is due, and is published when Upload-Post says it is.
 */
export async function publish(input: UploadPostPublishInput): Promise<UploadPostPublishResult> {
  const video = input.media.find((item) => item.kind === 'VIDEO');
  const images = input.media.filter((item) => item.kind === 'IMAGE');

  const form = new FormData();
  form.append('user', input.username);
  if (input.caption) form.append('title', input.caption);
  // Repeated, not comma-joined: `platform[]` is how both official clients send
  // the list, and a comma-joined value is read as one platform named "a,b".
  form.append('platform[]', input.platform);

  /*
   * The bytes, not a link. Upload-Post accepts either — an https URL in the
   * same field is fetched by their servers — but this application's media lives
   * behind an authenticated route, so a URL would hand Upload-Post a login
   * page. Sending the bytes needs no public copy of a customer's creative and
   * no signed link with an expiry that has to outlive an unknown fetch delay.
   */
  const part = (item: UploadPostMedia) =>
    new File([new Uint8Array(item.data)], item.filename, { type: item.mimeType });

  let path: string;
  if (video) {
    form.append('video', part(video));
    path = '/upload';
  } else if (images.length > 0) {
    for (const image of images) form.append('photos[]', part(image));
    path = '/upload_photos';
  } else {
    // Text-only. A separate endpoint rather than an empty media list, because
    // the media endpoints refuse a post with no media at all.
    path = '/upload_text';
  }

  const payload = await request({
    config: input.config,
    path,
    method: 'POST',
    form,
    idempotencyKey: input.idempotencyKey,
    fetchImpl: input.fetchImpl,
    context: `Upload-Post ${input.platform} publish`,
    timeoutMs: input.timeoutMs,
  });

  const platforms = readPlatformResults(payload);

  /*
   * The network's own refusal, raised rather than returned as a success.
   * `success: true` on the envelope only means the request was accepted; the
   * entry for this platform is what says whether the post exists.
   */
  const mine = platforms.find((entry) => entry.name.toLowerCase() === input.platform);
  if (mine?.error) {
    throw new UploadPostError(502, `Upload-Post ${input.platform} publish: ${mine.error}`);
  }

  const requestId = typeof payload.request_id === 'string' ? payload.request_id : null;

  return { requestId, url: mine?.url ?? null, platforms };
}

/**
 * Ask Upload-Post what became of an upload it accepted.
 *
 * Uploads may be processed asynchronously, so an accepted request is not yet a
 * published post. The publisher uses this to turn an acknowledgement into
 * either a real post id or a real failure, rather than reporting the
 * acknowledgement itself as a publication.
 */
export async function uploadStatus(input: {
  config: UploadPostConfig;
  requestId: string;
  fetchImpl: UploadPostFetch;
  timeoutMs?: number;
}): Promise<{ status: string | null; platforms: UploadPostPublishResult['platforms'] }> {
  const payload = await request({
    config: input.config,
    path: '/uploadposts/status',
    method: 'GET',
    query: { request_id: input.requestId },
    fetchImpl: input.fetchImpl,
    context: 'Upload-Post upload status',
    timeoutMs: input.timeoutMs,
  });

  const status = typeof payload.status === 'string' ? payload.status : null;
  return { status, platforms: readPlatformResults(payload) };
}

/** The shared `FetchLike` is assignable to this module's; asserted, not assumed. */
export type { FetchLike };

/**
 * Google, as a provider adapter — OAuth 2.0 and Business Profile discovery.
 *
 * Shaped like `meta.ts` and `tiktok.ts` so `connect-flow` can dispatch to it
 * and the connection lifecycle — signed state, encrypted tokens,
 * operator-chosen assets, tenant isolation — stays the one that already exists.
 *
 * Three things about Google that shape this file.
 *
 * **A refresh token arrives once, or never.** Google returns one only when the
 * authorization asks for `access_type=offline` *and* `prompt=consent`. Without
 * both, a re-connection silently yields an access token that expires in an hour
 * and no way to renew it, and the integration dies quietly the next morning. So
 * both are always sent, and a response with no refresh token is surfaced rather
 * than stored as if it were fine.
 *
 * **Business Profile is three APIs, not one.** Accounts come from
 * Account Management, locations from Business Information, and reviews and
 * replies from the older v4 host — which is why a location keeps its parent
 * `accounts/…` name: the review endpoints are not addressable by location
 * alone, and rediscovering the parent at reply time would be a second round
 * trip on the critical path.
 *
 * **Scopes are per product.** Reviews and posts need `business.manage`;
 * Search Console and GA4 need their own, and are listed here but not requested,
 * because asking for scopes a deployment cannot yet use makes the consent
 * screen scarier for no gain. They are named so the next phase adds a scope
 * rather than a second OAuth flow.
 */

import { Platform } from '@prisma/client';

import { ProviderNotConfiguredError } from './index.js';
import { ProviderApiError, type DiscoveredAccount, type FetchLike, type TokenSet } from './meta.js';

const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';

/** Account Management: which Business Profile accounts this login administers. */
const ACCOUNTS_API = 'https://mybusinessaccountmanagement.googleapis.com/v1';
/** Business Information: the locations under an account, and their NAP fields. */
const INFO_API = 'https://mybusinessbusinessinformation.googleapis.com/v1';

/** What this phase asks for. */
export const GOOGLE_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/business.manage',
] as const;

/**
 * Scopes later Google phases will need, named but not requested.
 *
 * Search Console and GA4 are separate products with separate consent; adding
 * them here when nothing reads them would widen the consent screen for a
 * capability the deployment does not have.
 */
export const FUTURE_SCOPES = {
  searchConsole: 'https://www.googleapis.com/auth/webmasters.readonly',
  analytics: 'https://www.googleapis.com/auth/analytics.readonly',
  ads: 'https://www.googleapis.com/auth/adwords',
} as const;

export const BUSINESS_SCOPE = 'https://www.googleapis.com/auth/business.manage';

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function googleConfig(env: NodeJS.ProcessEnv = process.env): GoogleConfig {
  const missing = (['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'] as const).filter(
    (key) => !env[key]?.trim(),
  );
  if (missing.length > 0) throw new ProviderNotConfiguredError(Platform.GOOGLE_BUSINESS, 'Google', missing);

  // Trimmed on the way in: these are pasted into a hosting dashboard by hand and
  // a trailing newline is invisible in every UI that edits them, while being
  // fatal in an OAuth parameter.
  return {
    clientId: env.GOOGLE_CLIENT_ID!.trim(),
    clientSecret: env.GOOGLE_CLIENT_SECRET!.trim(),
    redirectUri: env.GOOGLE_REDIRECT_URI!.trim(),
  };
}

export function googleConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return (['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'] as const)
    .every((key) => Boolean(env[key]?.trim()));
}

export function authorizationUrl(input: { config: GoogleConfig; state: string }): string {
  const url = new URL(AUTHORIZE);
  url.searchParams.set('client_id', input.config.clientId);
  url.searchParams.set('redirect_uri', input.config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_SCOPES.join(' '));
  url.searchParams.set('state', input.state);
  /*
   * Both of these, always. `access_type=offline` is what makes Google issue a
   * refresh token at all, and `prompt=consent` is what makes it issue one again
   * for an account that has already consented — without it, a reconnection
   * returns an access token with an hour of life and nothing to renew it with.
   */
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  return url.toString();
}

/** Google reports errors in-band on some hosts and by status on others. */
async function readJson(
  response: Awaited<ReturnType<FetchLike>>,
  context: string,
): Promise<Record<string, unknown>> {
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  // OAuth endpoints answer `{ error, error_description }`.
  const oauthError = payload.error;
  if (typeof oauthError === 'string') {
    const detail = (payload.error_description as string | undefined) ?? oauthError;
    throw new ProviderApiError(Platform.GOOGLE_BUSINESS, response.status, `${context}: ${detail}`);
  }

  // The API hosts answer `{ error: { code, message, status } }`.
  if (oauthError && typeof oauthError === 'object') {
    const detail = (oauthError as { message?: string }).message ?? 'Google rejected the request';
    throw new ProviderApiError(Platform.GOOGLE_BUSINESS, response.status, `${context}: ${detail}`);
  }

  if (!response.ok) {
    throw new ProviderApiError(Platform.GOOGLE_BUSINESS, response.status, `${context}: HTTP ${response.status}`);
  }
  return payload;
}

export async function exchangeCode(input: {
  config: GoogleConfig;
  code: string;
  fetchImpl: FetchLike;
  now?: Date;
}): Promise<TokenSet> {
  const now = input.now ?? new Date();

  const body = new URLSearchParams({
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    code: input.code,
    grant_type: 'authorization_code',
    redirect_uri: input.config.redirectUri,
  });

  const payload = await readJson(
    await input.fetchImpl(TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }),
    'Google token exchange',
  );

  const accessToken = payload.access_token as string | undefined;
  if (!accessToken) {
    throw new ProviderApiError(Platform.GOOGLE_BUSINESS, 502, 'Google token exchange returned no access token');
  }

  const refreshToken = (payload.refresh_token as string | undefined) ?? null;
  if (!refreshToken) {
    /*
     * Refused rather than stored. An access token alone works for an hour and
     * then the integration stops with no way back except a reconnection nobody
     * knows is needed — a failure that surfaces as "Google went quiet" days
     * later. Better to fail the connection now, while the operator is looking
     * at it.
     */
    throw new ProviderApiError(
      Platform.GOOGLE_BUSINESS,
      502,
      'Google returned no refresh token. Remove this app from the account\'s third-party access and connect again so Google re-issues one.',
    );
  }

  const expiresIn = payload.expires_in as number | undefined;
  const scope = payload.scope as string | undefined;

  return {
    accessToken,
    refreshToken,
    expiresAt: typeof expiresIn === 'number' ? new Date(now.getTime() + expiresIn * 1000) : null,
    // The grant, not the request: Google honours per-scope refusals and the
    // caller decides what the connection can do from what actually came back.
    scopes: scope ? scope.split(' ').map((entry) => entry.trim()).filter(Boolean) : [],
  };
}

/** Trade a stored refresh token for a fresh access token. */
export async function refreshAccessToken(input: {
  config: GoogleConfig;
  refreshToken: string;
  fetchImpl: FetchLike;
  now?: Date;
}): Promise<{ accessToken: string; expiresAt: Date | null }> {
  const now = input.now ?? new Date();

  const body = new URLSearchParams({
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    refresh_token: input.refreshToken,
    grant_type: 'refresh_token',
  });

  const payload = await readJson(
    await input.fetchImpl(TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }),
    'Google token refresh',
  );

  const accessToken = payload.access_token as string | undefined;
  if (!accessToken) {
    throw new ProviderApiError(Platform.GOOGLE_BUSINESS, 502, 'Google token refresh returned no access token');
  }

  const expiresIn = payload.expires_in as number | undefined;
  return {
    accessToken,
    expiresAt: typeof expiresIn === 'number' ? new Date(now.getTime() + expiresIn * 1000) : null,
  };
}

export interface GoogleIdentity {
  id: string;
  name: string;
  email?: string;
}

export async function validateToken(input: {
  accessToken: string;
  fetchImpl: FetchLike;
}): Promise<GoogleIdentity> {
  const payload = await readJson(
    await input.fetchImpl(USERINFO, {
      method: 'GET',
      headers: { authorization: `Bearer ${input.accessToken}` },
    }),
    'Google token validation',
  );

  const sub = payload.sub as string | undefined;
  if (!sub) {
    throw new ProviderApiError(Platform.GOOGLE_BUSINESS, 502, 'Google token validation returned no subject');
  }

  const email = payload.email as string | undefined;
  return { id: sub, name: email ?? 'Google account', email };
}

// ------------------------------------------------------- business profile

export interface GoogleAccount {
  /** Resource name, e.g. "accounts/123". */
  name: string;
  accountName: string;
  type?: string;
}

export async function listAccounts(input: {
  accessToken: string;
  fetchImpl: FetchLike;
}): Promise<GoogleAccount[]> {
  const payload = await readJson(
    await input.fetchImpl(`${ACCOUNTS_API}/accounts`, {
      method: 'GET',
      headers: { authorization: `Bearer ${input.accessToken}` },
    }),
    'Google Business accounts',
  );

  const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
  return accounts.map((entry) => {
    const row = entry as Record<string, unknown>;
    return {
      name: String(row.name ?? ''),
      accountName: String(row.accountName ?? 'Business account'),
      type: row.type as string | undefined,
    };
  }).filter((account) => account.name.length > 0);
}

export interface GoogleLocationPayload {
  /** Resource name, e.g. "locations/123". */
  name: string;
  title: string;
  storeCode?: string;
  addressLines: string[];
  locality?: string;
  region?: string;
  postalCode?: string;
  country?: string;
  phone?: string;
  websiteUri?: string;
  mapsUri?: string;
  primaryCategory?: string;
  raw: Record<string, unknown>;
}

/**
 * The fields the Business Information API will return.
 *
 * `readMask` is mandatory — the endpoint answers 400 without one — and asking
 * for a field the account cannot expose fails the whole call, so this list is
 * the intersection that is safe for every profile rather than everything the
 * schema documents.
 */
const LOCATION_READ_MASK = [
  'name', 'title', 'storeCode', 'storefrontAddress', 'phoneNumbers',
  'websiteUri', 'categories', 'metadata',
].join(',');

export async function listLocations(input: {
  accessToken: string;
  accountName: string;
  fetchImpl: FetchLike;
}): Promise<GoogleLocationPayload[]> {
  const collected: GoogleLocationPayload[] = [];
  let pageToken: string | undefined;

  // Paged: a franchise with two hundred branches is the case that makes an
  // un-paged read silently return the first hundred and call it complete.
  do {
    const url = new URL(`${INFO_API}/${input.accountName}/locations`);
    url.searchParams.set('readMask', LOCATION_READ_MASK);
    url.searchParams.set('pageSize', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const payload = await readJson(
      await input.fetchImpl(url.toString(), {
        method: 'GET',
        headers: { authorization: `Bearer ${input.accessToken}` },
      }),
      'Google Business locations',
    );

    for (const entry of Array.isArray(payload.locations) ? payload.locations : []) {
      collected.push(toLocation(entry as Record<string, unknown>));
    }
    pageToken = payload.nextPageToken as string | undefined;
  } while (pageToken);

  return collected;
}

function toLocation(row: Record<string, unknown>): GoogleLocationPayload {
  const address = (row.storefrontAddress ?? {}) as Record<string, unknown>;
  const phones = (row.phoneNumbers ?? {}) as Record<string, unknown>;
  const categories = (row.categories ?? {}) as Record<string, unknown>;
  const primary = (categories.primaryCategory ?? {}) as Record<string, unknown>;
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;

  return {
    name: String(row.name ?? ''),
    title: String(row.title ?? 'Untitled location'),
    storeCode: row.storeCode as string | undefined,
    addressLines: Array.isArray(address.addressLines) ? address.addressLines.map(String) : [],
    locality: address.locality as string | undefined,
    region: address.administrativeArea as string | undefined,
    postalCode: address.postalCode as string | undefined,
    country: address.regionCode as string | undefined,
    phone: phones.primaryPhone as string | undefined,
    websiteUri: row.websiteUri as string | undefined,
    mapsUri: metadata.mapsUri as string | undefined,
    primaryCategory: primary.displayName as string | undefined,
    raw: row,
  };
}

/**
 * The Google accounts this login administers, as discoverable assets.
 *
 * Accounts rather than locations: an account is what the operator chooses to
 * attach, and its locations are then synced under it. Listing every branch of
 * every account on the selection screen would put a two-hundred-row list in
 * front of someone trying to connect one restaurant group.
 */
export async function discoverAccounts(input: {
  accessToken: string;
  fetchImpl: FetchLike;
}): Promise<DiscoveredAccount[]> {
  const accounts = await listAccounts(input);

  return accounts.map((account) => ({
    kind: 'BUSINESS' as DiscoveredAccount['kind'],
    externalId: account.name,
    name: account.accountName,
    // The same credential works for every account this login administers;
    // Google has no per-asset token to fetch.
    accessToken: input.accessToken,
    metadata: { type: account.type ?? null },
  }));
}

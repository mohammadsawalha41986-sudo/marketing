/**
 * LinkedIn, as a provider adapter — OAuth 2.0 and organization discovery.
 *
 * Shaped like `meta.ts`, `tiktok.ts` and `google.ts` so `connect-flow.ts` can
 * dispatch to it and the connection lifecycle — signed state, encrypted tokens,
 * operator-chosen assets, tenant isolation — is the one that already exists.
 * The publishing adapter in `publishing/linkedin.ts` was written months before
 * this file and has been unreachable the whole time: it was registered as a
 * live publisher while nothing could ever hand it a token. This closes that
 * gap and adds nothing else.
 *
 * Three things about LinkedIn that shape what is here.
 *
 * **The author is an organization, not a person.** `publishing/linkedin.ts`
 * builds `urn:li:organization:{externalId}`, so discovery must return the
 * numeric organization id and nothing else. Returning a member URN would
 * produce a publisher that authenticates perfectly and then posts to an author
 * LinkedIn will not accept.
 *
 * **Administered organizations are a second call.** The ACL endpoint answers
 * with URNs and role assignments, not names, so the ids are resolved to names
 * afterwards. A page the operator cannot recognise by name is a page they will
 * attach to the wrong client.
 *
 * **A refresh token is not guaranteed.** LinkedIn issues one only to apps
 * approved for programmatic refresh; most return an access token with a fixed
 * lifetime and nothing to renew it with. So, unlike Google, a response without
 * one is *not* refused — refusing would make every unapproved app unable to
 * connect at all. The expiry is recorded instead, which is what the connection
 * needs in order to say "reconnect" at the right moment rather than guess.
 */

import { Platform } from '@prisma/client';

import { ProviderNotConfiguredError } from './index.js';
import { ProviderApiError, type DiscoveredAccount, type FetchLike, type TokenSet } from './meta.js';

const AUTHORIZE = 'https://www.linkedin.com/oauth/v2/authorization';
const TOKEN = 'https://www.linkedin.com/oauth/v2/accessToken';
const USERINFO = 'https://api.linkedin.com/v2/userinfo';
const REST = 'https://api.linkedin.com/rest';

/**
 * The version header LinkedIn's REST surface requires on every call. It is
 * pinned to the same value `publishing/linkedin.ts` posts with, so discovery
 * and publishing cannot drift onto two different contracts.
 */
const VERSION = '202405';

/**
 * What this integration asks for.
 *
 * `w_organization_social` is what the publisher needs and what LinkedIn gates
 * behind Community Management API approval; `rw_organization_admin` is what
 * makes the ACL listing return anything. `openid`/`profile` identify the login
 * itself, which is what validates the token before anything is attached.
 */
export const LINKEDIN_SCOPES = [
  'openid',
  'profile',
  'w_organization_social',
  'r_organization_social',
  'rw_organization_admin',
] as const;

export const PUBLISH_SCOPE = 'w_organization_social';

export interface LinkedInConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

const REQUIRED = ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'] as const;

/**
 * `LINKEDIN_REDIRECT_URI` is optional for the same reason YouTube's is: an
 * empty value tells `beginAuthorization` to derive the URI from the request
 * host, so a deployment only has to register the URL in LinkedIn's console.
 * Set it when the console entry and the derived host would disagree.
 */
export function linkedInConfig(env: NodeJS.ProcessEnv = process.env): LinkedInConfig {
  const missing = REQUIRED.filter((key) => !env[key]?.trim());
  if (missing.length > 0) throw new ProviderNotConfiguredError(Platform.LINKEDIN, 'LinkedIn', [...missing]);

  // Trimmed on the way in, as every other adapter does: these are pasted into a
  // hosting dashboard by hand, and a trailing newline is invisible in the UI
  // that edits them while being fatal in an OAuth parameter.
  return {
    clientId: env.LINKEDIN_CLIENT_ID!.trim(),
    clientSecret: env.LINKEDIN_CLIENT_SECRET!.trim(),
    redirectUri: env.LINKEDIN_REDIRECT_URI?.trim() ?? '',
  };
}

export function linkedInConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return REQUIRED.every((key) => Boolean(env[key]?.trim()));
}

export function authorizationUrl(input: { config: LinkedInConfig; state: string }): string {
  const url = new URL(AUTHORIZE);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.config.clientId);
  url.searchParams.set('redirect_uri', input.config.redirectUri);
  // Space-separated, unlike TikTok's commas. LinkedIn silently drops a
  // comma-joined list and grants nothing.
  url.searchParams.set('scope', LINKEDIN_SCOPES.join(' '));
  url.searchParams.set('state', input.state);
  return url.toString();
}

/** LinkedIn reports OAuth failures in-band and API failures by status. */
async function readJson(
  response: Awaited<ReturnType<FetchLike>>,
  context: string,
): Promise<Record<string, unknown>> {
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  const oauthError = payload.error;
  if (typeof oauthError === 'string') {
    const detail = (payload.error_description as string | undefined) ?? oauthError;
    throw new ProviderApiError(Platform.LINKEDIN, response.status, `${context}: ${detail}`);
  }

  if (!response.ok) {
    const detail = (payload.message as string | undefined) ?? `HTTP ${response.status}`;
    throw new ProviderApiError(Platform.LINKEDIN, response.status, `${context}: ${detail}`);
  }

  return payload;
}

export async function exchangeCode(input: {
  config: LinkedInConfig;
  code: string;
  fetchImpl: FetchLike;
  now?: Date;
}): Promise<TokenSet> {
  const now = input.now ?? new Date();

  // Form-encoded. LinkedIn's token endpoint rejects a JSON body.
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    redirect_uri: input.config.redirectUri,
  });

  const payload = await readJson(
    await input.fetchImpl(TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }),
    'LinkedIn token exchange',
  );

  const accessToken = payload.access_token as string | undefined;
  if (!accessToken) {
    throw new ProviderApiError(Platform.LINKEDIN, 502, 'LinkedIn token exchange returned no access token');
  }

  const expiresIn = payload.expires_in as number | undefined;
  const scope = payload.scope as string | undefined;

  return {
    accessToken,
    // Present only for apps approved for programmatic refresh. Null is a normal
    // outcome here, not a failure — see the header comment.
    refreshToken: (payload.refresh_token as string | undefined) ?? null,
    expiresAt: typeof expiresIn === 'number' ? new Date(now.getTime() + expiresIn * 1000) : null,
    // The grant, not the request: LinkedIn honours per-scope refusals, and the
    // caller decides what the connection can do from what actually came back.
    scopes: scope ? scope.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean) : [],
  };
}

export interface LinkedInIdentity {
  id: string;
  name: string;
  email?: string;
}

export async function validateToken(input: {
  accessToken: string;
  fetchImpl: FetchLike;
}): Promise<LinkedInIdentity> {
  const payload = await readJson(
    await input.fetchImpl(USERINFO, {
      method: 'GET',
      headers: { authorization: `Bearer ${input.accessToken}` },
    }),
    'LinkedIn token validation',
  );

  const sub = payload.sub as string | undefined;
  if (!sub) {
    throw new ProviderApiError(Platform.LINKEDIN, 502, 'LinkedIn token validation returned no subject');
  }

  const email = payload.email as string | undefined;
  return { id: sub, name: (payload.name as string | undefined) ?? email ?? 'LinkedIn account', email };
}

/** `urn:li:organization:123` → `123`. Anything else is not an organization. */
function organizationIdFrom(urn: unknown): string | null {
  if (typeof urn !== 'string') return null;
  const match = /^urn:li:organization:(\d+)$/.exec(urn.trim());
  return match ? match[1]! : null;
}

/**
 * The organizations this login administers.
 *
 * Only APPROVED ADMINISTRATOR assignments: a pending invitation is not
 * authority to post, and attaching one would produce a connection that looks
 * healthy until the first publish is refused.
 */
export async function discoverAccounts(input: {
  accessToken: string;
  fetchImpl: FetchLike;
}): Promise<DiscoveredAccount[]> {
  const headers = {
    authorization: `Bearer ${input.accessToken}`,
    'linkedin-version': VERSION,
    'x-restli-protocol-version': '2.0.0',
  };

  const url = new URL(`${REST}/organizationAcls`);
  url.searchParams.set('q', 'roleAssignee');
  url.searchParams.set('role', 'ADMINISTRATOR');
  url.searchParams.set('state', 'APPROVED');

  const payload = await readJson(
    await input.fetchImpl(url.toString(), { method: 'GET', headers }),
    'LinkedIn organizations',
  );

  const elements = Array.isArray(payload.elements) ? (payload.elements as Record<string, unknown>[]) : [];

  const ids = [
    ...new Set(
      elements
        .map((element) => organizationIdFrom(element.organization))
        .filter((id): id is string => id !== null),
    ),
  ];

  const accounts: DiscoveredAccount[] = [];
  for (const id of ids) {
    /*
     * Named individually because the ACL response carries no names. A lookup
     * that fails is not fatal to the whole discovery — one page whose detail
     * call was refused should not hide the others — so the id stands in and the
     * operator still sees something they can choose or ignore.
     */
    let name = `Organization ${id}`;
    try {
      const org = await readJson(
        await input.fetchImpl(`${REST}/organizations/${id}`, { method: 'GET', headers }),
        'LinkedIn organization',
      );
      const localized = org.localizedName as string | undefined;
      if (localized?.trim()) name = localized.trim();
    } catch {
      // Keep the placeholder; the id is still correct and still publishable.
    }

    accounts.push({
      // PAGE: an organization page is administered on a business's behalf,
      // which is exactly what the existing enum means by the word.
      kind: 'PAGE' as DiscoveredAccount['kind'],
      externalId: id,
      name,
      // One member credential covers every page this login administers;
      // LinkedIn has no per-page token to fetch.
      accessToken: input.accessToken,
    });
  }

  return accounts;
}

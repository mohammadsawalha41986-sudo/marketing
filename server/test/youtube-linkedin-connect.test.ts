/**
 * YouTube and LinkedIn: the connection that could not previously be made.
 *
 * Both platforms shipped registered in `publishing/registry.ts` with
 * `canPublish: true` while `connect-flow.ts` had no OAuth provider mapped for
 * either — so `providerFor` threw, no token could ever be stored, and the
 * publishers were unreachable code behind a Connect button that always failed.
 * The UI showed them as publishable the whole time.
 *
 * These tests are written against that specific defect. The assertions that
 * matter are the ones about *which* provider a platform is sent to and *what*
 * the discovered asset's external id is, because both were silently wrong
 * before: TikTok once produced a Facebook authorization URL from the same
 * missing-entry bug, and a LinkedIn account discovered as a member URN would
 * authenticate perfectly and then fail every publish.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IntegrationStatus, Platform } from '@prisma/client';

import { createTenant, prisma, resetDatabase, type Tenant } from './helpers.js';
import { issueState } from '../src/services/integrations/oauth-state.js';
import {
  beginAuthorization,
  callbackUrl,
  completeCallback,
  providerFor,
} from '../src/services/integrations/connect-flow.js';
import { decryptSecret } from '../src/lib/crypto.js';
import type { FetchLike } from '../src/services/integrations/meta.js';

const KEY = 'Zm9yLXRlc3Rpbmctb25seS0zMi1ieXRlLWtleS0hIQ==';
const BASE = 'https://marketing-osserver-production.up.railway.app';

/** A stub that answers by URL fragment, as the other provider tests do. */
function stub(routes: Array<{ match: string; body: unknown; status?: number }>): FetchLike {
  return (async (url: string) => {
    const route = routes.find((entry) => url.includes(entry.match));
    if (!route) throw new Error(`No stub for ${url}`);
    return {
      ok: (route.status ?? 200) < 400,
      status: route.status ?? 200,
      json: async () => route.body,
      text: async () => JSON.stringify(route.body),
    };
  }) as FetchLike;
}

/** Google's token + userinfo responses, plus YouTube's channel listing. */
function youtubeFetch(overrides: { channels?: unknown } = {}): FetchLike {
  return stub([
    {
      match: 'oauth2.googleapis.com/token',
      body: {
        access_token: 'YT-ACCESS-TOKEN',
        refresh_token: 'YT-REFRESH-TOKEN',
        expires_in: 3600,
        scope:
          'openid https://www.googleapis.com/auth/userinfo.email '
          + 'https://www.googleapis.com/auth/youtube.upload '
          + 'https://www.googleapis.com/auth/youtube.readonly',
      },
    },
    { match: 'oauth2/v3/userinfo', body: { sub: 'google-user-1', email: 'ops@pawse.sa' } },
    {
      match: 'youtube/v3/channels',
      body: overrides.channels ?? {
        items: [
          {
            id: 'UC_pawse_channel',
            snippet: { title: 'Pawse Kitchen', customUrl: '@pawse', thumbnails: { default: { url: 'https://img/1' } } },
          },
        ],
      },
    },
  ]);
}

/** LinkedIn's token, OIDC userinfo, ACL listing and organization lookup. */
function linkedInFetch(overrides: { token?: unknown; acls?: unknown } = {}): FetchLike {
  return stub([
    {
      match: 'oauth/v2/accessToken',
      body: overrides.token ?? {
        access_token: 'LI-ACCESS-TOKEN',
        expires_in: 5184000,
        scope: 'openid,profile,w_organization_social,r_organization_social,rw_organization_admin',
      },
    },
    { match: '/v2/userinfo', body: { sub: 'li-member-1', name: 'Pawse Operator', email: 'ops@pawse.sa' } },
    {
      match: 'organizationAcls',
      body: overrides.acls ?? {
        elements: [
          { organization: 'urn:li:organization:8675309', role: 'ADMINISTRATOR', state: 'APPROVED' },
        ],
      },
    },
    { match: '/rest/organizations/8675309', body: { id: 8675309, localizedName: 'Pawse' } },
  ]);
}

describe('youtube and linkedin connectivity', () => {
  let alpha: Tenant;
  const saved = { ...process.env };

  beforeAll(async () => {
    await resetDatabase();
    alpha = await createTenant('yt-li');
  });

  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
    // YouTube rides the Google client; no YouTube-specific credential exists.
    process.env.GOOGLE_CLIENT_ID = 'google-client-1';
    process.env.GOOGLE_CLIENT_SECRET = 'google-secret-1';
    process.env.LINKEDIN_CLIENT_ID = 'linkedin-client-1';
    process.env.LINKEDIN_CLIENT_SECRET = 'linkedin-secret-1';
    // Both redirect URIs are deliberately left unset, so these tests also cover
    // the derive-from-host path a deployment gets by default.
    delete process.env.YOUTUBE_REDIRECT_URI;
    delete process.env.LINKEDIN_REDIRECT_URI;
  });

  afterEach(() => {
    for (const key of [
      'TOKEN_ENCRYPTION_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
      'LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET', 'YOUTUBE_REDIRECT_URI', 'LINKEDIN_REDIRECT_URI',
    ]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  // ------------------------------------------------------ provider mapping

  it('maps both platforms to a provider instead of throwing', () => {
    // The defect itself: `providerFor` used to throw for both of these.
    expect(providerFor(Platform.YOUTUBE)).toBe('YOUTUBE');
    expect(providerFor(Platform.LINKEDIN)).toBe('LINKEDIN');
  });

  it('still refuses a platform with no OAuth adapter, loudly', () => {
    // The refusal is the other half of the fix: an unmapped platform must fail
    // rather than silently inherit whichever provider the code checked first.
    expect(() => providerFor(Platform.X)).toThrow(/no OAuth integration/i);
    expect(() => providerFor(Platform.SNAPCHAT)).toThrow(/no OAuth integration/i);
  });

  it('documents the callback URL each app console must be given', () => {
    expect(callbackUrl(BASE, Platform.YOUTUBE)).toBe(`${BASE}/api/integrations/youtube/callback`);
    expect(callbackUrl(BASE, Platform.LINKEDIN)).toBe(`${BASE}/api/integrations/linkedin/callback`);
    // YouTube shares Google's OAuth client but not its route: the state is
    // bound to one platform and the route is what proves which provider
    // redirected, so the two must stay distinguishable.
    expect(callbackUrl(BASE, Platform.GOOGLE_BUSINESS)).toBe(`${BASE}/api/integrations/google/callback`);
  });

  // --------------------------------------------------------- authorization

  it('sends YouTube to Google asking for the scope the publisher needs', async () => {
    const result = await beginAuthorization({
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      platform: Platform.YOUTUBE,
      baseUrl: BASE,
    });

    const url = new URL(result.redirectTo);
    expect(url.origin).toBe('https://accounts.google.com');

    const scopes = (url.searchParams.get('scope') ?? '').split(' ');
    // The whole point of a separate YouTube grant: business.manage would
    // authorise perfectly and then fail at the upload with a 403.
    expect(scopes).toContain('https://www.googleapis.com/auth/youtube.upload');
    expect(scopes).not.toContain('https://www.googleapis.com/auth/business.manage');

    // A refresh token arrives only when both of these are sent.
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');

    // Derived from the host, because YOUTUBE_REDIRECT_URI is unset.
    expect(url.searchParams.get('redirect_uri')).toBe(`${BASE}/api/integrations/youtube/callback`);
    expect(url.toString()).not.toContain('google-secret-1');
  });

  it('sends LinkedIn to LinkedIn, not to Meta or Google', async () => {
    const result = await beginAuthorization({
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      platform: Platform.LINKEDIN,
      baseUrl: BASE,
    });

    const url = new URL(result.redirectTo);
    expect(url.origin).toBe('https://www.linkedin.com');
    expect(url.searchParams.get('scope')).toContain('w_organization_social');
    expect(url.searchParams.get('redirect_uri')).toBe(`${BASE}/api/integrations/linkedin/callback`);
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.toString()).not.toContain('linkedin-secret-1');
  });

  it('refuses to start when the provider is not configured', async () => {
    delete process.env.LINKEDIN_CLIENT_SECRET;

    await expect(
      beginAuthorization({
        organizationId: alpha.organizationId,
        clientId: alpha.clientId,
        platform: Platform.LINKEDIN,
        baseUrl: BASE,
      }),
    ).rejects.toThrow(/LINKEDIN_CLIENT_SECRET/);
  });

  // -------------------------------------------------------------- callback

  it('stores an encrypted YouTube token and discovers the channel', async () => {
    const { state } = await issueState({
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      platform: Platform.YOUTUBE,
      redirectUri: callbackUrl(BASE, Platform.YOUTUBE),
    });

    const result = await completeCallback({
      platform: Platform.YOUTUBE,
      state,
      code: 'yt-auth-code',
      fetchImpl: youtubeFetch(),
    });

    // The channel id is what identifies the asset; a Google `sub` would not.
    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0]!.kind).toBe('PROFILE');
    expect(result.discovered[0]!.externalId).toBe('UC_pawse_channel');
    expect(result.discovered[0]!.name).toBe('Pawse Kitchen');

    const integration = await prisma.integration.findUniqueOrThrow({ where: { id: result.integrationId } });
    expect(integration.accessTokenEnc?.startsWith('v1.')).toBe(true);
    expect(integration.accessTokenEnc).not.toContain('YT-ACCESS-TOKEN');
    expect(decryptSecret(integration.accessTokenEnc!)).toBe('YT-ACCESS-TOKEN');
    // Google's offline grant is only useful if the refresh token is kept.
    expect(decryptSecret(integration.refreshTokenEnc!)).toBe('YT-REFRESH-TOKEN');
    // Nothing is attached until the operator chooses.
    expect(integration.status).toBe(IntegrationStatus.CONNECTING);

    const accounts = await prisma.integrationAccount.findMany({ where: { integrationId: integration.id } });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.selected).toBe(false);
    expect(decryptSecret(accounts[0]!.accessTokenEnc!)).toBe('YT-ACCESS-TOKEN');
  });

  it('discovers a LinkedIn organization by the numeric id the publisher posts as', async () => {
    const { state } = await issueState({
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      platform: Platform.LINKEDIN,
      redirectUri: callbackUrl(BASE, Platform.LINKEDIN),
    });

    const result = await completeCallback({
      platform: Platform.LINKEDIN,
      state,
      code: 'li-auth-code',
      fetchImpl: linkedInFetch(),
    });

    expect(result.discovered).toHaveLength(1);
    const [account] = result.discovered;
    expect(account!.kind).toBe('PAGE');
    /*
     * `publishing/linkedin.ts` builds `urn:li:organization:${externalId}`, so
     * this must be the bare numeric id. Storing the full URN here would produce
     * `urn:li:organization:urn:li:organization:8675309` at publish time.
     */
    expect(account!.externalId).toBe('8675309');
    expect(account!.name).toBe('Pawse');

    const integration = await prisma.integration.findUniqueOrThrow({ where: { id: result.integrationId } });
    expect(decryptSecret(integration.accessTokenEnc!)).toBe('LI-ACCESS-TOKEN');
  });

  it('connects LinkedIn even though it returned no refresh token', async () => {
    /*
     * LinkedIn issues a refresh token only to apps approved for programmatic
     * refresh. Google refuses a connection without one on purpose; doing the
     * same here would make every unapproved LinkedIn app unable to connect at
     * all, so the expiry is recorded instead.
     */
    const { state } = await issueState({
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      platform: Platform.LINKEDIN,
      redirectUri: callbackUrl(BASE, Platform.LINKEDIN),
    });

    const result = await completeCallback({
      platform: Platform.LINKEDIN,
      state,
      code: 'li-auth-code',
      fetchImpl: linkedInFetch({
        token: { access_token: 'LI-NO-REFRESH', expires_in: 5184000, scope: 'w_organization_social' },
      }),
    });

    const integration = await prisma.integration.findUniqueOrThrow({ where: { id: result.integrationId } });
    expect(integration.refreshTokenEnc).toBeNull();
    expect(integration.tokenExpiresAt).toBeTruthy();
    expect(decryptSecret(integration.accessTokenEnc!)).toBe('LI-NO-REFRESH');
  });

  it('ignores LinkedIn assignments that are not approved organization admin roles', async () => {
    const { state } = await issueState({
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      platform: Platform.LINKEDIN,
      redirectUri: callbackUrl(BASE, Platform.LINKEDIN),
    });

    const result = await completeCallback({
      platform: Platform.LINKEDIN,
      state,
      code: 'li-auth-code',
      fetchImpl: linkedInFetch({
        acls: {
          elements: [
            { organization: 'urn:li:organization:8675309', role: 'ADMINISTRATOR', state: 'APPROVED' },
            // A person, not a page: not something that can be posted as.
            { organization: 'urn:li:person:abc123', role: 'ADMINISTRATOR', state: 'APPROVED' },
            // Malformed URNs must not become an organization id of their own.
            { organization: 'not-a-urn', role: 'ADMINISTRATOR', state: 'APPROVED' },
            { role: 'ADMINISTRATOR', state: 'APPROVED' },
          ],
        },
      }),
    });

    expect(result.discovered.map((account) => account.externalId)).toEqual(['8675309']);
  });

  it('records the grant the provider returned, not the one requested', async () => {
    const { state } = await issueState({
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      platform: Platform.YOUTUBE,
      redirectUri: callbackUrl(BASE, Platform.YOUTUBE),
    });

    const result = await completeCallback({
      platform: Platform.YOUTUBE,
      state,
      code: 'yt-auth-code',
      fetchImpl: youtubeFetch(),
    });

    const integration = await prisma.integration.findUniqueOrThrow({ where: { id: result.integrationId } });
    expect(integration.scopes).toContain('https://www.googleapis.com/auth/youtube.upload');
  });

  it('reports a login that owns no channel as empty rather than as an error', async () => {
    // A Google account that never created a channel is a real state, and the
    // fix is on YouTube's side. An exception here would read as a broken app.
    const { state } = await issueState({
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      platform: Platform.YOUTUBE,
      redirectUri: callbackUrl(BASE, Platform.YOUTUBE),
    });

    const result = await completeCallback({
      platform: Platform.YOUTUBE,
      state,
      code: 'yt-auth-code',
      fetchImpl: youtubeFetch({ channels: { items: [] } }),
    });

    expect(result.discovered).toEqual([]);
  });
});

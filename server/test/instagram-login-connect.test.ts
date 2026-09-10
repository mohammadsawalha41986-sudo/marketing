/**
 * Instagram Login: connecting an Instagram Professional account with no Page.
 *
 * The defect this closes is not a bug in the Meta flow — that flow is correct
 * for what it covers. It is that a restaurant whose Instagram account was never
 * linked to a Facebook Page could not connect at all: pressing Connect on
 * Instagram sent them to Facebook Login for Business, which has nothing to
 * grant for them, and the assets the callback went looking for do not exist.
 *
 * So the assertions here are about which provider Instagram is routed to, which
 * host issues its token, what is stored and in what form, and — deliberately —
 * that the Facebook connection is untouched by any of it.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IntegrationStatus, Platform } from '@prisma/client';
import request from 'supertest';

import { agent, app, createTenant, prisma, resetDatabase, type Tenant } from './helpers.js';
import { issueState } from '../src/services/integrations/oauth-state.js';
import {
  beginAuthorization,
  callbackUrl,
  completeCallback,
  providerFor,
} from '../src/services/integrations/connect-flow.js';
import { decryptSecret } from '../src/lib/crypto.js';
import { INSTAGRAM_SCOPES } from '../src/services/integrations/instagram.js';
import type { FetchLike } from '../src/services/integrations/meta.js';

const KEY = 'Zm9yLXRlc3Rpbmctb25seS0zMi1ieXRlLWtleS0hIQ==';
const BASE = 'https://marketing-osserver-production.up.railway.app';
const APP_SECRET = 'instagram-secret-that-must-never-be-echoed';
const SHORT_TOKEN = 'IG-SHORT-LIVED-TOKEN';
const LONG_TOKEN = 'IG-LONG-LIVED-TOKEN';

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

/** Instagram's real response shapes, minus the network. */
function instagramFetch(overrides: { me?: unknown; permissions?: string } = {}): FetchLike {
  return stub([
    // The long-lived exchange is matched first: both live under /access_token,
    // and the short-lived route would otherwise swallow it.
    {
      match: 'ig_exchange_token',
      body: { access_token: LONG_TOKEN, token_type: 'bearer', expires_in: 5_184_000 },
    },
    {
      match: 'api.instagram.com/oauth/access_token',
      body: {
        access_token: SHORT_TOKEN,
        user_id: 17841400000000000,
        permissions: overrides.permissions
          ?? 'instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights',
      },
    },
    {
      match: 'graph.instagram.com',
      body: overrides.me ?? {
        user_id: '17841400000000000',
        username: 'zaytoun.kitchen',
        name: 'Zaytoun Kitchen',
        account_type: 'BUSINESS',
      },
    },
  ]);
}

describe('Instagram Login connection', () => {
  let alpha: Tenant;
  let beta: Tenant;
  const saved = { ...process.env };

  beforeAll(async () => {
    await resetDatabase();
    alpha = await createTenant('ig-login-alpha');
    beta = await createTenant('ig-login-beta');
  });

  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
    process.env.INSTAGRAM_APP_ID = '1122334455667788';
    process.env.INSTAGRAM_APP_SECRET = APP_SECRET;
    process.env.INSTAGRAM_REDIRECT_URI = callbackUrl(BASE, Platform.INSTAGRAM);
    // Meta stays configured throughout, so every "Facebook is unaffected"
    // assertion below is about routing rather than about missing credentials.
    process.env.META_APP_ID = '1821333942563322';
    process.env.META_APP_SECRET = 'meta-secret';
    process.env.META_REDIRECT_URI = callbackUrl(BASE, Platform.FACEBOOK);
    process.env.META_CONFIG_ID = 'login-config-1';
  });

  afterEach(() => {
    for (const key of [
      'TOKEN_ENCRYPTION_KEY',
      'INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET', 'INSTAGRAM_REDIRECT_URI',
      'META_APP_ID', 'META_APP_SECRET', 'META_REDIRECT_URI', 'META_CONFIG_ID',
    ]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  // ------------------------------------------------------------- routing

  it('routes Instagram to its own provider and leaves Facebook on Meta', () => {
    expect(providerFor(Platform.INSTAGRAM)).toBe('INSTAGRAM');
    expect(providerFor(Platform.FACEBOOK)).toBe('META');
  });

  it('documents a callback of its own, not Meta\'s', () => {
    expect(callbackUrl(BASE, Platform.INSTAGRAM)).toBe(`${BASE}/api/integrations/instagram/callback`);
    expect(callbackUrl(BASE, Platform.FACEBOOK)).toBe(`${BASE}/api/integrations/meta/callback`);
  });

  // ----------------------------------------------------------- authorize

  it('sends the operator to Instagram with the three permissions the product uses', async () => {
    const result = await beginAuthorization({
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      platform: Platform.INSTAGRAM,
      baseUrl: BASE,
    });

    const url = new URL(result.redirectTo);
    expect(url.origin).toBe('https://www.instagram.com');
    expect(url.pathname).toBe('/oauth/authorize');
    expect(url.searchParams.get('scope')?.split(',')).toEqual([...INSTAGRAM_SCOPES]);
    expect(url.searchParams.get('redirect_uri')).toBe(`${BASE}/api/integrations/instagram/callback`);
    expect(url.searchParams.get('state')).toBeTruthy();
    // Messaging and comment permissions are not asked for.
    expect(url.searchParams.get('scope')).not.toContain('manage_messages');
    // Nothing secret ever travels in the browser's URL.
    expect(url.toString()).not.toContain(APP_SECRET);

    const integration = await prisma.integration.findUniqueOrThrow({ where: { id: result.integrationId } });
    expect(integration.status).toBe(IntegrationStatus.CONNECTING);
    expect(integration.accessTokenEnc).toBeNull();
  });

  it('answers 503 naming its own variables when Instagram is not configured', async () => {
    delete process.env.INSTAGRAM_APP_ID;
    const client = agent();
    await client.login(alpha.adminEmail);

    const response = await client.post(`/api/integrations/${alpha.clientId}/INSTAGRAM/connect`);

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('PROVIDER_NOT_CONFIGURED');
    expect(response.body.error.details.missingEnv).toContain('INSTAGRAM_APP_ID');
    // The Facebook app being present must not make Instagram look configured.
    expect(response.body.error.details.missingEnv).not.toContain('META_APP_ID');
  });

  it('refuses to start a connection for another tenant\'s client', async () => {
    const client = agent();
    await client.login(alpha.adminEmail);
    const response = await client.post(`/api/integrations/${beta.clientId}/INSTAGRAM/connect`);
    expect(response.status).toBe(404);
  });

  // ------------------------------------------------------------ callback

  it('mounts the callback the authorize URL points at', async () => {
    const response = await request(app).get(
      '/api/integrations/instagram/callback?code=abc&state=not-a-real-state',
    );

    expect(response.status).not.toBe(404);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(location.pathname).toBe('/app/integrations');
    // An unknown state is refused: the state is the authorisation.
    expect(location.searchParams.get('error')).toBeTruthy();
  });

  it('never puts the authorization code in the redirect back to the app', async () => {
    const response = await request(app).get(
      '/api/integrations/instagram/callback?code=SENSITIVE-CODE&state=bogus',
    );
    expect(response.headers.location).not.toContain('SENSITIVE-CODE');
  });

  it('stores only the long-lived token, encrypted, and attaches the account', async () => {
    const { state } = await issueState({
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      platform: Platform.INSTAGRAM,
      redirectUri: callbackUrl(BASE, Platform.INSTAGRAM),
    });

    const result = await completeCallback({
      platform: Platform.INSTAGRAM,
      state,
      code: 'auth-code',
      fetchImpl: instagramFetch(),
    });

    expect(result.accountName).toBe('zaytoun.kitchen');
    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0]?.kind).toBe('INSTAGRAM');
    expect(result.discovered[0]?.externalId).toBe('17841400000000000');

    const integration = await prisma.integration.findUniqueOrThrow({ where: { id: result.integrationId } });

    // The hour-long token is never what gets stored.
    expect(decryptSecret(integration.accessTokenEnc!)).toBe(LONG_TOKEN);
    expect(integration.accessTokenEnc).not.toContain(LONG_TOKEN);
    expect(integration.accessTokenEnc?.startsWith('v1.')).toBe(true);
    expect(integration.tokenFingerprint).toHaveLength(12);
    expect(integration.tokenExpiresAt).toBeInstanceOf(Date);
    // The grant Instagram reported, not the list we asked for.
    expect(integration.scopes).toContain('instagram_business_content_publish');
    // Discovered, not connected: nothing has been chosen yet.
    expect(integration.status).toBe(IntegrationStatus.CONNECTING);

    const account = await prisma.integrationAccount.findFirstOrThrow({
      where: { integrationId: integration.id },
    });
    // The account carries its own copy of the credential, encrypted, which is
    // what the publisher posts with.
    expect(decryptSecret(account.accessTokenEnc!)).toBe(LONG_TOKEN);
    expect(account.clientId).toBe(alpha.clientId);
    // And the marker that says which Graph host issued it.
    expect((account.metadata as { api?: string }).api).toBe('instagram_login');
  });

  it('binds the state to one client and one provider', async () => {
    // A state minted for beta's Instagram flow cannot be redeemed as alpha's,
    // and one minted for Instagram cannot be redeemed on the Meta callback.
    const { state } = await issueState({
      organizationId: beta.organizationId,
      clientId: beta.clientId,
      platform: Platform.INSTAGRAM,
      redirectUri: callbackUrl(BASE, Platform.INSTAGRAM),
    });

    await expect(
      completeCallback({
        platform: Platform.FACEBOOK,
        state,
        code: 'auth-code',
        fetchImpl: instagramFetch(),
      }),
      // Refused at the state, before any token is exchanged for anybody.
    ).rejects.toThrow(/authorization/i);
  });

  it('refuses a login that returns no account id rather than attaching nothing', async () => {
    // The row the callback completes against is created by the authorize step.
    await beginAuthorization({
      organizationId: beta.organizationId,
      clientId: beta.clientId,
      platform: Platform.INSTAGRAM,
      baseUrl: BASE,
    });
    const { state } = await issueState({
      organizationId: beta.organizationId,
      clientId: beta.clientId,
      platform: Platform.INSTAGRAM,
      redirectUri: callbackUrl(BASE, Platform.INSTAGRAM),
    });

    await expect(
      completeCallback({
        platform: Platform.INSTAGRAM,
        state,
        code: 'auth-code',
        fetchImpl: instagramFetch({ me: { username: 'no-id-here' } }),
      }),
    ).rejects.toThrow(/account id/i);
  });
});

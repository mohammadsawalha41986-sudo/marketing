/**
 * OAuth state security and the Meta adapter.
 *
 * No credentials and no network: the state tests run against the real database,
 * and the adapter tests drive the real code with the exact JSON Meta returns,
 * injected through `fetchImpl`. That is what makes "implemented" a claim with
 * evidence behind it rather than an assertion about code that has never run.
 *
 * The state cases are the security ones. A state that can be replayed, or
 * redeemed for a different client, is the difference between an integration
 * layer and a way to attach an attacker's ad account to someone else's brand.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Platform } from '@prisma/client';

import { createTenant, prisma, resetDatabase, type Tenant } from './helpers.js';
import {
  InvalidOAuthStateError,
  consumeState,
  issueState,
  pkceChallenge,
  pruneExpiredStates,
} from '../src/services/integrations/oauth-state.js';
import {
  ProviderApiError,
  authorizationUrl,
  discoverAccounts,
  exchangeCode,
  fetchCampaigns,
  metaConfig,
  normalizeInsights,
  validateToken,
  type FetchLike,
} from '../src/services/integrations/meta.js';

const KEY = 'Zm9yLXRlc3Rpbmctb25seS0zMi1ieXRlLWtleS0hIQ==';

/** A fetch stub that answers by URL fragment and records what was asked for. */
function stubFetch(routes: Array<{ match: string; status?: number; body: unknown }>): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    const route = routes.find((entry) => url.includes(entry.match));
    if (!route) throw new Error(`No stub for ${url}`);
    return {
      ok: (route.status ?? 200) < 400,
      status: route.status ?? 200,
      json: async () => route.body,
      text: async () => JSON.stringify(route.body),
    };
  }) as FetchLike & { calls: string[] };
  impl.calls = calls;
  return impl;
}

describe('OAuth state', () => {
  let alpha: Tenant;
  let beta: Tenant;

  beforeAll(async () => {
    await resetDatabase();
    alpha = await createTenant('oauth-alpha');
    beta = await createTenant('oauth-beta');
  });

  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
  });

  const issue = (over: Partial<Parameters<typeof issueState>[0]> = {}) =>
    issueState({
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      platform: Platform.FACEBOOK,
      redirectUri: 'https://example.com/api/integrations/meta/callback',
      ...over,
    });

  it('issues an unguessable state and stores only its hash', async () => {
    const { state, transactionId } = await issue();

    expect(state.length).toBeGreaterThanOrEqual(32);
    const row = await prisma.oAuthTransaction.findUniqueOrThrow({ where: { id: transactionId } });
    expect(row.stateHash).not.toBe(state);
    expect(row.stateHash).toHaveLength(64); // sha-256 hex
    // The raw state must not be recoverable from the row.
    expect(JSON.stringify(row)).not.toContain(state);
  });

  it('never issues the same state twice', async () => {
    const seen = new Set<string>();
    for (let index = 0; index < 25; index += 1) seen.add((await issue()).state);
    expect(seen.size).toBe(25);
  });

  it('encrypts the PKCE verifier at rest and derives a matching challenge', async () => {
    const { codeVerifier, codeChallenge, transactionId } = await issue();
    const row = await prisma.oAuthTransaction.findUniqueOrThrow({ where: { id: transactionId } });

    expect(row.codeVerifierEnc).not.toContain(codeVerifier);
    expect(row.codeVerifierEnc?.startsWith('v1.')).toBe(true);
    expect(codeChallenge).toBe(pkceChallenge(codeVerifier));
  });

  it('accepts a valid state once and returns the flow it belongs to', async () => {
    const { state, codeVerifier } = await issue();
    const consumed = await consumeState({ state, platform: Platform.FACEBOOK });

    expect(consumed.clientId).toBe(alpha.clientId);
    expect(consumed.platform).toBe(Platform.FACEBOOK);
    expect(consumed.codeVerifier).toBe(codeVerifier);
  });

  it('rejects a replayed state', async () => {
    const { state } = await issue();
    await consumeState({ state, platform: Platform.FACEBOOK });

    await expect(consumeState({ state, platform: Platform.FACEBOOK })).rejects.toMatchObject({
      name: 'InvalidOAuthStateError',
      reason: 'ALREADY_USED',
    });
  });

  it('rejects an unknown state', async () => {
    await expect(consumeState({ state: 'never-issued', platform: Platform.FACEBOOK })).rejects.toMatchObject({
      reason: 'UNKNOWN_STATE',
    });
  });

  it('rejects an expired state', async () => {
    const { state } = await issue();
    const later = new Date(Date.now() + 60 * 60 * 1000);

    await expect(consumeState({ state, platform: Platform.FACEBOOK, now: later })).rejects.toMatchObject({
      reason: 'EXPIRED',
    });
  });

  it('refuses a state minted for another provider', async () => {
    const { state } = await issue();
    await expect(consumeState({ state, platform: Platform.TIKTOK })).rejects.toMatchObject({
      reason: 'PROVIDER_MISMATCH',
    });

    // And the rejected attempt must not have burned it for the right provider.
    await expect(consumeState({ state, platform: Platform.FACEBOOK })).resolves.toMatchObject({
      clientId: alpha.clientId,
    });
  });

  it('refuses a state minted for another client', async () => {
    const { state } = await issue();
    await expect(
      consumeState({ state, platform: Platform.FACEBOOK, expectedClientId: beta.clientId }),
    ).rejects.toMatchObject({ reason: 'CLIENT_MISMATCH' });
  });

  it('gives the same message whatever the reason, so the callback is not an oracle', async () => {
    const { state } = await issue();
    await consumeState({ state, platform: Platform.FACEBOOK });

    const replayed = await consumeState({ state, platform: Platform.FACEBOOK }).catch((error) => error as InvalidOAuthStateError);
    const unknown = await consumeState({ state: 'nope', platform: Platform.FACEBOOK }).catch((error) => error as InvalidOAuthStateError);

    expect(replayed.message).toBe(unknown.message);
    // The distinguishing detail is kept for logs, not for the response.
    expect(replayed.reason).not.toBe(unknown.reason);
  });

  it('only one of two concurrent callbacks can consume a state', async () => {
    const { state } = await issue();
    const results = await Promise.allSettled([
      consumeState({ state, platform: Platform.FACEBOOK }),
      consumeState({ state, platform: Platform.FACEBOOK }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('prunes states that can no longer be redeemed', async () => {
    await issue();
    const pruned = await pruneExpiredStates(new Date(Date.now() + 24 * 60 * 60 * 1000));
    expect(pruned).toBeGreaterThan(0);
  });
});

describe('Meta adapter', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.META_APP_ID = 'app-123';
    process.env.META_APP_SECRET = 'secret-456';
    process.env.META_REDIRECT_URI = 'https://example.com/api/integrations/meta/callback';
    process.env.META_CONFIG_ID = 'login-config-1';
  });
  afterEach(() => {
    for (const key of ['META_APP_ID', 'META_APP_SECRET', 'META_REDIRECT_URI', 'META_CONFIG_ID']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('refuses to build a config without credentials, naming them', () => {
    delete process.env.META_APP_SECRET;
    expect(() => metaConfig()).toThrow(/META_APP_SECRET/);
  });

  it('builds a real authorization URL carrying the state', () => {
    const url = new URL(authorizationUrl({ config: metaConfig(), state: 'the-state' }));

    expect(url.origin).toBe('https://www.facebook.com');
    expect(url.pathname).toContain('/dialog/oauth');
    expect(url.searchParams.get('client_id')).toBe('app-123');
    expect(url.searchParams.get('state')).toBe('the-state');
    expect(url.searchParams.get('response_type')).toBe('code');
    // The secret must never appear in a URL the browser will follow.
    expect(url.toString()).not.toContain('secret-456');
  });

  /*
   * Facebook Login for Business. The configuration in the app console owns both
   * the permission list and the asset-selection step that grants a specific Page
   * and ad account to the app; `config_id` is what runs it. Without this the
   * classic scope dialog ran, the operator authorised permissions, no assets
   * were ever assigned, and discovery returned nothing.
   */
  it('drives the Business Login configuration rather than a scope list', () => {
    const url = new URL(authorizationUrl({ config: metaConfig(), state: 'the-state' }));

    expect(url.searchParams.get('config_id')).toBe('login-config-1');
    // Business Login takes permissions from the configuration; sending both is
    // contradictory and falls back to classic consumer login.
    expect(url.searchParams.get('scope')).toBeNull();
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('https://example.com/api/integrations/meta/callback');
  });

  it('refuses to build a config without the login configuration id, naming it', () => {
    delete process.env.META_CONFIG_ID;
    expect(() => metaConfig()).toThrow(/META_CONFIG_ID/);
  });

  it('treats a whitespace-only configuration id as missing', () => {
    process.env.META_CONFIG_ID = '   ';
    expect(() => metaConfig()).toThrow(/META_CONFIG_ID/);
  });

  /*
   * A trailing newline is invisible in every hosting dashboard that edits these
   * values, and Meta rejected an app id for exactly this reason — percent-encoded
   * into client_id, `1821…%0A` is not a number to Graph.
   */
  it('strips whitespace pasted around the credentials', () => {
    process.env.META_APP_ID = ' 1821333942563322\n';
    process.env.META_CONFIG_ID = '\t login-config-1 ';

    const config = metaConfig();
    expect(config.appId).toBe('1821333942563322');
    expect(config.configId).toBe('login-config-1');

    const url = new URL(authorizationUrl({ config, state: 's' }));
    expect(url.searchParams.get('client_id')).toBe('1821333942563322');
    expect(url.toString()).not.toContain('%0A');
  });

  it('exchanges the code and trades up to a long-lived token', async () => {
    const fetchImpl = stubFetch([
      { match: 'fb_exchange_token', body: { access_token: 'long-lived-token', expires_in: 5184000 } },
      { match: 'oauth/access_token', body: { access_token: 'short-token', expires_in: 3600 } },
    ]);

    const now = new Date('2026-08-16T00:00:00.000Z');
    const tokens = await exchangeCode({ config: metaConfig(), code: 'auth-code', fetchImpl, now });

    expect(tokens.accessToken).toBe('long-lived-token');
    expect(tokens.expiresAt?.toISOString()).toBe('2026-10-15T00:00:00.000Z');
    // Meta issues no refresh token; claiming one would be fiction.
    expect(tokens.refreshToken).toBeNull();
    expect(fetchImpl.calls.some((url) => url.includes('fb_exchange_token'))).toBe(true);
  });

  it('surfaces a provider error message rather than a raw payload', async () => {
    const fetchImpl = stubFetch([
      { match: 'oauth/access_token', status: 400, body: { error: { message: 'This authorization code has expired.' } } },
    ]);

    await expect(exchangeCode({ config: metaConfig(), code: 'stale', fetchImpl })).rejects.toThrow(/has expired/);
    await expect(exchangeCode({ config: metaConfig(), code: 'stale', fetchImpl })).rejects.toBeInstanceOf(ProviderApiError);
  });

  it('validates a token against the real endpoint before trusting it', async () => {
    const fetchImpl = stubFetch([{ match: '/me?', body: { id: '999', name: 'Operator' } }]);
    await expect(validateToken({ accessToken: 'tok', fetchImpl })).resolves.toEqual({ id: '999', name: 'Operator' });
  });

  it('treats a rejected token as a failure, not as a connection', async () => {
    const fetchImpl = stubFetch([
      { match: '/me?', status: 401, body: { error: { message: 'Invalid OAuth access token.' } } },
    ]);
    await expect(validateToken({ accessToken: 'bad', fetchImpl })).rejects.toThrow(/Invalid OAuth access token/);
  });

  it('discovers pages, their Instagram accounts, ad accounts and businesses', async () => {
    const fetchImpl = stubFetch([
      {
        match: '/me/accounts',
        body: {
          data: [
            {
              id: 'page-1',
              name: 'Pawese',
              username: 'pawese',
              instagram_business_account: { id: 'ig-1', username: 'pawese', name: 'Pawese' },
            },
            { id: 'page-2', name: 'Second Page' },
          ],
        },
      },
      {
        match: '/me/adaccounts',
        body: {
          data: [
            {
              id: 'act_555',
              account_id: '555',
              name: 'Pawese Ads',
              currency: 'SAR',
              timezone_name: 'Asia/Riyadh',
              business: { id: 'biz-1', name: 'Pawese Business' },
            },
          ],
        },
      },
      { match: '/me/businesses', body: { data: [{ id: 'biz-1', name: 'Pawese Business' }] } },
    ]);

    const accounts = await discoverAccounts({ accessToken: 'tok', fetchImpl });
    const byKind = (kind: string) => accounts.filter((account) => account.kind === kind);

    expect(byKind('PAGE')).toHaveLength(2);
    expect(byKind('BUSINESS')).toHaveLength(1);

    const instagram = byKind('INSTAGRAM')[0];
    expect(instagram).toMatchObject({ externalId: 'ig-1', username: 'pawese', parentExternalId: 'page-1' });

    // Currency comes from the account, never defaulted to USD.
    const adAccount = byKind('AD_ACCOUNT')[0];
    expect(adAccount).toMatchObject({ externalId: 'act_555', currency: 'SAR', timezone: 'Asia/Riyadh' });

    // A page with no linked Instagram must not invent one.
    expect(byKind('INSTAGRAM')).toHaveLength(1);
  });

  it('normalizes campaigns and keeps the provider payload', async () => {
    const fetchImpl = stubFetch([
      {
        match: '/campaigns',
        body: {
          data: [
            {
              id: 'camp-1',
              name: 'Weekend Burger',
              status: 'ACTIVE',
              objective: 'OUTCOME_SALES',
              daily_budget: '15000',
              start_time: '2026-08-01T00:00:00+0000',
            },
          ],
        },
      },
    ]);

    const [campaign] = await fetchCampaigns({ adAccountId: 'act_555', accessToken: 'tok', fetchImpl });

    expect(campaign).toMatchObject({ externalId: 'camp-1', name: 'Weekend Burger', status: 'ACTIVE', budgetMinor: 15000 });
    expect(campaign?.startDate?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    // The raw provider object is preserved rather than discarded.
    expect(campaign?.metadata.raw).toBeTruthy();
  });

  it('reports that conversion tracking is absent instead of implying zero conversions', () => {
    const withoutActions = normalizeInsights([
      { date_start: '2026-08-01', spend: '120.50', impressions: '10000', reach: '8000', clicks: '300' },
    ]);

    expect(withoutActions.hasConversionTracking).toBe(false);
    expect(withoutActions.insights[0]).toMatchObject({ spend: 120.5, impressions: 10000, clicks: 300, conversions: 0 });

    const withActions = normalizeInsights([
      {
        date_start: '2026-08-01',
        spend: '120.50',
        actions: [{ action_type: 'offsite_conversion.fb_pixel_purchase', value: '12' }],
        action_values: [{ action_type: 'offsite_conversion.fb_pixel_purchase', value: '3400' }],
      },
    ]);

    expect(withActions.hasConversionTracking).toBe(true);
    expect(withActions.insights[0]).toMatchObject({ conversions: 12, conversionValue: 3400 });
  });
});

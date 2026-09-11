/**
 * Google Ads: the connection that could not previously be made.
 *
 * Google Ads shipped with a complete write path — campaigns, ad groups, ads,
 * all created PAUSED — attached to nothing. `connect-flow.ts` had no OAuth
 * provider mapped for `GOOGLE_ADS`, so `providerFor` threw; even had it been
 * routed to the Business Profile provider it would have asked for
 * `business.manage` and received a token that cannot call the Ads API at all;
 * and discovery returned Business Profile accounts, while the publish flow
 * looks for an account of kind AD_ACCOUNT and would never have found one.
 *
 * Three independent defects, each fatal on its own. These tests are written
 * against all three, plus the two things that are genuinely not the client's
 * to fix: the Cloud project's API access level, which no amount of
 * reconnecting can raise, and the manager account, which is not the account
 * that spends.
 *
 * No test mutates live advertising. Every provider call is a stub.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IntegrationStatus, Platform } from '@prisma/client';

import { createTenant, prisma, resetDatabase, type Tenant } from './helpers.js';
import { issueState } from '../src/services/integrations/oauth-state.js';
import {
  beginAuthorization,
  callbackPath,
  callbackUrl,
  completeCallback,
  providerFor,
} from '../src/services/integrations/connect-flow.js';
import {
  ADWORDS_SCOPE,
  GoogleAdsError,
  classifyAdsError,
  fetchCampaignReport,
  formatCustomerId,
  googleAdsConfig,
  googleAdsConfigured,
  listAccessibleCustomers,
  listCustomers,
} from '../src/services/integrations/google-ads.js';
import { adapterFor, providerReadiness } from '../src/services/integrations/index.js';
import { decryptSecret } from '../src/lib/crypto.js';
import type { FetchLike } from '../src/services/integrations/meta.js';

const KEY = 'Zm9yLXRlc3Rpbmctb25seS0zMi1ieXRlLWtleS0hIQ==';
const BASE = 'https://marketing.norivaglobal.com';

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

const TOKEN_RESPONSE = {
  access_token: 'ADS-ACCESS-TOKEN',
  refresh_token: 'ADS-REFRESH-TOKEN',
  expires_in: 3600,
  scope: `openid https://www.googleapis.com/auth/userinfo.email ${ADWORDS_SCOPE}`,
};

/** Google's token and userinfo, plus the Ads customer enumeration. */
function adsFetch(overrides: {
  token?: unknown;
  accessible?: unknown;
  customer?: unknown;
  customerStatus?: number;
} = {}): FetchLike {
  return stub([
    { match: 'oauth2.googleapis.com/token', body: overrides.token ?? TOKEN_RESPONSE },
    { match: 'oauth2/v3/userinfo', body: { sub: 'google-user-9', email: 'ops@noriva.sa' } },
    {
      match: 'customers:listAccessibleCustomers',
      body: overrides.accessible ?? { resourceNames: ['customers/1234567890'] },
    },
    {
      match: 'googleAds:search',
      status: overrides.customerStatus,
      body: overrides.customer ?? {
        results: [{
          customer: {
            id: '1234567890',
            descriptiveName: 'Pawse Kitchen',
            currencyCode: 'SAR',
            timeZone: 'Asia/Riyadh',
            manager: false,
            testAccount: false,
          },
        }],
      },
    },
  ]);
}

describe('google ads connectivity', () => {
  let alpha: Tenant;
  let beta: Tenant;
  const saved = { ...process.env };

  beforeAll(async () => {
    await resetDatabase();
    alpha = await createTenant('gads-a');
    beta = await createTenant('gads-b');
  });

  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
    // One NORIVA OAuth application, shared with Business Profile and YouTube.
    process.env.GOOGLE_CLIENT_ID = 'google-client-1';
    process.env.GOOGLE_CLIENT_SECRET = 'google-secret-1';
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN = 'dev-token-1';
    // Left unset so these tests also cover the derive-from-host path that a
    // deployment gets by default.
    delete process.env.GOOGLE_ADS_REDIRECT_URI;
    delete process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  });

  afterEach(() => {
    for (const key of [
      'TOKEN_ENCRYPTION_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
      'GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_REDIRECT_URI', 'GOOGLE_ADS_LOGIN_CUSTOMER_ID',
    ]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  // ------------------------------------------------------ provider mapping

  it('maps Google Ads to its own provider instead of throwing', () => {
    // The first defect: `providerFor` threw "has no OAuth integration" here.
    expect(providerFor(Platform.GOOGLE_ADS)).toBe('GOOGLE_ADS');
    // And Business Profile must not have been dragged along with it.
    expect(providerFor(Platform.GOOGLE_BUSINESS)).toBe('GOOGLE');
  });

  it('lands on its own callback route, not Business Profile\'s', () => {
    /*
     * The state is bound to one platform and the route is the independent
     * witness of which provider redirected. Sharing Business Profile's route
     * would mean reading the platform out of the state instead of checking the
     * state against it — deleting the check rather than passing it.
     */
    expect(callbackPath(Platform.GOOGLE_ADS)).toBe('/api/integrations/google-ads/callback');
    expect(callbackPath(Platform.GOOGLE_BUSINESS)).toBe('/api/integrations/google/callback');
    expect(callbackUrl(BASE, Platform.GOOGLE_ADS))
      .toBe('https://marketing.norivaglobal.com/api/integrations/google-ads/callback');
  });

  // -------------------------------------------------------- authorize step

  it('requests the adwords scope with offline access', async () => {
    const result = await beginAuthorization({
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      platform: Platform.GOOGLE_ADS,
      baseUrl: BASE,
    });

    const url = new URL(result.redirectTo);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');

    const scopes = (url.searchParams.get('scope') ?? '').split(' ');
    // The second defect: without this the token cannot call the Ads API at all.
    expect(scopes).toContain(ADWORDS_SCOPE);
    // Business Profile's scope must not be dragged in by sharing the client.
    expect(scopes).not.toContain('https://www.googleapis.com/auth/business.manage');

    // Both, always — this is what makes Google issue a refresh token.
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('redirect_uri'))
      .toBe('https://marketing.norivaglobal.com/api/integrations/google-ads/callback');
  });

  it('starts a flow with no developer token at all', async () => {
    /*
     * Google sunset developer tokens on 9 September 2026 and the API ignores
     * the header; access attaches to the Cloud project behind the OAuth
     * client. Requiring one would refuse a connection Google would answer.
     */
    delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN;

    const result = await beginAuthorization({
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      platform: Platform.GOOGLE_ADS,
      baseUrl: BASE,
    });

    expect(new URL(result.redirectTo).searchParams.get('scope')).toContain(ADWORDS_SCOPE);
    expect(googleAdsConfigured()).toBe(true);
    expect(googleAdsConfig().developerToken).toBeNull();
  });

  it('omits the developer-token header when none is held, and sends it when one is', async () => {
    const sent: Array<Record<string, string> | undefined> = [];
    const spy = (async (_url: string, init?: { headers?: Record<string, string> }) => {
      sent.push(init?.headers);
      const body = { resourceNames: [] };
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    }) as unknown as FetchLike;

    await listAccessibleCustomers({ accessToken: 'A', developerToken: null, fetchImpl: spy });
    expect(sent[0]).not.toHaveProperty('developer-token');

    // A deployment mid-migration keeps working: clearing the variable and
    // upgrading stay independent steps.
    await listAccessibleCustomers({ accessToken: 'A', developerToken: 'legacy', fetchImpl: spy });
    expect(sent[1]!['developer-token']).toBe('legacy');
  });

  // --------------------------------------------------------- callback step

  it('stores encrypted tokens and discovers the ad account', async () => {
    const state = await issueState({
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      platform: Platform.GOOGLE_ADS,
      redirectUri: callbackUrl(BASE, Platform.GOOGLE_ADS),
    });

    const result = await completeCallback({
      platform: Platform.GOOGLE_ADS,
      state: state.state,
      code: 'auth-code-1',
      fetchImpl: adsFetch(),
    });

    const integration = await prisma.integration.findFirstOrThrow({
      where: { id: result.integrationId },
      include: { accounts: true },
    });

    expect(integration.platform).toBe(Platform.GOOGLE_ADS);
    expect(integration.clientId).toBe(alpha.clientId);
    // Not CONNECTED yet: nothing has been attached.
    expect(integration.status).toBe(IntegrationStatus.CONNECTING);

    // Encrypted at rest, and the refresh token is kept — an hour-long access
    // token with nothing to renew it is a connection that dies overnight.
    expect(integration.accessTokenEnc).not.toBeNull();
    expect(integration.accessTokenEnc).not.toContain('ADS-ACCESS-TOKEN');
    expect(decryptSecret(integration.accessTokenEnc!)).toBe('ADS-ACCESS-TOKEN');
    expect(integration.refreshTokenEnc).not.toBeNull();
    expect(decryptSecret(integration.refreshTokenEnc!)).toBe('ADS-REFRESH-TOKEN');

    // The grant, not the request.
    expect(integration.scopes).toContain(ADWORDS_SCOPE);

    /*
     * The third defect: discovery used to return Business Profile accounts,
     * while the publish flow looks for AD_ACCOUNT and could never find one.
     */
    expect(integration.accounts).toHaveLength(1);
    const [account] = integration.accounts;
    expect(account!.kind).toBe('AD_ACCOUNT');
    // The customer id, not the Google login that authorised it.
    expect(account!.externalId).toBe('1234567890');
    expect(account!.name).toBe('Pawse Kitchen');
  });

  it('keeps one tenant\'s authorization on its own client', async () => {
    // The integration row is created by `beginAuthorization`, which is also
    // what binds the state to this organisation and this client.
    await beginAuthorization({
      organizationId: beta.organizationId,
      clientId: beta.clientId,
      platform: Platform.GOOGLE_ADS,
      baseUrl: BASE,
    });

    const state = await issueState({
      organizationId: beta.organizationId,
      clientId: beta.clientId,
      platform: Platform.GOOGLE_ADS,
      redirectUri: callbackUrl(BASE, Platform.GOOGLE_ADS),
    });

    const result = await completeCallback({
      platform: Platform.GOOGLE_ADS,
      state: state.state,
      code: 'auth-code-2',
      fetchImpl: adsFetch(),
    });

    const integration = await prisma.integration.findFirstOrThrow({
      where: { id: result.integrationId },
      select: { organizationId: true, clientId: true },
    });

    // Beta's authorization lands on beta's client, never alpha's.
    expect(integration.organizationId).toBe(beta.organizationId);
    expect(integration.clientId).toBe(beta.clientId);
    expect(integration.clientId).not.toBe(alpha.clientId);
  });

  it('refuses an unknown state', async () => {
    await expect(completeCallback({
      platform: Platform.GOOGLE_ADS,
      state: 'not-a-real-state',
      code: 'auth-code-3',
      fetchImpl: adsFetch(),
    })).rejects.toThrow();
  });

  it('refuses a grant that arrives without a refresh token', async () => {
    const state = await issueState({
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      platform: Platform.GOOGLE_ADS,
      redirectUri: callbackUrl(BASE, Platform.GOOGLE_ADS),
    });

    /*
     * Refused rather than stored. An access token alone works for an hour and
     * then stops, with no way back except a reconnection nobody knows is
     * needed — a failure that surfaces days later as "Google went quiet".
     */
    await expect(completeCallback({
      platform: Platform.GOOGLE_ADS,
      state: state.state,
      code: 'auth-code-4',
      fetchImpl: adsFetch({ token: { ...TOKEN_RESPONSE, refresh_token: undefined } }),
    })).rejects.toThrow(/refresh token/i);
  });

  // ------------------------------------------------------------- discovery

  it('lists the accounts under a manager alongside it', async () => {
    const fetchImpl = stub([
      { match: 'customers:listAccessibleCustomers', body: { resourceNames: ['customers/9999999999'] } },
      {
        match: '/customers/9999999999/googleAds:search',
        body: {
          results: [
            // The manager itself, answered by the customer query.
            { customer: { id: '9999999999', descriptiveName: 'NORIVA Manager', manager: true, currencyCode: 'SAR' } },
            // Its children, answered by the customer_client query. One stub
            // serves both because the route matches on the URL, not the body.
            { customerClient: { id: '1111111111', descriptiveName: 'Branch One', manager: false, currencyCode: 'SAR' } },
            { customerClient: { id: '2222222222', descriptiveName: 'Branch Two', manager: false, currencyCode: 'SAR' } },
          ],
        },
      },
    ]);

    const { customers } = await listCustomers({
      accessToken: 'ADS-ACCESS-TOKEN',
      developerToken: 'dev-token-1',
      fetchImpl,
    });

    const ids = customers.map((customer) => customer.id);
    expect(ids).toContain('9999999999');
    expect(ids).toContain('1111111111');
    expect(ids).toContain('2222222222');

    // A manager is a real login target, and a poor one to attach for spend, so
    // it is returned marked rather than silently dropped or silently preferred.
    expect(customers.find((customer) => customer.id === '9999999999')?.manager).toBe(true);
    expect(customers.find((customer) => customer.id === '1111111111')?.managerCustomerId).toBe('9999999999');
  });

  it('survives one inaccessible customer among several', async () => {
    let call = 0;
    const fetchImpl = (async (url: string) => {
      if (url.includes('listAccessibleCustomers')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ resourceNames: ['customers/1111111111', 'customers/2222222222'] }),
          text: async () => JSON.stringify({ resourceNames: ['customers/1111111111', 'customers/2222222222'] }),
        };
      }
      call += 1;
      // The first customer is refused; the second must still be discovered.
      if (call === 1) {
        const body = { error: { message: 'User permission denied.', details: [] } };
        return { ok: false, status: 403, json: async () => body, text: async () => JSON.stringify(body) };
      }
      const body = { results: [{ customer: { id: '2222222222', descriptiveName: 'Survivor', manager: false } }] };
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    }) as FetchLike;

    const { customers, failures } = await listCustomers({
      accessToken: 'ADS-ACCESS-TOKEN',
      developerToken: 'dev-token-1',
      fetchImpl,
    });

    expect(customers.map((customer) => customer.id)).toEqual(['2222222222']);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.customerId).toBe('1111111111');
  });

  it('raises rather than reporting an empty list when every lookup is refused', async () => {
    /*
     * "This login has no ad accounts" and "every account was refused" need
     * different actions from the operator, so they must not be the same answer.
     */
    await expect(listCustomers({
      accessToken: 'ADS-ACCESS-TOKEN',
      developerToken: 'dev-token-1',
      fetchImpl: adsFetch({
        customerStatus: 403,
        customer: { error: { message: 'User permission denied.' } },
      }),
    })).rejects.toThrow(GoogleAdsError);
  });

  // -------------------------------------------------------- account choice

  it('attaches the chosen customer and connects the integration', async () => {
    const state = await issueState({
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      platform: Platform.GOOGLE_ADS,
      redirectUri: callbackUrl(BASE, Platform.GOOGLE_ADS),
    });

    const { integrationId } = await completeCallback({
      platform: Platform.GOOGLE_ADS,
      state: state.state,
      code: 'auth-code-5',
      fetchImpl: adsFetch(),
    });

    const { selectAccounts } = await import('../src/services/integrations/connect-flow.js');
    const account = await prisma.integrationAccount.findFirstOrThrow({ where: { integrationId } });

    const outcome = await selectAccounts({
      organizationId: alpha.organizationId,
      integrationId,
      accountIds: [account.id],
    });

    expect(outcome.status).toBe(IntegrationStatus.CONNECTED);
    expect(outcome.selected).toBe(1);
  });

  // ------------------------------------------------------------- reporting

  it('reads daily campaign performance and converts micros', async () => {
    const rows = await fetchCampaignReport({
      customerId: '1234567890',
      accessToken: 'ADS-ACCESS-TOKEN',
      developerToken: 'dev-token-1',
      since: '2026-09-01',
      until: '2026-09-02',
      fetchImpl: stub([{
        match: 'googleAds:search',
        body: {
          results: [{
            campaign: { id: '55', name: 'Ramadan', status: 'ENABLED', advertisingChannelType: 'SEARCH' },
            campaignBudget: { amountMicros: '50000000' },
            segments: { date: '2026-09-01' },
            metrics: {
              impressions: '1200', clicks: '48', costMicros: '17500000',
              conversions: 3, conversionsValue: 420.5,
            },
          }],
        },
      }]),
    });

    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row!.campaignId).toBe('55');
    expect(row!.date).toBe('2026-09-01');
    expect(row!.impressions).toBe(1200);
    expect(row!.clicks).toBe(48);
    // Micros are millionths: 17,500,000 micros is 17.50 in account currency.
    expect(row!.cost).toBeCloseTo(17.5, 6);
    expect(row!.dailyBudget).toBeCloseTo(50, 6);
    expect(row!.conversionValue).toBeCloseTo(420.5, 6);
  });

  it('returns an empty report rather than inventing rows when Google has no data', async () => {
    const rows = await fetchCampaignReport({
      customerId: '1234567890',
      accessToken: 'ADS-ACCESS-TOKEN',
      developerToken: 'dev-token-1',
      since: '2026-09-01',
      until: '2026-09-02',
      fetchImpl: stub([{ match: 'googleAds:search', body: {} }]),
    });

    expect(rows).toEqual([]);
  });

  it('refuses a date range that is not YYYY-MM-DD', async () => {
    // GAQL has no bind parameters, so the dates are interpolated — and are
    // therefore constrained before they can reach the query as free text.
    await expect(fetchCampaignReport({
      customerId: '1234567890',
      accessToken: 'ADS-ACCESS-TOKEN',
      developerToken: 'dev-token-1',
      since: "2026-09-01' OR '1'='1",
      until: '2026-09-02',
      fetchImpl: stub([{ match: 'googleAds:search', body: {} }]),
    })).rejects.toThrow(/YYYY-MM-DD/);
  });

  // -------------------------------------------------------- error handling

  it('separates an access-level failure from an expired authorisation', () => {
    /*
     * The distinction that matters most: a Cloud project without the access it
     * needs fails every call, and telling the operator to reconnect is advice
     * that cannot possibly work, because the limit is the deployment's.
     */
    // A legacy developer-token refusal and a Cloud-project access refusal are
    // the same fact now, and carry the same remedy: raise access with Google.
    expect(classifyAdsError('The developer token is not approved.', 403)).toBe('ACCESS_LEVEL');
    expect(classifyAdsError('Your access level does not permit this.', 403)).toBe('ACCESS_LEVEL');
    expect(classifyAdsError('Daily operation limit reached.', 429)).toBe('ACCESS_LEVEL');
    expect(classifyAdsError('Request had invalid authentication credentials.', 401)).toBe('INVALID_TOKEN');
    expect(classifyAdsError('User permission denied.', 403)).toBe('NOT_AUTHORIZED');
    expect(classifyAdsError('Resource has been exhausted.', 429)).toBe('RATE_LIMITED');
    expect(classifyAdsError('Internal error.', 503)).toBe('PROVIDER_UNAVAILABLE');
  });

  it('explains failures in Google Ads\' own name, without leaking the message', () => {
    const error = new GoogleAdsError(401, 'Google Ads customer: invalid_grant for token ya29.SECRET');

    expect(error.explanation).toMatch(/Google Ads/);
    // The operator-facing text is fixed per failure, so no provider message —
    // and nothing a provider message might carry — reaches a screen.
    expect(error.explanation).not.toContain('ya29');
    expect(error.explanation).not.toMatch(/Meta|Business Profile/);
  });

  // ----------------------------------------------------------- card status

  it('reports READY TO CONNECT when configured, NOT CONFIGURED when not', () => {
    const adapter = adapterFor(Platform.GOOGLE_ADS);

    // "Ready to connect" is two facts: the code exists, and the credentials do.
    expect(adapter.implementation.oauth).toBe('IMPLEMENTED');
    expect(adapter.implementation.accountDiscovery).toBe('IMPLEMENTED');
    expect(adapter.oauth().scopes).toContain(ADWORDS_SCOPE);
    expect(providerReadiness(adapter).state).toBe('READY');

    // Neither of the two variables Google Ads does not need.
    expect(adapter.oauth().requiredEnv).not.toContain('GOOGLE_REDIRECT_URI');
    expect(adapter.oauth().requiredEnv).not.toContain('GOOGLE_ADS_DEVELOPER_TOKEN');

    // Still READY with no developer token: access is the Cloud project's now.
    delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    expect(providerReadiness(adapter).state).toBe('READY');

    delete process.env.GOOGLE_CLIENT_SECRET;
    const missing = providerReadiness(adapter);
    expect(missing.state).toBe('NOT_CONFIGURED');
    expect(missing.missingEnv).toContain('GOOGLE_CLIENT_SECRET');
  });

  it('knows whether it is configured without throwing', () => {
    expect(googleAdsConfigured()).toBe(true);
    expect(googleAdsConfig().developerToken).toBe('dev-token-1');

    delete process.env.GOOGLE_CLIENT_ID;
    expect(googleAdsConfigured()).toBe(false);
    expect(() => googleAdsConfig()).toThrow(/GOOGLE_CLIENT_ID/);
  });

  it('keeps its scope constant identical to the one google.ts names', async () => {
    /*
     * `ADWORDS_SCOPE` is spelled out here rather than read from `google.ts`
     * because the two modules sit in an import cycle and a top-level read
     * across it resolves to undefined depending on entry order. This is the
     * guard that the deliberate duplication has not drifted.
     */
    const { FUTURE_SCOPES } = await import('../src/services/integrations/google.js');
    expect(ADWORDS_SCOPE).toBe(FUTURE_SCOPES.ads);
  });

  it('formats a customer id the way Google Ads shows it', () => {
    expect(formatCustomerId('1234567890')).toBe('123-456-7890');
    expect(formatCustomerId('123-456-7890')).toBe('123-456-7890');
  });

  // ------------------------------------------------- existing integrations

  it('leaves the other Google platforms routed exactly as they were', () => {
    // The whole point of a shared OAuth client is that adding a product to it
    // changes nothing about the products already on it.
    expect(providerFor(Platform.GOOGLE_BUSINESS)).toBe('GOOGLE');
    expect(providerFor(Platform.YOUTUBE)).toBe('YOUTUBE');
    expect(providerFor(Platform.FACEBOOK)).toBe('META');
    expect(providerFor(Platform.INSTAGRAM)).toBe('INSTAGRAM');
    expect(providerFor(Platform.TIKTOK)).toBe('TIKTOK');

    expect(callbackPath(Platform.GOOGLE_BUSINESS)).toBe('/api/integrations/google/callback');
    expect(callbackPath(Platform.YOUTUBE)).toBe('/api/integrations/youtube/callback');
    expect(callbackPath(Platform.FACEBOOK)).toBe('/api/integrations/meta/callback');
  });
});

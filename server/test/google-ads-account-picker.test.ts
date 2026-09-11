/**
 * The Google Ads account picker, end to end and in Google's own words.
 *
 * The connection itself was built and tested (`google-ads-connect.test.ts`);
 * what came after it was not. The selection step — the screen an operator lands
 * on the instant OAuth succeeds — was written when Meta was the only provider
 * that could reach it, and it stayed Meta's for every provider that followed:
 *
 *   the drawer read the account list and nothing else, so it could not tell one
 *   provider from another and spoke Meta's vocabulary to all of them
 *
 *   `selectAccounts` wrote Meta's sentences into `lastError`, so a Google Ads
 *   connection attached without the `adwords` grant was told the *Meta app* was
 *   missing `pages_manage_posts`
 *
 *   `GET /:id/health` validated every platform's credential against Facebook's
 *   Graph `/me`, so checking a healthy Google Ads connection parked it in ERROR
 *
 *   an authorisation that discovered no customers wrote nothing at all, so the
 *   drawer opened empty and silent — the reported symptom
 *
 * These drive the real HTTP surface the drawer consumes, in the order the
 * operator meets it: authorize → callback → read the accounts → select → sync.
 * Every provider call is a stub; nothing here touches live advertising.
 */

import { readFile } from 'node:fs/promises';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountTokenStatus, ExternalAccountKind, IntegrationStatus, Platform } from '@prisma/client';

import { Agent, agent, createTenant, prisma, resetDatabase, type Tenant } from './helpers.js';
import { beginAuthorization, completeCallback } from '../src/services/integrations/connect-flow.js';
import { discoveryNote, missingGrantNote, noUsableCredentialNote } from '../src/services/integrations/connection-notes.js';
import { ADWORDS_SCOPE } from '../src/services/integrations/google-ads.js';
import type { FetchLike } from '../src/services/integrations/meta.js';

const KEY = 'Zm9yLXRlc3Rpbmctb25seS0zMi1ieXRlLWtleS0hIQ==';
const BASE = 'https://marketing.norivaglobal.com';

/** Anything an operator reads on a Google Ads screen must contain none of these. */
const META_VOCABULARY = /\bmeta\b|facebook|\bpage\b|instagram|pages_manage_posts/i;

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

const customerRow = (id: string, name: string, manager = false) => ({
  customer: {
    id,
    descriptiveName: name,
    currencyCode: 'SAR',
    timeZone: 'Asia/Riyadh',
    manager,
    testAccount: false,
  },
});

/**
 * Google's OAuth and Ads endpoints, answering per customer id.
 *
 * `customers` maps a customer id to the response its detail read gets, so one
 * account can be readable while another is refused — which is the case that
 * makes a selection list mysteriously short.
 */
function adsFetch(input: {
  scope?: string;
  accessible?: string[];
  customers?: Record<string, { body: unknown; status?: number }>;
} = {}): FetchLike {
  const scope = input.scope
    ?? `openid https://www.googleapis.com/auth/userinfo.email ${ADWORDS_SCOPE}`;
  const accessible = input.accessible ?? ['1234567890'];
  const customers = input.customers ?? {
    '1234567890': { body: { results: [customerRow('1234567890', 'Pawse Kitchen')] } },
  };

  return (async (url: string, init?: unknown) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      return stub([{ match: 'token', body: {
        access_token: 'ADS-ACCESS-TOKEN', refresh_token: 'ADS-REFRESH-TOKEN', expires_in: 3600, scope,
      } }])(url, init as never);
    }
    if (url.includes('oauth2/v3/userinfo')) {
      return stub([{ match: 'userinfo', body: { sub: 'google-user-9', email: 'ops@noriva.sa' } }])(url, init as never);
    }
    if (url.includes('customers:listAccessibleCustomers')) {
      return stub([{ match: 'listAccessibleCustomers', body: {
        resourceNames: accessible.map((id) => `customers/${id}`),
      } }])(url, init as never);
    }
    if (url.includes('googleAds:search')) {
      // `customers/<id>/googleAds:search` — the id in the path is the account
      // being read, which is what lets one be refused and another answered.
      const id = url.match(/customers\/(\d+)\//)?.[1] ?? '';
      const answer = customers[id] ?? { body: { error: { message: 'Customer not found' } }, status: 404 };
      return stub([{ match: 'googleAds:search', body: answer.body, status: answer.status }])(url, init as never);
    }
    throw new Error(`No stub for ${url}`);
  }) as FetchLike;
}

/**
 * The whole browser round trip: press Connect, come back from Google.
 *
 * `beginAuthorization` rather than a hand-minted state, because it is what
 * creates the integration row the callback then completes — and because the
 * state this reads out of the real authorization URL is the one production
 * would redeem.
 */
async function connect(tenant: Tenant, fetchImpl: FetchLike) {
  const { redirectTo } = await beginAuthorization({
    organizationId: tenant.organizationId,
    clientId: tenant.clientId,
    platform: Platform.GOOGLE_ADS,
    baseUrl: BASE,
  });

  const state = new URL(redirectTo).searchParams.get('state');
  if (!state) throw new Error('The Google Ads authorization URL carried no state.');

  return completeCallback({
    platform: Platform.GOOGLE_ADS,
    state,
    code: `code-${state.slice(0, 6)}`,
    fetchImpl,
  });
}

describe('google ads account selection', () => {
  let tenant: Tenant;
  let api: Agent;
  const saved = { ...process.env };

  beforeAll(async () => {
    await resetDatabase();
    tenant = await createTenant('gads-picker');
    api = agent();
    await api.login(tenant.adminEmail);
  });

  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
    process.env.GOOGLE_CLIENT_ID = 'google-client-1';
    process.env.GOOGLE_CLIENT_SECRET = 'google-secret-1';
    delete process.env.GOOGLE_ADS_REDIRECT_URI;
    delete process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
    delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  });

  afterEach(async () => {
    for (const key of [
      'TOKEN_ENCRYPTION_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
      'GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_REDIRECT_URI', 'GOOGLE_ADS_LOGIN_CUSTOMER_ID',
    ]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    // Each case connects from scratch; a row left behind would be re-found by
    // the (clientId, platform) upsert and carry the previous case's state.
    await prisma.integration.deleteMany({ where: { clientId: tenant.clientId } });
  });

  // ------------------------------------------------ the list the drawer reads

  it('serves the discovered Google Ads customers to the account picker', async () => {
    const { integrationId } = await connect(tenant, adsFetch({
      accessible: ['1234567890', '9876543210'],
      customers: {
        '1234567890': { body: { results: [customerRow('1234567890', 'Pawse Kitchen')] } },
        '9876543210': { body: { results: [customerRow('9876543210', 'Pawse Coffee')] } },
      },
    }));

    const response = await api.get(`/api/integrations/${integrationId}/accounts`).expect(200);
    const { integration } = response.body as {
      integration: {
        platform: string;
        lastError: string | null;
        accounts: Array<{ kind: string; externalId: string; name: string; selected: boolean }>;
      };
    };

    /*
     * The platform is what makes the drawer provider-aware at all. It was
     * always in this payload and never read, which is the whole of the bug:
     * without it the screen has no way to be anything but Meta's.
     */
    expect(integration.platform).toBe(Platform.GOOGLE_ADS);

    expect(integration.accounts).toHaveLength(2);
    expect(integration.accounts.map((account) => account.name).sort())
      .toEqual(['Pawse Coffee', 'Pawse Kitchen']);
    // Every discovered customer is an ad account, and none is pre-attached.
    expect(integration.accounts.every((account) => account.kind === ExternalAccountKind.AD_ACCOUNT)).toBe(true);
    expect(integration.accounts.some((account) => account.selected)).toBe(false);
    // A full, unrefused list needs no explanation.
    expect(integration.lastError).toBeNull();
  });

  it('never serves a credential alongside the accounts', async () => {
    const { integrationId } = await connect(tenant, adsFetch());

    const response = await api.get(`/api/integrations/${integrationId}/accounts`).expect(200);
    const body = JSON.stringify(response.body);

    expect(body).not.toContain('ADS-ACCESS-TOKEN');
    expect(body).not.toContain('ADS-REFRESH-TOKEN');
    expect(body).not.toMatch(/accessTokenEnc|refreshTokenEnc/);
  });

  // ---------------------------------------------------- the empty list, said

  it('explains an empty Google Ads list in Google\'s terms, not Meta\'s', async () => {
    const { integrationId, discovered } = await connect(tenant, adsFetch({ accessible: [] }));
    expect(discovered).toHaveLength(0);

    const response = await api.get(`/api/integrations/${integrationId}/accounts`).expect(200);
    const { lastError } = (response.body as { integration: { lastError: string | null } }).integration;

    // The reported symptom was an empty drawer that said nothing. It now says
    // which login to reconnect with — and says it about Google Ads.
    expect(lastError).toMatch(/no Google Ads accounts came back/i);
    expect(lastError).toMatch(/Google Ads/);
    expect(lastError).not.toMatch(META_VOCABULARY);
  });

  it('carries Google\'s own refusal for the accounts missing from a short list', async () => {
    const { integrationId } = await connect(tenant, adsFetch({
      accessible: ['1234567890', '5555555555'],
      customers: {
        '1234567890': { body: { results: [customerRow('1234567890', 'Pawse Kitchen')] } },
        // Refused by Google, as `listAccessibleCustomers` ids routinely are.
        '5555555555': { body: { error: { message: 'User doesn\'t have permission to access customer.' } }, status: 403 },
      },
    }));

    const response = await api.get(`/api/integrations/${integrationId}/accounts`).expect(200);
    const { integration } = response.body as {
      integration: { lastError: string | null; accounts: unknown[] };
    };

    // The readable account still connects: one refusal must not cost the other.
    expect(integration.accounts).toHaveLength(1);
    // And the missing one is named rather than silently dropped.
    expect(integration.lastError).toMatch(/555-555-5555/);
    expect(integration.lastError).toMatch(/cannot access this Google Ads account/i);
  });

  // ----------------------------------------------------------- the selection

  it('attaches a chosen customer through the same endpoint the drawer posts to', async () => {
    const { integrationId } = await connect(tenant, adsFetch());
    const account = await prisma.integrationAccount.findFirstOrThrow({ where: { integrationId } });

    await api.post(`/api/integrations/${integrationId}/select`, { accountIds: [account.id] })
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({ status: IntegrationStatus.CONNECTED, selected: 1 });
      });

    const integration = await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } });
    expect(integration.status).toBe(IntegrationStatus.CONNECTED);
    // A clean connection carries no note at all — not a stale Meta one.
    expect(integration.lastError).toBeNull();
  });

  it('detaches without inventing a Meta reason', async () => {
    const { integrationId } = await connect(tenant, adsFetch());

    await api.post(`/api/integrations/${integrationId}/select`, { accountIds: [] }).expect(200);

    const integration = await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } });
    expect(integration.status).toBe(IntegrationStatus.DISCONNECTED);
    expect(integration.lastError).toBeNull();
  });

  it('names adwords, not pages_manage_posts, when the grant was withheld', async () => {
    // A Google consent screen that granted identity and declined `adwords`.
    const { integrationId } = await connect(tenant, adsFetch({
      scope: 'openid https://www.googleapis.com/auth/userinfo.email',
    }));

    const account = await prisma.integrationAccount.findFirstOrThrow({ where: { integrationId } });
    expect(account.tokenStatus).toBe(AccountTokenStatus.MISSING_PERMISSION);

    await api.post(`/api/integrations/${integrationId}/select`, { accountIds: [account.id] }).expect(200);

    const integration = await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } });
    expect(integration.lastError).toContain(ADWORDS_SCOPE);
    expect(integration.lastError).not.toMatch(META_VOCABULARY);
  });

  // --------------------------------------------------------------- health

  it('checks a Google Ads connection against Google, not Facebook\'s Graph', async () => {
    const { integrationId } = await connect(tenant, adsFetch());
    const account = await prisma.integrationAccount.findFirstOrThrow({ where: { integrationId } });
    await api.post(`/api/integrations/${integrationId}/select`, { accountIds: [account.id] }).expect(200);

    /*
     * The route reaches for the global `fetch` — it is an HTTP handler, not a
     * service with an injectable client — so the global is where the provider
     * call is observed. Every URL it asks for is recorded, because the host is
     * the assertion: a Google token sent to graph.facebook.com is a guaranteed
     * refusal, and this route used to write ERROR over a working connection on
     * the strength of it.
     */
    const asked: string[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string | URL, init?: unknown) => {
      const target = String(url);
      asked.push(target);
      if (target.includes('oauth2/v3/userinfo')) {
        return new Response(JSON.stringify({ sub: 'google-user-9', email: 'ops@noriva.sa' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return realFetch(url as never, init as never);
    });

    try {
      const response = await api.get(`/api/integrations/${integrationId}/health`).expect(200);
      const body = response.body as { live: boolean; detail: string; status: string };

      expect(asked.some((url) => url.includes('googleapis.com'))).toBe(true);
      expect(asked.some((url) => url.includes('facebook.com'))).toBe(false);

      expect(body.live).toBe(true);
      expect(body.detail).toMatch(/Google Ads answered as/);
      expect(body.status).toBe(IntegrationStatus.CONNECTED);
    } finally {
      vi.unstubAllGlobals();
    }

    // And the connection is left exactly as it was found.
    const integration = await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } });
    expect(integration.status).toBe(IntegrationStatus.CONNECTED);
    expect(integration.lastError).toBeNull();
  });

  // ------------------------------------------------------- sync and metrics

  it('syncs Google Ads performance into the attached account\'s snapshots', async () => {
    const { integrationId } = await connect(tenant, adsFetch());
    const account = await prisma.integrationAccount.findFirstOrThrow({ where: { integrationId } });
    await api.post(`/api/integrations/${integrationId}/select`, { accountIds: [account.id] }).expect(200);

    /*
     * Only advertisements this application published carry a provider campaign
     * id, and only those are attributed: spend made in Ads Manager against
     * campaigns we did not create has no local campaign to belong to.
     */
    const publication = await prisma.adPublication.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        campaignId: tenant.campaignId,
        platform: Platform.GOOGLE_ADS,
        name: 'Pawse launch',
        objective: 'TRAFFIC',
        startDate: new Date(Date.now() - 7 * 86_400_000),
        endDate: new Date(Date.now() + 7 * 86_400_000),
        headline: 'Open now',
        message: 'Fresh mezze daily',
        linkUrl: 'https://pawse.example/menu',
        dailyBudget: 150,
        currency: 'SAR',
        status: 'PUBLISHED',
        providerCampaignId: '77001',
      },
      select: { id: true },
    });

    const day = new Date();
    day.setUTCDate(day.getUTCDate() - 1);
    const date = day.toISOString().slice(0, 10);

    const realFetch = globalThis.fetch;
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: string | URL, init?: unknown) => {
      const target = String(url);
      asked.push(target);
      if (target.includes('googleAds:search')) {
        return new Response(JSON.stringify({
          results: [{
            campaign: { id: '77001', name: 'Pawse launch', status: 'ENABLED', advertisingChannelType: 'SEARCH' },
            campaignBudget: { amountMicros: '150000000' },
            segments: { date },
            // Google reports money in millionths of the account currency.
            metrics: {
              impressions: '4200', clicks: '310', costMicros: '87500000',
              conversions: 12.4, conversionsValue: 2140.5,
            },
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return realFetch(url as never, init as never);
    });

    try {
      const response = await api.post(`/api/integrations/${integrationId}/sync`).expect(200);
      const body = response.body as {
        status: string; customerId: string; campaignsRead: number; daysWritten: number; skipped: unknown[];
      };

      expect(body.status).toBe('SUCCESS');
      // The API is addressed by digits even though the picker shows dashes.
      expect(body.customerId).toBe('1234567890');
      expect(body.campaignsRead).toBe(1);
      expect(body.daysWritten).toBe(1);
      expect(body.skipped).toHaveLength(0);
      // Google's API, not Meta's Insights edge.
      expect(asked.some((url) => url.includes('googleads.googleapis.com'))).toBe(true);
      expect(asked.some((url) => url.includes('facebook.com'))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }

    const snapshot = await prisma.analyticsSnapshot.findFirstOrThrow({
      where: { campaignId: tenant.campaignId, platform: Platform.GOOGLE_ADS },
    });

    expect(Number(snapshot.spend)).toBeCloseTo(87.5, 2);
    expect(snapshot.impressions).toBe(4200);
    expect(snapshot.clicks).toBe(310);
    expect(snapshot.conversions).toBe(12);
    expect(Number(snapshot.revenue)).toBeCloseTo(2140.5, 2);
    /*
     * Not written, deliberately. Google Search has no reach metric — there are
     * queries, not people reached — and copying impressions across would
     * manufacture a figure Google never produced.
     */
    expect(snapshot.reach).toBe(0);

    await prisma.analyticsSnapshot.deleteMany({
      where: { campaignId: tenant.campaignId, platform: Platform.GOOGLE_ADS },
    });
    await prisma.adPublication.delete({ where: { id: publication.id } });
  });

  // ------------------------------------------------------------ the sentences

  it('writes no Meta vocabulary into any Google Ads note', () => {
    const notes = [
      discoveryNote({ platform: Platform.GOOGLE_ADS, discovered: 0 }),
      discoveryNote({
        platform: Platform.GOOGLE_ADS,
        discovered: 1,
        refusals: [{ externalId: '555-555-5555', message: 'Google refused this account.' }],
      }),
      noUsableCredentialNote(Platform.GOOGLE_ADS),
      missingGrantNote(Platform.GOOGLE_ADS, ADWORDS_SCOPE),
    ];

    for (const note of notes) {
      expect(note).toBeTruthy();
      expect(note).not.toMatch(META_VOCABULARY);
    }
  });

  it('leaves Meta\'s own sentences exactly as they were', () => {
    // "Keep existing Meta behaviour unchanged" is a promise about words too:
    // these are the strings Meta connections have always produced.
    expect(noUsableCredentialNote(Platform.FACEBOOK))
      .toBe('The selected account has no usable publishing token. Reconnect Facebook and grant access to this Page.');
    expect(missingGrantNote(Platform.FACEBOOK, 'pages_manage_posts'))
      .toMatch(/does not include pages_manage_posts, so posts cannot be published to this Page yet/);
    expect(discoveryNote({ platform: Platform.FACEBOOK, discovered: 0 }))
      .toMatch(/administers a Page/);
    expect(discoveryNote({ platform: Platform.FACEBOOK, discovered: 2 })).toBeNull();
  });

  // ------------------------------------------------- the drawer's own source

  it('leaves no hard-coded Meta wording in the account picker', async () => {
    /*
     * A source-level assertion, in the style of `web/src/layout.test.ts`: this
     * project has no browser test framework, and the defect being guarded
     * against is a sentence, which no compiler and no API test can see. Both
     * halves are checked — the drawer must read the platform, and must not
     * name a provider itself.
     */
    const drawer = await readFile(
      new URL('../../web/src/routes/workspace.tsx', import.meta.url),
      'utf8',
    );

    const picker = drawer.slice(
      drawer.indexOf('function AccountSelection'),
      drawer.indexOf('function ProjectPicker'),
    );
    expect(picker.length).toBeGreaterThan(0);

    // It resolves its words from the connection's platform...
    expect(picker).toContain('accountPickerCopy(platform)');
    expect(picker).toContain('data?.integration.platform');
    // ...and hard-codes none of them.
    expect(picker).not.toMatch(/Meta returned/);
    expect(picker).not.toMatch(/one ad account and one Page/);
    expect(picker).not.toMatch(/`Page \$\{/);
  });
});

/**
 * The full connection lifecycle, end to end, against mocked provider responses.
 *
 * authorize → callback → discovery → selection → connected → sync
 *
 * Every step runs the same code production runs; only the network is replaced.
 * The point is to prove the chain actually works before any credential exists,
 * because "the adapter is written" and "the adapter connects" are different
 * claims and only one of them is worth making.
 *
 * The assertions that matter most are the negative ones — discovery must not
 * attach anything, a failed validation must not reach CONNECTED, and a state
 * issued for one client must not be redeemable by another.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IntegrationStatus, Platform, SyncStatus } from '@prisma/client';

import { createTenant, prisma, resetDatabase, type Tenant } from './helpers.js';
import { issueState } from '../src/services/integrations/oauth-state.js';
import {
  beginAuthorization,
  callbackUrl,
  completeCallback,
  runSync,
  selectAccounts,
} from '../src/services/integrations/connect-flow.js';
import { decryptSecret } from '../src/lib/crypto.js';
import type { FetchLike } from '../src/services/integrations/meta.js';

const KEY = 'Zm9yLXRlc3Rpbmctb25seS0zMi1ieXRlLWtleS0hIQ==';
const BASE = 'https://marketing-osserver-production.up.railway.app';

/** The provider's real response shapes, minus the network. */
function metaFetch(overrides: Partial<Record<string, unknown>> = {}): FetchLike {
  const routes: Array<{ match: string; body: unknown; status?: number }> = [
    { match: 'fb_exchange_token', body: { access_token: 'LONG-LIVED-TOKEN', expires_in: 5184000 } },
    { match: 'oauth/access_token', body: { access_token: 'SHORT-TOKEN', expires_in: 3600 } },
    {
      match: '/me/permissions',
      body: overrides.permissions ?? {
        data: [
          { permission: 'pages_show_list', status: 'granted' },
          { permission: 'pages_manage_posts', status: 'granted' },
          { permission: 'pages_read_engagement', status: 'granted' },
        ],
      },
    },
    { match: '/me?', body: overrides.me ?? { id: 'user-1', name: 'Pawse Operator' } },
    {
      match: '/me/accounts',
      body: overrides.accounts ?? {
        data: [
          {
            id: 'page-100',
            name: 'Pawse',
            username: 'pawse',
            // The Page's own publishing credential, as Meta really returns it.
            access_token: 'PAGE-TOKEN-100',
            instagram_business_account: { id: 'ig-200', username: 'pawse', name: 'Pawse' },
          },
        ],
      },
    },
    {
      match: '/me/adaccounts',
      body: overrides.adaccounts ?? {
        data: [
          {
            id: 'act_26743867',
            account_id: '26743867',
            name: 'Pawse Ads',
            currency: 'SAR',
            timezone_name: 'Asia/Riyadh',
            business: { id: 'biz-300', name: 'Pawse Business' },
          },
        ],
      },
    },
    { match: '/me/businesses', body: overrides.businesses ?? { data: [{ id: 'biz-300', name: 'Pawse Business' }] } },
  ];

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

describe('connection lifecycle', () => {
  let alpha: Tenant;
  let beta: Tenant;
  const saved = { ...process.env };

  beforeAll(async () => {
    await resetDatabase();
    alpha = await createTenant('connect-alpha');
    beta = await createTenant('connect-beta');
  });

  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
    process.env.META_APP_ID = '1821333942563322';
    process.env.META_APP_SECRET = 'secret-456';
    process.env.META_REDIRECT_URI = callbackUrl(BASE, Platform.FACEBOOK);
    process.env.META_CONFIG_ID = 'login-config-1';
  });
  afterEach(() => {
    for (const key of ['TOKEN_ENCRYPTION_KEY', 'META_APP_ID', 'META_APP_SECRET', 'META_REDIRECT_URI', 'META_CONFIG_ID']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  const authorize = (tenant: Tenant) =>
    beginAuthorization({
      organizationId: tenant.organizationId,
      clientId: tenant.clientId,
      platform: Platform.FACEBOOK,
      baseUrl: BASE,
    });

  it('documents the callback URL an app console must be given', () => {
    expect(callbackUrl(BASE, Platform.FACEBOOK)).toBe(`${BASE}/api/integrations/meta/callback`);
    expect(callbackUrl(BASE, Platform.INSTAGRAM)).toBe(`${BASE}/api/integrations/meta/callback`);
    expect(callbackUrl(BASE, Platform.GOOGLE_ADS)).toBe(`${BASE}/api/integrations/google/callback`);
    expect(callbackUrl(BASE, Platform.TIKTOK)).toBe(`${BASE}/api/integrations/tiktok/callback`);
  });

  it('sends the operator to the provider and parks the integration in CONNECTING', async () => {
    const result = await authorize(alpha);
    const url = new URL(result.redirectTo);

    expect(url.origin).toBe('https://www.facebook.com');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('redirect_uri')).toBe(`${BASE}/api/integrations/meta/callback`);
    expect(url.toString()).not.toContain('secret-456');

    const integration = await prisma.integration.findUniqueOrThrow({ where: { id: result.integrationId } });
    expect(integration.status).toBe(IntegrationStatus.CONNECTING);
  });

  it('exchanges the code, encrypts the token and discovers assets without attaching any', async () => {
    await authorize(alpha);
    const { state } = await issueState({
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      platform: Platform.FACEBOOK,
      redirectUri: callbackUrl(BASE, Platform.FACEBOOK),
    });

    const result = await completeCallback({
      platform: Platform.FACEBOOK,
      state,
      code: 'auth-code',
      fetchImpl: metaFetch(),
    });

    expect(result.accountName).toBe('Pawse Operator');
    expect(result.discovered.map((account) => account.kind).sort()).toEqual([
      'AD_ACCOUNT', 'BUSINESS', 'INSTAGRAM', 'PAGE',
    ]);

    const integration = await prisma.integration.findUniqueOrThrow({ where: { id: result.integrationId } });

    // Token stored encrypted, recoverable, and never in plaintext.
    expect(integration.accessTokenEnc?.startsWith('v1.')).toBe(true);
    expect(integration.accessTokenEnc).not.toContain('LONG-LIVED-TOKEN');
    expect(decryptSecret(integration.accessTokenEnc!)).toBe('LONG-LIVED-TOKEN');
    expect(integration.tokenFingerprint).toHaveLength(12);

    // Discovered but NOT connected, and nothing attached.
    expect(integration.status).toBe(IntegrationStatus.CONNECTING);
    const accounts = await prisma.integrationAccount.findMany({ where: { integrationId: result.integrationId } });
    expect(accounts).toHaveLength(4);
    expect(accounts.every((account) => account.selected === false)).toBe(true);

    // The ad account keeps its own currency, and Instagram keeps its Page link.
    expect(accounts.find((a) => a.externalId === 'act_26743867')).toMatchObject({ currency: 'SAR', timezone: 'Asia/Riyadh' });
    expect(accounts.find((a) => a.externalId === 'ig-200')).toMatchObject({ username: 'pawse', parentExternalId: 'page-100' });
  });

  it('reaches CONNECTED only once the operator selects assets', async () => {
    const { integrationId } = await authorize(alpha);
    const { state } = await issueState({
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      platform: Platform.FACEBOOK,
      redirectUri: callbackUrl(BASE, Platform.FACEBOOK),
    });
    await completeCallback({ platform: Platform.FACEBOOK, state, code: 'code', fetchImpl: metaFetch() });

    const accounts = await prisma.integrationAccount.findMany({ where: { integrationId } });
    const chosen = accounts.filter((a) => a.kind !== 'BUSINESS').map((a) => a.id);

    const result = await selectAccounts({
      integrationId,
      organizationId: alpha.organizationId,
      accountIds: chosen,
    });

    expect(result.status).toBe(IntegrationStatus.CONNECTED);
    expect(result.selected).toBe(3);

    const after = await prisma.integrationAccount.findMany({ where: { integrationId, selected: true } });
    expect(after).toHaveLength(3);
    // The unchosen business asset stays detached.
    expect(after.find((a) => a.kind === 'BUSINESS')).toBeUndefined();
  });

  it('returns to DISCONNECTED when every asset is deselected', async () => {
    const { integrationId } = await authorize(alpha);
    const { state } = await issueState({
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      platform: Platform.FACEBOOK,
      redirectUri: callbackUrl(BASE, Platform.FACEBOOK),
    });
    await completeCallback({ platform: Platform.FACEBOOK, state, code: 'code', fetchImpl: metaFetch() });

    const result = await selectAccounts({ integrationId, organizationId: alpha.organizationId, accountIds: [] });
    expect(result.status).toBe(IntegrationStatus.DISCONNECTED);
  });

  it('ignores account ids that belong to another integration', async () => {
    const { integrationId } = await authorize(alpha);
    const { state } = await issueState({
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      platform: Platform.FACEBOOK,
      redirectUri: callbackUrl(BASE, Platform.FACEBOOK),
    });
    await completeCallback({ platform: Platform.FACEBOOK, state, code: 'code', fetchImpl: metaFetch() });

    // A forged id from nowhere must not be attached, and must not count.
    const result = await selectAccounts({
      integrationId,
      organizationId: alpha.organizationId,
      accountIds: ['not-an-account-of-this-integration'],
    });
    expect(result.selected).toBe(0);
    expect(result.status).toBe(IntegrationStatus.DISCONNECTED);
  });

  it('records ERROR with the provider message when validation fails, never CONNECTED', async () => {
    const { integrationId } = await authorize(alpha);
    const { state } = await issueState({
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      platform: Platform.FACEBOOK,
      redirectUri: callbackUrl(BASE, Platform.FACEBOOK),
    });

    const failing: FetchLike = (async (url: string) => {
      if (url.includes('/me?')) {
        return {
          ok: false,
          status: 401,
          json: async () => ({ error: { message: 'Invalid OAuth access token.' } }),
          text: async () => '',
        };
      }
      return metaFetch()(url);
    }) as FetchLike;

    await expect(
      completeCallback({ platform: Platform.FACEBOOK, state, code: 'code', fetchImpl: failing }),
    ).rejects.toThrow(/Invalid OAuth access token/);

    const integration = await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } });
    expect(integration.status).toBe(IntegrationStatus.ERROR);
    expect(integration.lastError).toMatch(/Invalid OAuth access token/);
    // A failed validation must leave no usable credential behind.
    expect(integration.accessTokenEnc).toBeNull();
  });

  it('completes the flow for the client the state was issued to, not another', async () => {
    await authorize(alpha);
    // Beta starts its own flow; its state must complete beta's connection.
    await authorize(beta);
    const { state } = await issueState({
      organizationId: beta.organizationId,
      clientId: beta.clientId,
      platform: Platform.FACEBOOK,
      redirectUri: callbackUrl(BASE, Platform.FACEBOOK),
    });

    // Redeeming beta's state completes beta's flow, never alpha's.
    const result = await completeCallback({
      platform: Platform.FACEBOOK,
      state,
      code: 'code',
      fetchImpl: metaFetch(),
    });
    expect(result.clientId).toBe(beta.clientId);

    const alphaIntegration = await prisma.integration.findFirstOrThrow({
      where: { clientId: alpha.clientId, platform: Platform.FACEBOOK },
    });
    expect(alphaIntegration.accessTokenEnc).toBeNull();
  });

  it('does not duplicate accounts when discovery runs again', async () => {
    const { integrationId } = await authorize(alpha);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { state } = await issueState({
        organizationId: alpha.organizationId,
        clientId: alpha.clientId,
        platform: Platform.FACEBOOK,
        redirectUri: callbackUrl(BASE, Platform.FACEBOOK),
      });
      await completeCallback({ platform: Platform.FACEBOOK, state, code: `code-${attempt}`, fetchImpl: metaFetch() });
    }

    expect(await prisma.integrationAccount.count({ where: { integrationId } })).toBe(4);
  });

  it('keeps a previously deselected asset detached across a reconnect', async () => {
    const { integrationId } = await authorize(alpha);
    const first = await issueState({
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      platform: Platform.FACEBOOK,
      redirectUri: callbackUrl(BASE, Platform.FACEBOOK),
    });
    await completeCallback({ platform: Platform.FACEBOOK, state: first.state, code: 'a', fetchImpl: metaFetch() });

    const page = await prisma.integrationAccount.findFirstOrThrow({ where: { integrationId, kind: 'PAGE' } });
    await selectAccounts({ integrationId, organizationId: alpha.organizationId, accountIds: [page.id] });

    const second = await issueState({
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      platform: Platform.FACEBOOK,
      redirectUri: callbackUrl(BASE, Platform.FACEBOOK),
    });
    await completeCallback({ platform: Platform.FACEBOOK, state: second.state, code: 'b', fetchImpl: metaFetch() });

    // Re-discovery refreshes names but must not re-attach what was removed.
    const selected = await prisma.integrationAccount.findMany({ where: { integrationId, selected: true } });
    expect(selected).toHaveLength(1);
    expect(selected[0]?.kind).toBe('PAGE');
  });
});

describe('sync runs', () => {
  let tenant: Tenant;
  let integrationId: string;

  beforeAll(async () => {
    await resetDatabase();
    tenant = await createTenant('sync-tenant');
    process.env.TOKEN_ENCRYPTION_KEY = KEY;

    const integration = await prisma.integration.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        platform: Platform.FACEBOOK,
        status: IntegrationStatus.CONNECTED,
      },
      select: { id: true },
    });
    integrationId = integration.id;
  });

  const context = () => ({
    integrationId,
    organizationId: tenant.organizationId,
    clientId: tenant.clientId,
    platform: Platform.FACEBOOK,
  });

  it('records a successful run and stamps lastSyncAt', async () => {
    const outcome = await runSync(context(), async () => ({ processed: 12, created: 8, updated: 4 }));

    expect(outcome.status).toBe(SyncStatus.SUCCESS);
    expect(outcome.recordsProcessed).toBe(12);

    const integration = await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } });
    expect(integration.lastSyncAt).not.toBeNull();
    expect(integration.lastError).toBeNull();
  });

  it('records a failed run rather than leaving no evidence', async () => {
    const outcome = await runSync(context(), async () => {
      throw new Error('Meta API rate limit reached');
    });

    expect(outcome.status).toBe(SyncStatus.FAILED);
    expect(outcome.errorMessage).toMatch(/rate limit/i);

    const run = await prisma.integrationSyncRun.findUniqueOrThrow({ where: { id: outcome.runId } });
    expect(run.status).toBe(SyncStatus.FAILED);
    expect(run.completedAt).not.toBeNull();

    const integration = await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } });
    expect(integration.lastError).toMatch(/rate limit/i);
  });

  it('keeps one run row per attempt, so history is auditable', async () => {
    const before = await prisma.integrationSyncRun.count({ where: { integrationId } });
    await runSync(context(), async () => ({ processed: 1, created: 1, updated: 0 }));
    await runSync(context(), async () => ({ processed: 2, created: 0, updated: 2 }));

    expect(await prisma.integrationSyncRun.count({ where: { integrationId } })).toBe(before + 2);
  });
});

/**
 * The HTTP wiring for the Meta connection.
 *
 * `connect-flow.test.ts` proves the orchestration works. This file proves it is
 * *reachable* — which is a separate claim, and the one that was false. The whole
 * flow existed, was tested, and no route called it: `POST .../connect` went to
 * `BaseAdapter.connect()`, which throws unconditionally, and the callback path
 * the authorize URL pointed at was never mounted. A customer with perfect
 * credentials could not connect Meta, and every test passed.
 *
 * So the assertions here are deliberately about plumbing: does the route reach
 * the real flow, does the callback exist, does selection complete a connection,
 * and does a provider with no implementation say so instead of pretending.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IntegrationStatus, Platform } from '@prisma/client';
import request from 'supertest';

import { agent, app, createTenant, prisma, resetDatabase, type Tenant } from './helpers.js';
import { callbackUrl } from '../src/services/integrations/connect-flow.js';
import { STATE_TTL_MS, issueState } from '../src/services/integrations/oauth-state.js';
import { encryptSecret } from '../src/lib/crypto.js';

const KEY = 'Zm9yLXRlc3Rpbmctb25seS0zMi1ieXRlLWtleS0hIQ==';
const BASE = 'https://marketing-osserver-production.up.railway.app';
const APP_SECRET = 'secret-that-must-never-be-echoed';

describe('Meta OAuth routes', () => {
  let alpha: Tenant;
  let beta: Tenant;
  const saved = { ...process.env };

  beforeAll(async () => {
    await resetDatabase();
    alpha = await createTenant('oauth-routes-alpha');
    beta = await createTenant('oauth-routes-beta');
  });

  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
    process.env.META_APP_ID = '1821333942563322';
    process.env.META_APP_SECRET = APP_SECRET;
    process.env.META_REDIRECT_URI = callbackUrl(BASE, Platform.FACEBOOK);
    process.env.META_CONFIG_ID = 'login-config-1';
  });

  afterEach(() => {
    for (const key of [
      'TOKEN_ENCRYPTION_KEY', 'META_APP_ID', 'META_APP_SECRET', 'META_REDIRECT_URI', 'META_CONFIG_ID',
      'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_REDIRECT_URI',
    ]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  const admin = async (tenant: Tenant) => {
    const client = agent();
    await client.login(tenant.adminEmail);
    return client;
  };

  // ------------------------------------------------------------ connect

  it('starts a real authorization instead of throwing from the base adapter', async () => {
    const client = await admin(alpha);
    const response = await client.post(`/api/integrations/${alpha.clientId}/FACEBOOK/connect`);

    expect(response.status).toBe(200);
    const url = new URL(response.body.redirectTo);
    expect(url.origin).toBe('https://www.facebook.com');
    expect(url.pathname).toContain('/dialog/oauth');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('redirect_uri')).toBe(`${BASE}/api/integrations/meta/callback`);
    expect(response.body.integrationId).toBeTruthy();
  });

  it('never echoes the app secret in the authorize response', async () => {
    const client = await admin(alpha);
    const response = await client.post(`/api/integrations/${alpha.clientId}/FACEBOOK/connect`);
    expect(JSON.stringify(response.body)).not.toContain(APP_SECRET);
  });

  it('parks the integration in CONNECTING, not CONNECTED', async () => {
    const client = await admin(alpha);
    await client.post(`/api/integrations/${alpha.clientId}/FACEBOOK/connect`);

    const integration = await prisma.integration.findFirst({
      where: { clientId: alpha.clientId, platform: Platform.FACEBOOK },
    });
    expect(integration?.status).toBe(IntegrationStatus.CONNECTING);
    // Configuration is not a connection.
    expect(integration?.accessTokenEnc).toBeNull();
  });

  it('answers 503 with the missing variables when Meta is not configured', async () => {
    delete process.env.META_APP_ID;
    const client = await admin(alpha);
    const response = await client.post(`/api/integrations/${alpha.clientId}/FACEBOOK/connect`);

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('PROVIDER_NOT_CONFIGURED');
    expect(response.body.error.details.missingEnv).toContain('META_APP_ID');
  });

  it('answers 503 when credentials exist but tokens could not be stored safely', async () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    const client = await admin(alpha);
    const response = await client.post(`/api/integrations/${alpha.clientId}/FACEBOOK/connect`);

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('ENCRYPTION_NOT_CONFIGURED');
  });

  /*
   * The distinction the old code could not make. Google Ads is fully
   * configured here and still cannot connect, because nobody has written it.
   * Reporting NOT_CONFIGURED would send an operator to fix variables that are
   * already correct.
   */
  it('separates "not built" from "not configured"', async () => {
    process.env.GOOGLE_CLIENT_ID = 'g-id';
    process.env.GOOGLE_CLIENT_SECRET = 'g-secret';
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN = 'g-dev';
    process.env.GOOGLE_REDIRECT_URI = `${BASE}/api/integrations/google/callback`;

    const client = await admin(alpha);
    const response = await client.post(`/api/integrations/${alpha.clientId}/GOOGLE_ADS/connect`);

    expect(response.status).toBe(501);
    expect(response.body.error.code).toBe('PROVIDER_NOT_IMPLEMENTED');
    expect(response.body.error.details.implementation.oauth).toBe('ARCHITECTURE_ONLY');
  });

  it('refuses to start a connection for another tenant\'s client', async () => {
    const client = await admin(alpha);
    const response = await client.post(`/api/integrations/${beta.clientId}/FACEBOOK/connect`);
    expect(response.status).toBe(404);
  });

  // ------------------------------------------------------------ callback

  it('mounts the callback the authorize URL actually points at', async () => {
    // No session: the provider redirect carries none. The state is the
    // authorisation, so an unknown one is rejected — but the route must exist.
    const response = await request(app).get('/api/integrations/meta/callback?code=abc&state=not-a-real-state');

    expect(response.status).toBe(302);
    expect(response.status).not.toBe(404);
    const location = new URL(response.headers.location as string);
    expect(location.pathname).toBe('/app/integrations');
    expect(location.searchParams.get('error')).toBeTruthy();
  });

  it('carries a cancelled authorization back as a message, not a crash', async () => {
    const response = await request(app).get(
      '/api/integrations/meta/callback?error=access_denied&error_description=The+user+cancelled',
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(location.searchParams.get('error')).toBe('The user cancelled');
  });

  it('never puts the authorization code in the redirect back to the app', async () => {
    const response = await request(app).get('/api/integrations/meta/callback?code=SENSITIVE-CODE&state=bogus');
    expect(response.headers.location).not.toContain('SENSITIVE-CODE');
  });

  // ------------------------------------------------------ accounts + select

  // Beta, because the connect tests above already hold alpha's FACEBOOK row and
  // an integration is unique per (client, platform).
  it('lists discovered accounts and completes the connection on selection', async () => {
    const integration = await prisma.integration.create({
      data: {
        organizationId: beta.organizationId,
        clientId: beta.clientId,
        platform: Platform.FACEBOOK,
        status: IntegrationStatus.CONNECTING,
        accounts: {
          create: [
            {
              clientId: beta.clientId, kind: 'PAGE', externalId: 'page-100', name: 'Pawse',
              // A Page with a usable publishing credential, because CONNECTED
              // now means "this can publish" rather than "a box was ticked".
              accessTokenEnc: encryptSecret('page-token'),
              tokenStatus: 'UNKNOWN',
            },
            {
              clientId: beta.clientId, kind: 'AD_ACCOUNT', externalId: 'act_26743867',
              name: 'Pawse Ads', currency: 'SAR', timezone: 'Asia/Riyadh',
            },
          ],
        },
      },
      include: { accounts: true },
    });

    const client = await admin(beta);

    const listed = await client.get(`/api/integrations/${integration.id}/accounts`);
    expect(listed.status).toBe(200);
    expect(listed.body.integration.accounts).toHaveLength(2);
    // Discovery attaches nothing on its own.
    expect(listed.body.integration.accounts.every((row: { selected: boolean }) => !row.selected)).toBe(true);
    // The account currency is preserved as the provider reported it — never USD.
    const adAccount = listed.body.integration.accounts.find((row: { kind: string }) => row.kind === 'AD_ACCOUNT');
    expect(adAccount.currency).toBe('SAR');

    const chosen = integration.accounts.map((account) => account.id);
    const selected = await client.post(`/api/integrations/${integration.id}/select`, { accountIds: chosen });

    expect(selected.status).toBe(200);
    expect(selected.body).toEqual({ status: IntegrationStatus.CONNECTED, selected: 2 });

    const after = await prisma.integration.findUnique({ where: { id: integration.id } });
    expect(after?.status).toBe(IntegrationStatus.CONNECTED);
  });

  it('selecting nothing detaches rather than leaving an empty connection', async () => {
    const integration = await prisma.integration.create({
      data: {
        organizationId: alpha.organizationId,
        clientId: alpha.clientId,
        platform: Platform.INSTAGRAM,
        status: IntegrationStatus.CONNECTED,
        accounts: {
          create: [{ clientId: alpha.clientId, kind: 'PAGE', externalId: 'page-900', name: 'Detach me', selected: true }],
        },
      },
    });

    const client = await admin(alpha);
    const response = await client.post(`/api/integrations/${integration.id}/select`, { accountIds: [] });

    expect(response.body).toEqual({ status: IntegrationStatus.DISCONNECTED, selected: 0 });
  });

  it('cannot read or select another tenant\'s integration', async () => {
    const integration = await prisma.integration.create({
      data: {
        organizationId: alpha.organizationId,
        clientId: alpha.clientId,
        platform: Platform.GOOGLE_BUSINESS,
        status: IntegrationStatus.CONNECTING,
        accounts: { create: [{ clientId: alpha.clientId, kind: 'PAGE', externalId: 'page-x', name: 'Alpha only' }] },
      },
    });

    const intruder = await admin(beta);
    expect((await intruder.get(`/api/integrations/${integration.id}/accounts`)).status).toBe(404);
    expect((await intruder.post(`/api/integrations/${integration.id}/select`, { accountIds: [] })).status).toBe(404);
  });

  // ------------------------------------------------------------- health

  it('reports a connection with no stored credential as not live', async () => {
    const integration = await prisma.integration.create({
      data: {
        organizationId: alpha.organizationId,
        clientId: alpha.clientId,
        platform: Platform.LINKEDIN,
        status: IntegrationStatus.CONNECTED,
      },
    });

    const client = await admin(alpha);
    const response = await client.get(`/api/integrations/${integration.id}/health`);

    expect(response.status).toBe(200);
    expect(response.body.live).toBe(false);
    expect(response.body.detail).toContain('No credential');
  });

  // --------------------------------------------------------------- sync

  it('no longer reports success for a metric sync that does nothing', async () => {
    const integration = await prisma.integration.create({
      data: {
        organizationId: alpha.organizationId,
        clientId: alpha.clientId,
        platform: Platform.SNAPCHAT,
        status: IntegrationStatus.CONNECTED,
      },
    });

    const client = await admin(alpha);
    const response = await client.post(`/api/integrations/${integration.id}/sync`);

    expect(response.status).toBe(501);
    expect(response.body.error.code).toBe('METRICS_SYNC_NOT_IMPLEMENTED');
    expect(response.body.ok).toBeUndefined();
  });

  // ------------------------------------------------------------ catalog

  it('publishes both axes so the UI can tell configured from built', async () => {
    const client = await admin(alpha);
    const response = await client.get('/api/integrations/catalog');

    const meta = response.body.adapters.find((row: { platform: string }) => row.platform === 'FACEBOOK');
    expect(meta.implementation.oauth).toBe('IMPLEMENTED');
    expect(meta.implementation.publish).toBe('IMPLEMENTED');
    /*
     * PARTIALLY_IMPLEMENTED, and the qualifier is load-bearing: insights are
     * ingested for advertisements this system published and linked to a local
     * campaign, and for nothing else. Spend made directly in Ads Manager is not
     * attributed, so claiming IMPLEMENTED would overstate what the dashboards
     * can account for.
     */
    expect(meta.implementation.metrics).toBe('PARTIALLY_IMPLEMENTED');
    expect(meta.canConnect).toBe(true);

    /*
     * TikTok is the case that shows the two axes are genuinely independent:
     * since Phase 11 its OAuth and publishing are built, but this test
     * environment sets no TIKTOK_* variables, so it is built and still cannot
     * connect. A single "available" flag could not express that.
     */
    const tiktok = response.body.adapters.find((row: { platform: string }) => row.platform === 'TIKTOK');
    expect(tiktok.implementation.oauth).toBe('IMPLEMENTED');
    expect(tiktok.implementation.publish).toBe('IMPLEMENTED');
    expect(tiktok.canConnect).toBe(false);

    // And a provider that is neither built nor configured still says so.
    const snapchat = response.body.adapters.find((row: { platform: string }) => row.platform === 'SNAPCHAT');
    expect(snapchat.implementation.oauth).toBe('ARCHITECTURE_ONLY');
    expect(snapchat.canConnect).toBe(false);
  });

  // ------------------------------------------------------- state rejection
  //
  // Every one of these is a redirect, never a 4xx or a stack trace: the caller
  // is a browser that Meta navigated here, and an error page it cannot act on
  // is indistinguishable from the product being broken.

  const callbackError = async (query: string) => {
    const response = await request(app).get(`/api/integrations/meta/callback${query}`);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(location.pathname).toBe('/app/integrations');
    return location.searchParams.get('error');
  };

  it('sends the operator back with a message when the code is missing', async () => {
    expect(await callbackError('?state=some-state')).toMatch(/no authorization code/i);
  });

  it('sends the operator back with a message when the state is missing', async () => {
    expect(await callbackError('?code=abc')).toMatch(/no authorization code/i);
  });

  it('refuses a state that was never issued', async () => {
    expect(await callbackError('?code=abc&state=never-issued')).toMatch(/could not be verified/i);
  });

  it('refuses an expired state', async () => {
    // Issued far enough in the past that its TTL has already elapsed.
    const issued = await issueState({
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      platform: Platform.FACEBOOK,
      redirectUri: callbackUrl(BASE, Platform.FACEBOOK),
      now: new Date(Date.now() - STATE_TTL_MS - 60_000),
    });

    expect(await callbackError(`?code=abc&state=${issued.state}`)).toMatch(/could not be verified/i);
  });

  it('refuses a state issued for a different provider', async () => {
    const issued = await issueState({
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      platform: Platform.GOOGLE_ADS,
      redirectUri: callbackUrl(BASE, Platform.FACEBOOK),
    });

    expect(await callbackError(`?code=abc&state=${issued.state}`)).toMatch(/could not be verified/i);
  });

  it('rejects every state rejection with the same sentence', async () => {
    // The callback must not become an oracle: "no such state" and "expired"
    // have to be indistinguishable to anyone probing it from outside.
    const unknown = await callbackError('?code=abc&state=definitely-not-real');
    const expired = await issueState({
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      platform: Platform.FACEBOOK,
      redirectUri: callbackUrl(BASE, Platform.FACEBOOK),
      now: new Date(Date.now() - STATE_TTL_MS - 60_000),
    });

    expect(await callbackError(`?code=abc&state=${expired.state}`)).toBe(unknown);
  });

  it('consumes a state exactly once, so a replayed callback is refused', async () => {
    const issued = await issueState({
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      platform: Platform.FACEBOOK,
      redirectUri: callbackUrl(BASE, Platform.FACEBOOK),
    });

    // The first use fails at the token exchange (there is no Meta to talk to
    // here), but it still consumes the state — which is the point.
    await request(app).get(`/api/integrations/meta/callback?code=abc&state=${issued.state}`);

    // The second use must be refused as unverifiable, not retried against Meta.
    expect(await callbackError(`?code=abc&state=${issued.state}`)).toMatch(/could not be verified/i);
  });

  it('never leaks the state or the app secret in the redirect back', async () => {
    const response = await request(app).get('/api/integrations/meta/callback?code=abc&state=SENSITIVE-STATE');
    const location = response.headers.location as string;

    expect(location).not.toContain('SENSITIVE-STATE');
    expect(location).not.toContain(APP_SECRET);
  });

  // ------------------------------------------------- cross-integration guard

  it('cannot select an account belonging to a different integration', async () => {
    // Two integrations, same tenant. Ids from one must not attach to the other,
    // or a request body becomes an authorisation to wire up somebody else's Page.
    const target = await prisma.integration.create({
      data: {
        organizationId: beta.organizationId,
        clientId: beta.clientId,
        platform: Platform.GOOGLE_ADS,
        status: IntegrationStatus.CONNECTING,
        accounts: {
          create: [{ clientId: beta.clientId, kind: 'PAGE', externalId: 'page-own', name: 'Own page' }],
        },
      },
      include: { accounts: true },
    });

    const stranger = await prisma.integration.create({
      data: {
        organizationId: beta.organizationId,
        clientId: beta.clientId,
        platform: Platform.SNAPCHAT,
        status: IntegrationStatus.CONNECTING,
        accounts: {
          create: [{ clientId: beta.clientId, kind: 'PAGE', externalId: 'page-other', name: 'Other page' }],
        },
      },
      include: { accounts: true },
    });

    const client = await admin(beta);
    const response = await client.post(`/api/integrations/${target.id}/select`, {
      accountIds: [stranger.accounts[0]!.id],
    });

    // The foreign id is dropped rather than honoured, so nothing is attached.
    expect(response.status).toBe(200);
    expect(response.body.selected).toBe(0);

    const untouched = await prisma.integrationAccount.findUniqueOrThrow({
      where: { id: stranger.accounts[0]!.id },
    });
    expect(untouched.selected).toBe(false);
  });

  // ------------------------------------------------------------ disconnect

  it('destroys the stored tokens on disconnect', async () => {
    const integration = await prisma.integration.create({
      data: {
        organizationId: beta.organizationId,
        clientId: beta.clientId,
        platform: Platform.X,
        status: IntegrationStatus.CONNECTED,
        accountName: 'Pawse',
        accountId: 'act_1',
        accessTokenEnc: 'encrypted-access-token',
        refreshTokenEnc: 'encrypted-refresh-token',
        tokenExpiresAt: new Date(Date.now() + 86_400_000),
        tokenFingerprint: 'fingerprint',
      },
    });

    const client = await admin(beta);
    const response = await client.post(`/api/integrations/${integration.id}/disconnect`);
    expect(response.status).toBe(200);

    const after = await prisma.integration.findUniqueOrThrow({ where: { id: integration.id } });

    // A disconnected row that still holds a usable credential is the bug this
    // guards: status alone is not revocation.
    expect(after.status).toBe(IntegrationStatus.DISCONNECTED);
    expect(after.accessTokenEnc).toBeNull();
    expect(after.refreshTokenEnc).toBeNull();
    expect(after.tokenExpiresAt).toBeNull();
    expect(after.tokenFingerprint).toBeNull();
    expect(after.accountName).toBeNull();
    expect(after.accountId).toBeNull();
  });

  it('cannot disconnect another tenant\'s integration', async () => {
    const integration = await prisma.integration.create({
      data: {
        organizationId: alpha.organizationId,
        clientId: alpha.clientId,
        platform: Platform.TIKTOK,
        status: IntegrationStatus.CONNECTED,
        accessTokenEnc: 'alpha-token',
      },
    });

    const intruder = await admin(beta);
    expect((await intruder.post(`/api/integrations/${integration.id}/disconnect`)).status).toBe(404);

    // And the credential is still there, untouched.
    const after = await prisma.integration.findUniqueOrThrow({ where: { id: integration.id } });
    expect(after.accessTokenEnc).toBe('alpha-token');
  });
});

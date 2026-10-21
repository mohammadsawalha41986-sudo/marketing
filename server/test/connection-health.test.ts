/**
 * Connection health: classification, renewal, and what the list reports.
 *
 * Every provider here is a fake `fetch` with the real response shape. That
 * proves this application handles each answer correctly; it proves nothing
 * about whether a real provider gives that answer — the Integrations Center's
 * Test Connection against a live account is the only test of that.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntegrationStatus, Platform } from '@prisma/client';

import { agent, createTenant, prisma, resetDatabase, type Tenant } from './helpers.js';
import { decryptSecret, encryptSecret } from '../src/lib/crypto.js';
import { callbackUrl } from '../src/services/integrations/connect-flow.js';
import {
  classifyFailure, deriveState, freshAccountToken,
} from '../src/services/integrations/connection-health.js';
import { ProviderApiError } from '../src/services/integrations/meta.js';
import {
  REQUESTED_SCOPES, permissionReport, permissionRequirements,
} from '../src/services/integrations/permissions.js';

const KEY = 'Zm9yLXRlc3Rpbmctb25seS0zMi1ieXRlLWtleS0hIQ==';
const BASE = 'https://marketing-osserver-production.up.railway.app';
const ENV_KEYS = [
  'TOKEN_ENCRYPTION_KEY', 'TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET', 'TIKTOK_REDIRECT_URI',
  'META_APP_ID', 'META_APP_SECRET', 'META_REDIRECT_URI', 'META_CONFIG_ID',
];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

describe('connection health', () => {
  let alpha: Tenant;
  let beta: Tenant;
  const saved = { ...process.env };

  beforeAll(async () => {
    await resetDatabase();
    alpha = await createTenant('health-alpha');
    beta = await createTenant('health-beta');
  });

  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
    process.env.TIKTOK_CLIENT_KEY = 'awtestclientkey';
    process.env.TIKTOK_CLIENT_SECRET = 'tiktok-secret-never-echoed';
    process.env.TIKTOK_REDIRECT_URI = callbackUrl(BASE, Platform.TIKTOK);
    process.env.META_APP_ID = '1821333942563322';
    process.env.META_APP_SECRET = 'meta-secret';
    process.env.META_REDIRECT_URI = callbackUrl(BASE, Platform.FACEBOOK);
    process.env.META_CONFIG_ID = 'login-config-1';
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await prisma.integrationAccount.deleteMany({});
    await prisma.integration.deleteMany({});
  });

  const admin = async (tenant: Tenant) => {
    const client = agent();
    await client.login(tenant.adminEmail);
    return client;
  };

  /** A TikTok connection whose access token expired an hour ago. */
  const expiredTikTok = async (tenant: Tenant) => {
    const integration = await prisma.integration.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        platform: Platform.TIKTOK,
        status: IntegrationStatus.CONNECTED,
        accountName: 'Noriva Kitchen',
        accountId: 'open-id-1',
        scopes: ['user.info.basic', 'video.publish', 'video.upload', 'video.list'],
        accessTokenEnc: encryptSecret('act.old'),
        refreshTokenEnc: encryptSecret('rft.old'),
        tokenExpiresAt: new Date(Date.now() - 3_600_000),
        accounts: {
          create: [{
            clientId: tenant.clientId, kind: 'PROFILE', externalId: 'open-id-1', name: 'Noriva Kitchen',
            selected: true, accessTokenEnc: encryptSecret('act.old'), tokenStatus: 'TOKEN_VALID',
          }],
        },
      },
      include: { accounts: true },
    });
    return integration;
  };

  /** TikTok that renews and then answers only to the renewed token. */
  const tiktokFetch = (asked: string[]) => async (url: string | URL, init?: RequestInit) => {
    const target = String(url);
    asked.push(target);
    if (target.endsWith('/oauth/token/')) {
      const body = new URLSearchParams(String(init?.body));
      if (body.get('grant_type') !== 'refresh_token' || body.get('refresh_token') !== 'rft.old') {
        return json({ error: 'invalid_grant', error_description: 'bad refresh' }, 400);
      }
      return json({ access_token: 'act.new', refresh_token: 'rft.rotated', expires_in: 86_400, scope: 'user.info.basic,video.publish' });
    }
    if (target.includes('/user/info/')) {
      const auth = new Headers(init?.headers).get('authorization');
      if (auth !== 'Bearer act.new') {
        return json({ error: { code: 'access_token_invalid', message: 'The access token is invalid or not found in the request.' } }, 401);
      }
      return json({ data: { user: { open_id: 'open-id-1', display_name: 'Noriva Kitchen' } }, error: { code: 'ok' } });
    }
    return json({}, 404);
  };

  // ------------------------------------------------------------- classify

  it('tells an expired token, a missing permission and a failing API apart', () => {
    expect(classifyFailure(new ProviderApiError(Platform.TIKTOK, 401, 'TikTok token validation: invalid'))).toBe('TOKEN_EXPIRED');
    // Meta answers an expired token with 400 and code 190.
    expect(classifyFailure(new ProviderApiError(Platform.FACEBOOK, 400,
      'Meta token validation: Error validating access token: Session has expired on Monday'))).toBe('TOKEN_EXPIRED');
    expect(classifyFailure(new ProviderApiError(Platform.FACEBOOK, 403,
      'Meta: (#200) Requires pages_manage_posts permission to manage the object'))).toBe('MISSING_PERMISSIONS');
    // TikTok reports a refused scope in-band, with HTTP 200.
    expect(classifyFailure(new ProviderApiError(Platform.TIKTOK, 200,
      'TikTok: The user did not authorize the scope required for completing this request.'))).toBe('MISSING_PERMISSIONS');
    expect(classifyFailure(new ProviderApiError(Platform.GOOGLE_BUSINESS, 503, 'Google: backend unavailable'))).toBe('API_ERROR');
    expect(classifyFailure(new ProviderApiError(Platform.GOOGLE_BUSINESS, 429, 'Google: quota'))).toBe('API_ERROR');
    expect(classifyFailure(new TypeError('fetch failed'))).toBe('API_ERROR');
  });

  // -------------------------------------------------------------- renewal

  it('renews an expired TikTok token and writes it to the account that publishes with it', async () => {
    const integration = await expiredTikTok(alpha);
    const asked: string[] = [];
    vi.stubGlobal('fetch', tiktokFetch(asked));

    const client = await admin(alpha);
    const response = await client.get(`/api/integrations/${integration.id}/health`);

    expect(response.status).toBe(200);
    expect(response.body.state).toBe('CONNECTED');
    expect(response.body.live).toBe(true);
    expect(response.body.refreshed).toBe(true);
    expect(asked.some((url) => url.endsWith('/oauth/token/'))).toBe(true);

    const stored = await prisma.integration.findUniqueOrThrow({ where: { id: integration.id }, include: { accounts: true } });
    expect(decryptSecret(stored.accessTokenEnc!)).toBe('act.new');
    // TikTok rotated the refresh token; the retired one must not be kept.
    expect(decryptSecret(stored.refreshTokenEnc!)).toBe('rft.rotated');
    expect(stored.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(decryptSecret(stored.accounts[0]!.accessTokenEnc!)).toBe('act.new');

    // No token or secret in the response.
    const body = JSON.stringify(response.body);
    for (const secret of ['act.new', 'act.old', 'rft.rotated', 'rft.old', 'tiktok-secret-never-echoed']) {
      expect(body).not.toContain(secret);
    }
  });

  it('renews before publishing, so a post the day after connecting does not go out with a dead token', async () => {
    const integration = await expiredTikTok(alpha);
    const asked: string[] = [];

    const token = await freshAccountToken({
      prisma,
      accountId: integration.accounts[0]!.id,
      fetchImpl: tiktokFetch(asked) as never,
    });

    expect(token).toBe('act.new');
    expect(asked.filter((url) => url.endsWith('/oauth/token/'))).toHaveLength(1);
  });

  it('leaves a token that is not due alone', async () => {
    const integration = await expiredTikTok(alpha);
    await prisma.integration.update({
      where: { id: integration.id },
      data: { tokenExpiresAt: new Date(Date.now() + 6 * 3_600_000) },
    });
    const asked: string[] = [];

    const token = await freshAccountToken({ prisma, accountId: integration.accounts[0]!.id, fetchImpl: tiktokFetch(asked) as never });

    expect(token).toBe('act.old');
    expect(asked).toHaveLength(0);
  });

  it('marks a revoked refresh token TOKEN_EXPIRED instead of a generic error', async () => {
    const integration = await expiredTikTok(alpha);
    await prisma.integration.update({ where: { id: integration.id }, data: { refreshTokenEnc: encryptSecret('rft.revoked') } });
    vi.stubGlobal('fetch', async (url: string | URL) => (String(url).endsWith('/oauth/token/')
      ? json({ error: { code: 'invalid_grant', message: 'Refresh token is invalid or expired.' } }, 401)
      : json({}, 404)));

    const client = await admin(alpha);
    const response = await client.get(`/api/integrations/${integration.id}/health`);

    expect(response.body.state).toBe('TOKEN_EXPIRED');
    expect(response.body.live).toBe(false);
    const stored = await prisma.integration.findUniqueOrThrow({ where: { id: integration.id } });
    expect(stored.status).toBe(IntegrationStatus.TOKEN_EXPIRED);
  });

  // ---------------------------------------------------------- API failure

  it('does not disconnect a working connection because the provider had an outage', async () => {
    const integration = await expiredTikTok(alpha);
    await prisma.integration.update({
      where: { id: integration.id },
      data: { tokenExpiresAt: new Date(Date.now() + 6 * 3_600_000) },
    });
    vi.stubGlobal('fetch', async () => json({ error: { code: 'internal_error', message: 'Something went wrong' } }, 503));

    const client = await admin(alpha);
    const response = await client.get(`/api/integrations/${integration.id}/health`);

    expect(response.body.state).toBe('API_ERROR');
    const stored = await prisma.integration.findUniqueOrThrow({ where: { id: integration.id } });
    // The old route wrote ERROR here; an outage is not the operator's to fix.
    expect(stored.status).toBe(IntegrationStatus.CONNECTED);

    // And the list shows the last verdict rather than a stale green.
    const list = await client.get(`/api/integrations?clientId=${alpha.clientId}`);
    const row = list.body.items.find((item: { id: string }) => item.id === integration.id);
    expect(row.state).toBe('API_ERROR');
  });

  // --------------------------------------------------------------- Meta

  it('re-reads Meta\'s grant live and reports a removed permission, without refreshing what cannot be', async () => {
    const integration = await prisma.integration.create({
      data: {
        organizationId: alpha.organizationId,
        clientId: alpha.clientId,
        platform: Platform.FACEBOOK,
        status: IntegrationStatus.CONNECTED,
        scopes: ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement'],
        accessTokenEnc: encryptSecret('meta-user-token'),
        tokenExpiresAt: new Date(Date.now() + 30 * 86_400_000),
        accounts: { create: [{ clientId: alpha.clientId, kind: 'PAGE', externalId: 'page-1', name: 'Page', selected: true, accessTokenEnc: encryptSecret('page-token') }] },
      },
    });
    vi.stubGlobal('fetch', async (url: string | URL) => {
      const target = String(url);
      if (target.includes('/me/permissions')) {
        return json({ data: [
          { permission: 'pages_show_list', status: 'granted' },
          { permission: 'pages_manage_posts', status: 'declined' },
          { permission: 'pages_read_engagement', status: 'granted' },
        ] });
      }
      if (target.includes('/me?')) return json({ id: 'meta-user-1', name: 'Ops Admin' });
      return json({}, 404);
    });

    const client = await admin(alpha);
    const response = await client.post(`/api/integrations/${integration.id}/refresh-authorization`);

    expect(response.status).toBe(200);
    expect(response.body.state).toBe('MISSING_PERMISSIONS');
    expect(response.body.live).toBe(true);
    expect(response.body.refreshed).toBe(false);
    expect(response.body.detail).toMatch(/Meta issues no refresh token/);
    expect(response.body.permissions.missingRequired.map((entry: { scope: string }) => entry.scope)).toEqual(['pages_manage_posts']);

    const stored = await prisma.integration.findUniqueOrThrow({ where: { id: integration.id }, include: { accounts: true } });
    expect(stored.scopes).not.toContain('pages_manage_posts');
    // The Page's own credential is never overwritten with the user token.
    expect(decryptSecret(stored.accounts[0]!.accessTokenEnc!)).toBe('page-token');
  });

  // ----------------------------------------------------------- isolation

  it('refuses another organisation\'s connection on every health surface', async () => {
    const integration = await expiredTikTok(alpha);
    const intruder = await admin(beta);

    expect((await intruder.get(`/api/integrations/${integration.id}/health`)).status).toBe(404);
    expect((await intruder.post(`/api/integrations/${integration.id}/refresh-authorization`)).status).toBe(404);
    expect((await intruder.get(`/api/integrations/${integration.id}/permissions`)).status).toBe(404);
  });

  // ---------------------------------------------------------------- list

  it('lists a derived state and never a credential envelope', async () => {
    await expiredTikTok(alpha);
    const client = await admin(alpha);
    const response = await client.get(`/api/integrations?clientId=${alpha.clientId}`);

    const row = response.body.items[0];
    // A refresh token is present, so an expired access token is not yet a dead connection.
    expect(row.state).toBe('CONNECTED');
    expect(row).not.toHaveProperty('accessTokenEnc');
    expect(row).not.toHaveProperty('refreshTokenEnc');
    expect(row).not.toHaveProperty('metadata');
  });

  it('derives every state the screen shows', () => {
    const base = {
      status: IntegrationStatus.CONNECTED, hasCredential: true, hasRefreshToken: false,
      tokenExpiresAt: null, scopes: ['user.info.basic', 'video.publish'], lastError: null, metadata: {},
    };
    expect(deriveState({ platform: Platform.TIKTOK, integration: null }).state).toBe('DISCONNECTED');
    expect(deriveState({ platform: Platform.TIKTOK, integration: base }).state).toBe('CONNECTED');
    expect(deriveState({ platform: Platform.TIKTOK, integration: { ...base, status: IntegrationStatus.TOKEN_EXPIRED } }).state).toBe('TOKEN_EXPIRED');
    expect(deriveState({ platform: Platform.TIKTOK, integration: { ...base, tokenExpiresAt: new Date(0) } }).state).toBe('TOKEN_EXPIRED');
    expect(deriveState({ platform: Platform.TIKTOK, integration: { ...base, scopes: ['user.info.basic'] } }).state).toBe('MISSING_PERMISSIONS');
    expect(deriveState({ platform: Platform.TIKTOK, integration: { ...base, status: IntegrationStatus.ERROR } }).state).toBe('API_ERROR');

    delete process.env.TIKTOK_CLIENT_KEY;
    expect(deriveState({ platform: Platform.TIKTOK, integration: null }).state).toBe('CONFIGURATION_REQUIRED');
  });

  // --------------------------------------------------------- permissions

  it('describes exactly the scopes each adapter requests', () => {
    for (const [platform, requested] of Object.entries(REQUESTED_SCOPES)) {
      const described = permissionRequirements(platform as Platform).map((entry) => entry.scope).sort();
      expect(described, platform).toEqual([...requested!].sort());
    }
  });

  it('treats a grant of email as covering openid on Google', () => {
    const report = permissionReport(Platform.GOOGLE_BUSINESS, [
      'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/business.manage',
    ]);
    expect(report.missingRequired).toEqual([]);
  });
});

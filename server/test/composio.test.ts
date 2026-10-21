/**
 * Composio connections: lifecycle, tenant isolation, roles, and what never
 * leaves the server.
 *
 * Composio is an in-memory fake speaking the response shapes of Composio's own
 * generated client. These are MOCK integration tests: they prove this
 * application handles each answer correctly and prove nothing about a live
 * Composio project — that needs COMPOSIO_API_KEY and a real login.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientRole, Role } from '@prisma/client';

import { PASSWORD, agent, createTenant, prisma, resetDatabase, type Tenant } from './helpers.js';
import { hashPassword } from '../src/lib/password.js';
import { can, effectiveClientRole } from '../src/lib/rbac.js';
import { composioUserId, connectionState, resetCatalogCache } from '../src/services/composio/service.js';
import { estimateCost } from '../src/services/composio/usage.js';

const API_KEY = 'composio-key-never-echoed';
const OAUTH_SECRET = 'oauth-app-secret-never-echoed';
const ACCESS_TOKEN = 'ig-user-access-token-never-echoed';

interface FakeAccount {
  id: string; user_id: string; toolkit: string; auth_config: string; status: string; status_reason: string | null;
}

/** A Composio project with Instagram, Facebook and GA4 auth configs. */
function fakeComposio() {
  const accounts = new Map<string, FakeAccount>();
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown>; key: string | null }> = [];
  let seq = 0;
  let outage = false;
  let toolResult: { successful: boolean; error: string | null } = { successful: true, error: null };

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
  const wire = (account: FakeAccount) => ({
    id: account.id, user_id: account.user_id, alias: null, is_disabled: false,
    toolkit: { slug: account.toolkit }, auth_config: { id: account.auth_config, is_composio_managed: false },
    status: account.status, status_reason: account.status_reason,
    created_at: '2026-10-21T00:00:00Z', updated_at: '2026-10-21T00:00:00Z',
    // What must never be forwarded.
    state: { authScheme: 'OAUTH2', val: { status: account.status, access_token: ACCESS_TOKEN } },
    data: { access_token: ACCESS_TOKEN },
  });

  const handler = async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ method, path: url.pathname + url.search, body, key: new Headers(init?.headers).get('x-api-key') });
    if (!url.hostname.endsWith('composio.dev')) return json({}, 404);
    if (new Headers(init?.headers).get('x-api-key') !== API_KEY) return json({ error: { message: 'Invalid API key' } }, 401);
    if (outage) return json({ error: { message: 'upstream unavailable' } }, 503);

    if (url.pathname === '/api/v3.1/auth_configs') {
      const config = (id: string, slug: string) => ({
        id, name: `${slug} app`, status: 'ENABLED', type: 'custom', uuid: id, no_of_connections: 0,
        toolkit: { slug, logo: '' }, auth_scheme: 'OAUTH2', is_composio_managed: false,
        credentials: { client_id: 'cid', client_secret: OAUTH_SECRET },
      });
      return json({ items: [config('ac_ig', 'instagram'), config('ac_fb', 'facebook'), config('ac_ga', 'google_analytics'),
        { ...config('ac_off', 'tiktok'), status: 'DISABLED' }], current_page: 1, total_items: 4, total_pages: 1 });
    }
    if (url.pathname === '/api/v3.1/connected_accounts/link' && method === 'POST') {
      seq += 1;
      const id = `ca_${seq}`;
      accounts.set(id, {
        id, user_id: String(body!.user_id), toolkit: body!.auth_config_id === 'ac_ig' ? 'instagram' : body!.auth_config_id === 'ac_fb' ? 'facebook' : 'google_analytics',
        auth_config: String(body!.auth_config_id), status: 'INITIATED', status_reason: null,
      });
      return json({ connected_account_id: id, redirect_url: `https://connect.composio.dev/link/${id}`, link_token: 'lt', expires_at: '2026-10-21T01:00:00Z' }, 201);
    }
    if (url.pathname === '/api/v3.1/connected_accounts' && method === 'GET') {
      const users = (url.searchParams.get('user_ids') ?? '').split(',');
      return json({ items: [...accounts.values()].filter((a) => users.includes(a.user_id)).map(wire), current_page: 1, total_items: 0, total_pages: 1 });
    }
    const one = url.pathname.match(/^\/api\/v3\.1\/connected_accounts\/([^/]+)$/);
    if (one) {
      const account = accounts.get(one[1]!);
      if (!account) return json({ error: { message: 'Not found' } }, 404);
      if (method === 'DELETE') {
        accounts.delete(account.id);
        return json({ success: true });
      }
      return json(wire(account));
    }
    if (url.pathname.startsWith('/api/v3.1/tools/execute/')) {
      return json({ data: { secret: ACCESS_TOKEN }, ...toolResult });
    }
    return json({ error: { message: 'unknown route' } }, 404);
  };

  return {
    handler,
    accounts,
    calls,
    activateAll: () => { for (const account of accounts.values()) account.status = 'ACTIVE'; },
    setOutage: (value: boolean) => { outage = value; },
    setToolResult: (value: typeof toolResult) => { toolResult = value; },
  };
}

describe('Composio connections', () => {
  let alpha: Tenant;
  let beta: Tenant;
  let fake: ReturnType<typeof fakeComposio>;
  const saved = { ...process.env };

  beforeAll(async () => {
    await resetDatabase();
    alpha = await createTenant('composio-alpha');
    beta = await createTenant('composio-beta');
    await prisma.user.create({
      data: {
        name: 'Creator', email: 'creator@composio-alpha.test', passwordHash: await hashPassword(PASSWORD),
        role: Role.CLIENT_USER, clientRole: ClientRole.CONTENT_CREATOR,
        organizationId: alpha.organizationId, clientId: alpha.clientId,
      },
    });
  });

  beforeEach(() => {
    process.env.COMPOSIO_API_KEY = API_KEY;
    resetCatalogCache();
    fake = fakeComposio();
    vi.stubGlobal('fetch', fake.handler);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const key of ['COMPOSIO_API_KEY', 'COMPOSIO_VERIFY_TOOL_INSTAGRAM', 'COMPOSIO_PLAN_MONTHLY_USD', 'COMPOSIO_INCLUDED_CALLS', 'COMPOSIO_OVERAGE_PER_1K_USD']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await prisma.composioConnection.deleteMany({});
    await prisma.providerCallLog.deleteMany({});
    await prisma.notification.deleteMany({});
  });

  const login = async (email: string) => {
    const client = agent();
    await client.login(email);
    return client;
  };

  /** Connect through the API and let the fake complete the hosted login. */
  const connect = async (email: string, clientId: string, authConfigId: string) => {
    const client = await login(email);
    const response = await client.post(`/api/composio/${clientId}/connections`, { authConfigId });
    expect(response.status).toBe(201);
    return { client, response };
  };

  // ------------------------------------------------------------ catalog

  it('lists only enabled auth configs, grouped by platform, and never the OAuth secret', async () => {
    const client = await login(alpha.adminEmail);
    const response = await client.get('/api/composio/catalog');

    expect(response.status).toBe(200);
    expect(response.body.configured).toBe(true);
    const byKey = Object.fromEntries(response.body.platforms.map((p: { key: string }) => [p.key, p]));
    expect(byKey.INSTAGRAM.supported).toBe(true);
    expect(byKey.GOOGLE_ANALYTICS.supported).toBe(true);
    // Disabled in the project, so not offered.
    expect(byKey.TIKTOK.supported).toBe(false);
    expect(JSON.stringify(response.body)).not.toContain(OAUTH_SECRET);
  });

  it('says plainly when Composio is not configured', async () => {
    delete process.env.COMPOSIO_API_KEY;
    const client = await login(alpha.adminEmail);
    const response = await client.get('/api/composio/catalog');
    expect(response.body.configured).toBe(false);
    expect(response.body.reason).toMatch(/COMPOSIO_API_KEY/);
  });

  it('maps a rejected API key to an actionable 502, without the key', async () => {
    process.env.COMPOSIO_API_KEY = 'wrong-key';
    const client = await login(alpha.adminEmail);
    const response = await client.get('/api/composio/catalog');
    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe('COMPOSIO_AUTH');
    expect(JSON.stringify(response.body)).not.toContain('wrong-key');
  });

  // ------------------------------------------------------------ connect

  it('lets a restaurant owner connect their own account, under an id derived on the server', async () => {
    const { response } = await connect(alpha.clientAdminEmail, alpha.clientId, 'ac_ig');

    expect(response.body.redirectUrl).toMatch(/^https:\/\/connect\.composio\.dev\//);
    const link = fake.calls.find((call) => call.path === '/api/v3.1/connected_accounts/link');
    expect(link!.body!.user_id).toBe(composioUserId(alpha.clientId));
    // The owner returns to the restaurant portal, not the agency app.
    expect(String(link!.body!.callback_url)).toContain('/client/integrations?composio=returned');

    const row = await prisma.composioConnection.findFirstOrThrow({ where: { clientId: alpha.clientId } });
    expect(row.remoteStatus).toBe('INITIATED');
    expect(connectionState(row)).toBe('PENDING_APPROVAL');
  });

  it('connects two accounts of the same platform for one restaurant, and shows both Connected only once Composio says ACTIVE', async () => {
    const { client } = await connect(alpha.adminEmail, alpha.clientId, 'ac_ig');
    await client.post(`/api/composio/${alpha.clientId}/connections`, { authConfigId: 'ac_ig', alias: 'Second branch' }).expect(201);

    let list = await client.get(`/api/composio/${alpha.clientId}/connections`);
    expect(list.body.items.map((item: { state: string }) => item.state)).toEqual(['PENDING_APPROVAL', 'PENDING_APPROVAL']);

    fake.activateAll();
    const synced = await client.post(`/api/composio/${alpha.clientId}/sync`);
    expect(synced.status).toBe(200);
    list = await client.get(`/api/composio/${alpha.clientId}/connections`);
    expect(list.body.items).toHaveLength(2);
    expect(list.body.items.every((item: { state: string; verification: string }) =>
      item.state === 'CONNECTED' && item.verification === 'COMPOSIO_STATUS')).toBe(true);

    // Neither the user's token nor Composio's key reaches the browser.
    for (const body of [synced.body, list.body]) {
      expect(JSON.stringify(body)).not.toContain(ACCESS_TOKEN);
      expect(JSON.stringify(body)).not.toContain(API_KEY);
    }
  });

  it('refuses an auth config this project does not offer', async () => {
    const client = await login(alpha.adminEmail);
    const response = await client.post(`/api/composio/${alpha.clientId}/connections`, { authConfigId: 'ac_off' });
    expect(response.status).toBe(400);
    expect(fake.calls.some((call) => call.path.endsWith('/link'))).toBe(false);
  });

  // ---------------------------------------------------------- isolation

  it('keeps every restaurant\'s connections to itself', async () => {
    await connect(alpha.adminEmail, alpha.clientId, 'ac_ig');
    const row = await prisma.composioConnection.findFirstOrThrow({ where: { clientId: alpha.clientId } });

    // Another organisation's admin.
    const outsider = await login(beta.adminEmail);
    expect((await outsider.get(`/api/composio/${alpha.clientId}/connections`)).status).toBe(404);
    expect((await outsider.post(`/api/composio/connections/${row.id}/test`)).status).toBe(404);
    expect((await outsider.delete(`/api/composio/connections/${row.id}`)).status).toBe(404);
    expect((await outsider.get(`/api/composio/connections/${row.id}/history`)).status).toBe(404);

    // A restaurant user of the same organisation's *other* restaurant.
    const otherRestaurant = await prisma.client.create({
      data: { organizationId: alpha.organizationId, name: 'alpha second', businessName: 'Alpha Second' },
    });
    await prisma.user.create({
      data: {
        name: 'Other owner', email: 'owner2@composio-alpha.test', passwordHash: await hashPassword(PASSWORD),
        role: Role.CLIENT_ADMIN, organizationId: alpha.organizationId, clientId: otherRestaurant.id,
      },
    });
    const neighbour = await login('owner2@composio-alpha.test');
    expect((await neighbour.get(`/api/composio/${alpha.clientId}/connections`)).status).toBe(404);
    expect((await neighbour.post(`/api/composio/connections/${row.id}/test`)).status).toBe(404);

    // Nothing was removed at Composio by either attempt.
    expect(fake.accounts.size).toBe(1);
  });

  it('drops an account Composio lists under another restaurant\'s user id', async () => {
    fake.accounts.set('ca_foreign', {
      id: 'ca_foreign', user_id: composioUserId(beta.clientId), toolkit: 'instagram',
      auth_config: 'ac_ig', status: 'ACTIVE', status_reason: null,
    });
    // A misbehaving filter that returns everything.
    const original = fake.handler;
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v3.1/connected_accounts') url.searchParams.set('user_ids', [...fake.accounts.values()].map((a) => a.user_id).join(','));
      return original(url.toString(), init);
    });

    const client = await login(alpha.adminEmail);
    await client.post(`/api/composio/${alpha.clientId}/sync`).expect(200);
    expect(await prisma.composioConnection.count({ where: { clientId: alpha.clientId } })).toBe(0);
  });

  // --------------------------------------------------------------- roles

  it('lets a content creator see connections but not add or remove them', async () => {
    await connect(alpha.adminEmail, alpha.clientId, 'ac_ig');
    const row = await prisma.composioConnection.findFirstOrThrow({ where: { clientId: alpha.clientId } });
    const creator = await login('creator@composio-alpha.test');

    expect((await creator.get(`/api/composio/${alpha.clientId}/connections`)).status).toBe(200);
    expect((await creator.post(`/api/composio/${alpha.clientId}/connections`, { authConfigId: 'ac_ig' })).status).toBe(403);
    expect((await creator.delete(`/api/composio/connections/${row.id}`)).status).toBe(403);

    const viewer = await login(alpha.clientUserEmail);
    expect((await viewer.post(`/api/composio/${alpha.clientId}/connections`, { authConfigId: 'ac_ig' })).status).toBe(403);
    expect((await viewer.get('/api/composio/usage')).status).toBe(403);
  });

  it('applies the role matrix, with defaults for accounts created before restaurant roles existed', () => {
    expect(effectiveClientRole({ role: Role.CLIENT_ADMIN, clientRole: null })).toBe(ClientRole.OWNER);
    expect(effectiveClientRole({ role: Role.CLIENT_USER, clientRole: null })).toBe(ClientRole.VIEWER);
    // A CLIENT_USER cannot be lifted to OWNER through the column.
    expect(effectiveClientRole({ role: Role.CLIENT_USER, clientRole: ClientRole.OWNER })).toBe(ClientRole.MANAGER);
    expect(can({ role: Role.CLIENT_USER, clientRole: ClientRole.CONTENT_CREATOR }, 'content.create')).toBe(true);
    expect(can({ role: Role.CLIENT_USER, clientRole: ClientRole.CONTENT_CREATOR }, 'budgets.manage')).toBe(false);
    expect(can({ role: Role.CLIENT_USER, clientRole: ClientRole.FINANCIAL_ANALYST }, 'finance.view')).toBe(true);
    expect(can({ role: Role.CLIENT_USER, clientRole: ClientRole.FINANCIAL_ANALYST }, 'integrations.manage')).toBe(false);
    expect(can({ role: Role.AGENCY_STAFF }, 'usage.view')).toBe(false);
    expect(can({ role: Role.SUPER_ADMIN }, 'usage.view')).toBe(true);
  });

  it('reports permissions on /auth/me so the screen hides what it cannot do', async () => {
    const creator = await login('creator@composio-alpha.test');
    const me = await creator.get('/api/auth/me');
    expect(me.body.user.permissions).toContain('content.create');
    expect(me.body.user.permissions).not.toContain('integrations.manage');
  });

  // ---------------------------------------------------- health and failure

  it('marks an expired authorisation, and tells the restaurant and the agency', async () => {
    const { client } = await connect(alpha.adminEmail, alpha.clientId, 'ac_ig');
    fake.activateAll();
    await client.post(`/api/composio/${alpha.clientId}/sync`).expect(200);
    for (const account of fake.accounts.values()) {
      account.status = 'EXPIRED';
      account.status_reason = 'Refresh token revoked by user';
    }
    const synced = await client.post(`/api/composio/${alpha.clientId}/sync`);

    expect(synced.body.items[0].state).toBe('TOKEN_EXPIRED');
    expect(synced.body.items[0].statusReason).toBe('Refresh token revoked by user');
    const notes = await prisma.notification.findMany({ where: { clientId: alpha.clientId, type: 'INTEGRATION_DISCONNECTED' } });
    expect(notes.length).toBeGreaterThan(0);
  });

  it('reports a Composio outage as API error and keeps the last known status', async () => {
    const { client } = await connect(alpha.adminEmail, alpha.clientId, 'ac_ig');
    fake.activateAll();
    await client.post(`/api/composio/${alpha.clientId}/sync`).expect(200);
    const row = await prisma.composioConnection.findFirstOrThrow({ where: { clientId: alpha.clientId } });

    fake.setOutage(true);
    const tested = await client.post(`/api/composio/connections/${row.id}/test`);
    expect(tested.status).toBe(200);
    expect(tested.body.state).toBe('API_ERROR');
    expect(tested.body.remoteStatus).toBe('ACTIVE');
  });

  it('verifies through the platform when a read-only tool is configured, and names a permission refusal', async () => {
    process.env.COMPOSIO_VERIFY_TOOL_INSTAGRAM = 'INSTAGRAM_GET_USER_INFO';
    const { client } = await connect(alpha.adminEmail, alpha.clientId, 'ac_ig');
    fake.activateAll();
    const row = await prisma.composioConnection.findFirstOrThrow({ where: { clientId: alpha.clientId } });

    const ok = await client.post(`/api/composio/connections/${row.id}/test`);
    expect(ok.body.state).toBe('CONNECTED');
    expect(ok.body.verification).toBe('PROVIDER_CALL');
    expect(JSON.stringify(ok.body)).not.toContain(ACCESS_TOKEN);

    fake.setToolResult({ successful: false, error: 'Missing permission instagram_business_basic' });
    const refused = await client.post(`/api/composio/connections/${row.id}/test`);
    expect(refused.body.state).toBe('MISSING_PERMISSIONS');
  });

  // ------------------------------------------------- reconnect / disconnect

  it('replaces a connection on reconnect only once the new login is active', async () => {
    const { client } = await connect(alpha.adminEmail, alpha.clientId, 'ac_ig');
    fake.activateAll();
    await client.post(`/api/composio/${alpha.clientId}/sync`).expect(200);
    const old = await prisma.composioConnection.findFirstOrThrow({ where: { clientId: alpha.clientId } });

    const reconnect = await client.post(`/api/composio/connections/${old.id}/reconnect`);
    expect(reconnect.status).toBe(201);
    // Not yet completed: the old connection is still there.
    await client.post(`/api/composio/${alpha.clientId}/sync`).expect(200);
    expect(await prisma.composioConnection.count({ where: { clientId: alpha.clientId } })).toBe(2);

    fake.activateAll();
    await client.post(`/api/composio/${alpha.clientId}/sync`).expect(200);
    const remaining = await prisma.composioConnection.findMany({ where: { clientId: alpha.clientId } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).not.toBe(old.id);
    expect(fake.accounts.has(old.composioAccountId)).toBe(false);
  });

  it('disconnects at Composio and locally, and records the history', async () => {
    const { client } = await connect(alpha.adminEmail, alpha.clientId, 'ac_fb');
    const row = await prisma.composioConnection.findFirstOrThrow({ where: { clientId: alpha.clientId } });
    await client.post(`/api/composio/connections/${row.id}/test`).expect(200);

    const history = await client.get(`/api/composio/connections/${row.id}/history`);
    expect(history.body.items.map((event: { action: string }) => event.action)).toEqual(['composio.test', 'composio.connect']);

    await client.delete(`/api/composio/connections/${row.id}`).expect(200);
    expect(fake.accounts.has(row.composioAccountId)).toBe(false);
    expect(await prisma.composioConnection.count({ where: { id: row.id } })).toBe(0);
    expect(fake.calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
  });

  // ------------------------------------------------------------- usage

  it('counts restaurants, connections and Composio calls, and estimates cost only from entered prices', async () => {
    const { client } = await connect(alpha.adminEmail, alpha.clientId, 'ac_ig');
    await client.post(`/api/composio/${alpha.clientId}/sync`).expect(200);
    // Metering is fire-and-forget; give it a tick to land.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const usage = await client.get('/api/composio/usage');
    expect(usage.status).toBe(200);
    expect(usage.body.totalRestaurants).toBeGreaterThanOrEqual(1);
    expect(usage.body.calls.thisMonth).toBeGreaterThanOrEqual(3);
    expect(usage.body.perRestaurant.find((row: { clientId: string }) => row.clientId === alpha.clientId).composio).toBe(1);
    expect(usage.body.cost.estimatedUsd).toBeNull();
    expect(usage.body.cost.reason).toMatch(/COMPOSIO_PLAN_MONTHLY_USD/);

    // Beta's calls are not Alpha's.
    const betaAdmin = await login(beta.adminEmail);
    const betaUsage = await betaAdmin.get('/api/composio/usage');
    expect(betaUsage.body.calls.thisMonth).toBe(0);
  });

  it('computes the estimate from the plan the operator entered', () => {
    expect(estimateCost(12_000, {
      COMPOSIO_PLAN_MONTHLY_USD: '29', COMPOSIO_INCLUDED_CALLS: '10000', COMPOSIO_OVERAGE_PER_1K_USD: '0.5',
    } as NodeJS.ProcessEnv)).toEqual({ estimatedUsd: 30, reason: null });
  });
});

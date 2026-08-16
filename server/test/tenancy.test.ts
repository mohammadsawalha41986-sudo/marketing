/**
 * Tenant isolation and role authorization.
 *
 * This is the suite that matters most: it proves one tenant cannot reach
 * another's rows even when it names their ids directly.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { Agent, agent, createSuperAdmin, createTenant, prisma, resetDatabase, type Tenant } from './helpers.js';

describe('tenant isolation', () => {
  let alpha: Tenant;
  let beta: Tenant;
  let alphaAdmin: Agent;
  let betaAdmin: Agent;
  let alphaClient: Agent;

  beforeAll(async () => {
    await resetDatabase();
    alpha = await createTenant('alpha');
    beta = await createTenant('beta');
    await createSuperAdmin(alpha.organizationId);

    alphaAdmin = agent();
    await alphaAdmin.login(alpha.adminEmail);
    betaAdmin = agent();
    await betaAdmin.login(beta.adminEmail);
    alphaClient = agent();
    await alphaClient.login(alpha.clientAdminEmail);
  });

  it('lists only the caller organization clients', async () => {
    const response = await alphaAdmin.get('/api/clients');
    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].id).toBe(alpha.clientId);
  });

  it('returns 404 when one agency requests another agency client by id', async () => {
    const response = await alphaAdmin.get(`/api/clients/${beta.clientId}`);
    expect(response.status).toBe(404);
  });

  it('returns 404 for another tenant campaign, content and report by id', async () => {
    expect((await alphaAdmin.get(`/api/campaigns/${beta.campaignId}`)).status).toBe(404);
    expect((await alphaAdmin.get(`/api/content/${beta.contentId}`)).status).toBe(404);
    expect((await alphaAdmin.get(`/api/brands/${beta.clientId}`)).status).toBe(404);
  });

  it('returns 404 for another tenant campaign finance and cost lines', async () => {
    expect((await alphaAdmin.get(`/api/campaigns/${beta.campaignId}/finance`)).status).toBe(404);
    expect((await alphaAdmin.get(`/api/campaigns/${beta.campaignId}/costs`)).status).toBe(404);
  });

  it('refuses to attach a cost line to another tenant campaign', async () => {
    const response = await alphaAdmin.post(`/api/campaigns/${beta.campaignId}/costs`, {
      kind: 'ACTUAL',
      category: 'ADVERTISING',
      amount: 500,
    });
    expect(response.status).toBe(404);
    expect(await prisma.campaignCost.count({ where: { campaignId: beta.campaignId } })).toBe(0);
  });

  it('scopes the executive overview to the caller organization', async () => {
    const response = await alphaAdmin.get('/api/ceo/overview');
    expect(response.status).toBe(200);
    const ids = response.body.campaigns.map((campaign: { id: string }) => campaign.id);
    expect(ids).toContain(alpha.campaignId);
    expect(ids).not.toContain(beta.campaignId);
  });

  it('pins a client user executive overview to their own client', async () => {
    // Naming another client is a miss, not a permission error, so the API
    // never confirms that the other client exists.
    const foreign = await alphaClient.get(`/api/ceo/overview?clientId=${beta.clientId}`);
    expect(foreign.status).toBe(404);

    const own = await alphaClient.get('/api/ceo/overview');
    expect(own.status).toBe(200);
    for (const campaign of own.body.campaigns) {
      expect(campaign.clientId).toBe(alpha.clientId);
    }
  });

  it('ignores a foreign clientId passed as a filter', async () => {
    const response = await alphaAdmin.get(`/api/campaigns?clientId=${beta.clientId}`);
    expect(response.status).toBe(200);
    // Scoped by organization, so a foreign id simply matches nothing.
    expect(response.body.items).toHaveLength(0);
  });

  it('refuses to create content against another tenant client', async () => {
    const response = await alphaAdmin.post('/api/content', {
      clientId: beta.clientId,
      name: 'Cross-tenant attempt',
      platform: 'INSTAGRAM',
    });
    expect(response.status).toBe(404);

    const leaked = await prisma.content.findFirst({ where: { name: 'Cross-tenant attempt' } });
    expect(leaked).toBeNull();
  });

  it('refuses to create a campaign against another tenant client', async () => {
    const response = await alphaAdmin.post('/api/campaigns', {
      clientId: beta.clientId,
      name: 'Cross-tenant campaign',
      budget: 100,
      startDate: '2026-01-01',
      endDate: '2026-02-01',
      platforms: [{ platform: 'INSTAGRAM', budget: 100 }],
    });
    expect(response.status).toBe(404);
    expect(await prisma.campaign.findFirst({ where: { name: 'Cross-tenant campaign' } })).toBeNull();
  });

  it('scopes analytics to the caller organization', async () => {
    const mine = await alphaAdmin.get('/api/analytics/dashboard');
    const theirs = await betaAdmin.get('/api/analytics/dashboard');

    expect(mine.status).toBe(200);
    expect(mine.body.kpis.clients).toBe(1);
    expect(theirs.body.kpis.clients).toBe(1);
    // Both tenants have identical fixtures, so equal totals prove they are not summed together.
    expect(mine.body.kpis.spend).toBe(theirs.body.kpis.spend);
  });

  it('cannot delete another tenant client', async () => {
    const response = await alphaAdmin.delete(`/api/clients/${beta.clientId}`);
    expect(response.status).toBe(404);
    expect(await prisma.client.findUnique({ where: { id: beta.clientId } })).not.toBeNull();
  });
});

describe('role authorization', () => {
  let tenant: Tenant;
  let staff: Agent;
  let clientAdmin: Agent;
  let clientUser: Agent;
  let superAdmin: Agent;

  beforeAll(async () => {
    await resetDatabase();
    tenant = await createTenant('roles');
    await createSuperAdmin(tenant.organizationId, 'root@roles.test');

    staff = agent();
    await staff.login(tenant.staffEmail);
    clientAdmin = agent();
    await clientAdmin.login(tenant.clientAdminEmail);
    clientUser = agent();
    await clientUser.login(tenant.clientUserEmail);
    superAdmin = agent();
    await superAdmin.login('root@roles.test');
  });

  it('lets agency staff read but not create clients', async () => {
    expect((await staff.get('/api/clients')).status).toBe(200);
    const created = await staff.post('/api/clients', { name: 'Staff client', businessName: 'Staff client' });
    expect(created.status).toBe(403);
  });

  it('gives a client user only their own client, read-only', async () => {
    const list = await clientUser.get('/api/clients');
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].id).toBe(tenant.clientId);

    const write = await clientUser.post('/api/campaigns', {
      clientId: tenant.clientId, name: 'Nope', budget: 1,
      startDate: '2026-01-01', endDate: '2026-02-01',
      platforms: [{ platform: 'INSTAGRAM', budget: 1 }],
    });
    expect(write.status).toBe(403);
  });

  it('blocks client accounts from the admin surface', async () => {
    expect((await clientAdmin.get('/api/admin/dashboard')).status).toBe(403);
    expect((await clientUser.get('/api/admin/clients')).status).toBe(403);
  });

  it('blocks agency admins from the admin surface', async () => {
    const admin = agent();
    await admin.login(tenant.adminEmail);
    expect((await admin.get('/api/admin/dashboard')).status).toBe(403);
  });

  it('allows the super admin across organizations, but only on /api/admin', async () => {
    const other = await createTenant('otherorg');

    const platform = await superAdmin.get('/api/admin/clients');
    expect(platform.status).toBe(200);
    const ids = platform.body.items.map((row: { id: string }) => row.id);
    expect(ids).toContain(tenant.clientId);
    expect(ids).toContain(other.clientId);

    // On the normal API the same account is scoped to its own organization.
    const scoped = await superAdmin.get('/api/clients');
    expect(scoped.body.items.map((row: { id: string }) => row.id)).not.toContain(other.clientId);
  });

  it('lets only a client admin decide approvals, not a client user', async () => {
    const approval = await prisma.approval.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        contentId: tenant.contentId,
        status: 'PENDING',
      },
    });

    const denied = await clientUser.post(`/api/approvals/${approval.id}/decision`, { status: 'APPROVED' });
    expect(denied.status).toBe(403);

    const allowed = await clientAdmin.post(`/api/approvals/${approval.id}/decision`, { status: 'APPROVED' });
    expect(allowed.status).toBe(200);
  });

  it('does not let an agency admin grant super admin', async () => {
    const admin = agent();
    await admin.login(tenant.adminEmail);
    const response = await admin.post('/api/users', {
      name: 'Escalation', email: 'escalate@roles.test', password: 'Passw0rd!esc', role: 'SUPER_ADMIN',
    });
    expect(response.status).toBe(400);
    expect(await prisma.user.findUnique({ where: { email: 'escalate@roles.test' } })).toBeNull();
  });

  it('never exposes integration credentials through the API', async () => {
    await prisma.integration.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        platform: 'INSTAGRAM',
        status: 'CONNECTED',
        credentials: { accessToken: 'super-secret-token' },
      },
    });

    const admin = agent();
    await admin.login(tenant.adminEmail);
    const response = await admin.get('/api/integrations');

    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain('super-secret-token');
    expect(response.body.items[0]).not.toHaveProperty('credentials');
  });
});

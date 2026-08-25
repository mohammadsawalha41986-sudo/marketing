import { beforeAll, describe, expect, it } from 'vitest';

import { Agent, agent, createTenant, prisma, resetDatabase, type Tenant } from './helpers.js';

/**
 * The Report Builder over HTTP: the lifecycle, and the boundary.
 *
 * The boundary is the half that matters. A report is a document an agency hands
 * to a paying client, so a builder that could be pointed at another
 * organisation's `clientId` would not leak a row — it would render a rival's
 * numbers into a branded PDF. Every route is therefore exercised across two
 * tenants naming each other's ids directly.
 */
describe('report builder routes', () => {
  let alpha: Tenant;
  let beta: Tenant;
  let alphaAdmin: Agent;
  let betaAdmin: Agent;
  let alphaClientUser: Agent;

  beforeAll(async () => {
    await resetDatabase();
    alpha = await createTenant('alpha');
    beta = await createTenant('beta');

    alphaAdmin = agent();
    await alphaAdmin.login(alpha.adminEmail);
    betaAdmin = agent();
    await betaAdmin.login(beta.adminEmail);
    alphaClientUser = agent();
    await alphaClientUser.login(alpha.clientAdminEmail);
  });

  const draft = (clientId: string) => ({
    clientId,
    title: 'Monthly performance',
    periodStart: '2026-01-01',
    periodEnd: '2026-01-31',
    description: 'For the owner',
    platforms: ['INSTAGRAM', 'TIKTOK'],
    metrics: ['engagements', 'reach', 'saves'],
    sections: ['OVERVIEW', 'PLATFORMS', 'TOP_CONTENT'],
  });

  // ------------------------------------------------------------- lifecycle

  it('creates, reads back and renders a saved report', async () => {
    const created = await alphaAdmin.post('/api/reports/builder', draft(alpha.clientId));
    expect(created.status).toBe(201);
    expect(created.body.report.type).toBe('BUILDER');
    expect(created.body.report.payload.builder.metrics).toEqual(['engagements', 'reach', 'saves']);

    const data = await alphaAdmin.get(`/api/reports/builder/${created.body.report.id}/data`);
    expect(data.status).toBe(200);
    expect(data.body.config.platforms).toEqual(['INSTAGRAM', 'TIKTOK']);
    // One qualified figure per selected metric, each carrying a state.
    expect(data.body.data.totals).toHaveLength(3);
    for (const total of data.body.data.totals) {
      expect(['ZERO', 'UNAVAILABLE', 'NOT_FETCHED', 'PROVIDER_ERROR']).toContain(total.state);
    }
  });

  it('edits a saved report without disturbing the parts not sent', async () => {
    const created = await alphaAdmin.post('/api/reports/builder', draft(alpha.clientId));
    const id = created.body.report.id;

    const patched = await alphaAdmin.patch(`/api/reports/builder/${id}`, { title: 'Renamed' });

    expect(patched.status).toBe(200);
    expect(patched.body.report.title).toBe('Renamed');
    // Untouched fields survive a partial update.
    expect(patched.body.report.payload.builder.metrics).toEqual(['engagements', 'reach', 'saves']);
    expect(patched.body.report.payload.builder.description).toBe('For the owner');
  });

  it('duplicates a report as a new row rather than moving the original', async () => {
    const created = await alphaAdmin.post('/api/reports/builder', draft(alpha.clientId));
    const copy = await alphaAdmin.post(`/api/reports/builder/${created.body.report.id}/duplicate`, {});

    expect(copy.status).toBe(201);
    expect(copy.body.report.id).not.toBe(created.body.report.id);
    expect(copy.body.report.title).toContain('copy');
    expect(copy.body.report.payload.builder).toEqual(created.body.report.payload.builder);

    // The original is still there and unchanged.
    const original = await alphaAdmin.get(`/api/reports/${created.body.report.id}`);
    expect(original.status).toBe(200);
    expect(original.body.report.title).toBe('Monthly performance');
  });

  it('previews an unsaved configuration without persisting anything', async () => {
    const before = await prisma.report.count({ where: { organizationId: alpha.organizationId } });

    const preview = await alphaAdmin.post('/api/reports/builder/preview', draft(alpha.clientId));

    expect(preview.status).toBe(200);
    expect(preview.body.data.totals).toHaveLength(3);
    expect(await prisma.report.count({ where: { organizationId: alpha.organizationId } })).toBe(before);
  });

  it('refuses a period that ends before it starts', async () => {
    const response = await alphaAdmin.post('/api/reports/builder', {
      ...draft(alpha.clientId), periodStart: '2026-02-01', periodEnd: '2026-01-01',
    });
    expect(response.status).toBe(400);
  });

  it('lists builder reports separately from generated snapshots', async () => {
    await alphaAdmin.post('/api/reports/builder', draft(alpha.clientId));
    const response = await alphaAdmin.get('/api/reports?type=BUILDER');

    expect(response.status).toBe(200);
    expect(response.body.items.length).toBeGreaterThan(0);
    for (const row of response.body.items) expect(row.type).toBe('BUILDER');
  });

  // --------------------------------------------------------------- scoping

  it('scopes totals to the selected platforms rather than the whole account', async () => {
    /*
     * The regression this guards: Phase 14's `periodTotals` is computed across
     * every platform at once. Reporting it under a single-platform selection
     * would print an account-wide number beside a "Facebook" heading — the exact
     * kind of quietly wrong figure a client would act on.
     */
    const group = await prisma.postGroup.create({
      data: {
        organizationId: alpha.organizationId,
        clientId: alpha.clientId,
        name: 'scoping fixture',
        status: 'PUBLISHED',
      },
    });

    for (const [platform, engagements] of [['FACEBOOK', 200], ['INSTAGRAM', 800]] as const) {
      await prisma.platformPost.create({
        data: {
          postGroupId: group.id,
          platform,
          caption: 'seeded',
          status: 'PUBLISHED',
          publishedAt: new Date('2026-01-10T12:00:00Z'),
          config: { metrics: { engagements } },
        },
      });
    }

    const only = async (platforms: string[]) => {
      const response = await alphaAdmin.post('/api/reports/builder/preview', {
        ...draft(alpha.clientId), platforms, metrics: ['engagements', 'saves'],
      });
      expect(response.status).toBe(200);
      return response.body.data.totals as Array<{ metric: string; value: number | null; state: string }>;
    };

    const facebook = await only(['FACEBOOK']);
    const instagram = await only(['INSTAGRAM']);
    const both = await only([]);

    expect(facebook.find((m) => m.metric === 'engagements')?.value).toBe(200);
    expect(instagram.find((m) => m.metric === 'engagements')?.value).toBe(800);
    expect(both.find((m) => m.metric === 'engagements')?.value).toBe(1000);

    // And the state rule holds through the API: Facebook has no saves metric,
    // so it is Unavailable rather than the 0 the sum would otherwise give.
    const saves = facebook.find((m) => m.metric === 'saves');
    expect(saves?.state).toBe('UNAVAILABLE');
    expect(saves?.value).toBeNull();
  });

  // -------------------------------------------------------------- boundary

  it('refuses to build a report over another organisation\'s client', async () => {
    // The id is real and named directly; only the scoping check stands between
    // beta's numbers and a report on alpha's letterhead.
    const response = await alphaAdmin.post('/api/reports/builder', draft(beta.clientId));
    expect(response.status).toBe(404);
  });

  it('refuses to preview another organisation\'s client', async () => {
    const response = await alphaAdmin.post('/api/reports/builder/preview', draft(beta.clientId));
    expect(response.status).toBe(404);
  });

  it('hides another organisation\'s report from read, render, edit and duplicate', async () => {
    const betaReport = await betaAdmin.post('/api/reports/builder', draft(beta.clientId));
    const id = betaReport.body.report.id;

    expect((await alphaAdmin.get(`/api/reports/builder/${id}/data`)).status).toBe(404);
    expect((await alphaAdmin.patch(`/api/reports/builder/${id}`, { title: 'Stolen' })).status).toBe(404);
    expect((await alphaAdmin.post(`/api/reports/builder/${id}/duplicate`, {})).status).toBe(404);
    expect((await alphaAdmin.delete(`/api/reports/${id}`)).status).toBe(404);

    // And it is genuinely untouched.
    const still = await prisma.report.findUnique({ where: { id } });
    expect(still?.title).toBe('Monthly performance');
  });

  it('does not let a client-portal user create or edit reports', async () => {
    // Portal users read their own reports; building them is agency work.
    const created = await alphaClientUser.post('/api/reports/builder', draft(alpha.clientId));
    expect(created.status).toBe(403);
  });

  it('lets an agency admin delete its own report', async () => {
    const created = await alphaAdmin.post('/api/reports/builder', draft(alpha.clientId));
    const id = created.body.report.id;

    expect((await alphaAdmin.delete(`/api/reports/${id}`)).status).toBe(200);
    expect(await prisma.report.findUnique({ where: { id } })).toBeNull();
  });
});

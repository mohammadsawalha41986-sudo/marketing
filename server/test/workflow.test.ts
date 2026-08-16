/** CRUD, the approval workflow, scheduling, reports and uploads. */

import { beforeEach, describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';

import { Agent, agent, createTenant, prisma, resetDatabase, seedPlan, type Tenant } from './helpers.js';

/** Smallest valid 1×1 PNG, built rather than pasted so it is inspectable. */
function tinyPng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crcTable = Array.from({ length: 256 }, (_, n) => {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
    let crc = 0xffffffff;
    for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, crcBuf]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // truecolour
  const idat = deflateSync(Buffer.from([0x00, 0xff, 0x64, 0x32]));

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('client and campaign CRUD', () => {
  let tenant: Tenant;
  let admin: Agent;

  beforeEach(async () => {
    await resetDatabase();
    tenant = await createTenant('crud');
    admin = agent();
    await admin.login(tenant.adminEmail);
  });

  it('creates a client with a brand attached automatically', async () => {
    const response = await admin.post('/api/clients', {
      name: 'Falafel House', businessName: 'Falafel House LLC', businessType: 'Restaurant',
    });

    expect(response.status).toBe(201);
    expect(response.body.client.brand).toBeTruthy();
    expect(response.body.client.brand.businessName).toBe('Falafel House LLC');
  });

  it('updates and deletes a client', async () => {
    const created = await admin.post('/api/clients', { name: 'Temp', businessName: 'Temp Ltd' });
    const id = created.body.client.id as string;

    const updated = await admin.patch(`/api/clients/${id}`, { industry: 'Hospitality' });
    expect(updated.status).toBe(200);
    expect(updated.body.client.industry).toBe('Hospitality');

    expect((await admin.delete(`/api/clients/${id}`)).status).toBe(200);
    expect(await prisma.client.findUnique({ where: { id } })).toBeNull();
  });

  it('rejects a campaign whose end date precedes its start', async () => {
    const response = await admin.post('/api/campaigns', {
      clientId: tenant.clientId,
      name: 'Backwards',
      budget: 500,
      startDate: '2026-06-01',
      endDate: '2026-05-01',
      platforms: [{ platform: 'INSTAGRAM', budget: 500 }],
    });
    expect(response.status).toBe(400);
  });

  it('requires at least one platform on a campaign', async () => {
    const response = await admin.post('/api/campaigns', {
      clientId: tenant.clientId, name: 'No platforms', budget: 500,
      startDate: '2026-06-01', endDate: '2026-07-01', platforms: [],
    });
    expect(response.status).toBe(400);
  });

  it('replaces the platform mix on update', async () => {
    const response = await admin.patch(`/api/campaigns/${tenant.campaignId}`, {
      platforms: [{ platform: 'TIKTOK', budget: 400 }, { platform: 'FACEBOOK', budget: 600 }],
    });
    expect(response.status).toBe(200);
    expect(response.body.campaign.platforms.map((p: { platform: string }) => p.platform).sort())
      .toEqual(['FACEBOOK', 'TIKTOK']);
  });

  it('serialises decimal money columns as numbers', async () => {
    const response = await admin.get(`/api/campaigns/${tenant.campaignId}`);
    expect(typeof response.body.campaign.budget).toBe('number');
    expect(typeof response.body.campaign.spend).toBe('number');
  });
});

describe('approval workflow and scheduling', () => {
  let tenant: Tenant;
  let admin: Agent;
  let clientAdmin: Agent;

  beforeEach(async () => {
    await resetDatabase();
    tenant = await createTenant('flow');
    admin = agent();
    await admin.login(tenant.adminEmail);
    clientAdmin = agent();
    await clientAdmin.login(tenant.clientAdminEmail);
  });

  it('refuses to schedule content that has not been approved', async () => {
    const response = await admin.post(`/api/content/${tenant.contentId}/schedule`, {
      scheduledAt: new Date(Date.now() + 86400000).toISOString(),
    });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/approved/i);
  });

  it('runs draft → submitted → approved → scheduled, creating a calendar entry', async () => {
    const submitted = await admin.post(`/api/content/${tenant.contentId}/submit`);
    expect(submitted.status).toBe(200);
    expect(submitted.body.content.status).toBe('SUBMITTED');

    const pending = await clientAdmin.get('/api/approvals?status=PENDING');
    expect(pending.body.items).toHaveLength(1);
    const approvalId = pending.body.items[0].id as string;

    const decided = await clientAdmin.post(`/api/approvals/${approvalId}/decision`, {
      status: 'APPROVED',
      note: 'Looks right.',
    });
    expect(decided.status).toBe(200);

    const content = await prisma.content.findUnique({ where: { id: tenant.contentId } });
    expect(content?.status).toBe('APPROVED');

    const when = new Date(Date.now() + 3 * 86400000).toISOString();
    const scheduled = await admin.post(`/api/content/${tenant.contentId}/schedule`, { scheduledAt: when });
    expect(scheduled.status).toBe(200);
    expect(scheduled.body.content.status).toBe('SCHEDULED');

    const event = await prisma.calendarEvent.findUnique({ where: { contentId: tenant.contentId } });
    expect(event).not.toBeNull();
  });

  it('records a rejection with its note and sets the content back', async () => {
    await admin.post(`/api/content/${tenant.contentId}/submit`);
    const pending = await clientAdmin.get('/api/approvals?status=PENDING');
    const approvalId = pending.body.items[0].id as string;

    await clientAdmin.post(`/api/approvals/${approvalId}/decision`, {
      status: 'CHANGES_REQUESTED',
      note: 'Please soften the headline.',
    });

    const content = await prisma.content.findUnique({
      where: { id: tenant.contentId },
      include: { comments: true },
    });
    expect(content?.status).toBe('CHANGES_REQUESTED');
    expect(content?.comments[0]?.body).toBe('Please soften the headline.');
  });

  it('notifies the agency when a decision is made', async () => {
    await admin.post(`/api/content/${tenant.contentId}/submit`);
    const pending = await clientAdmin.get('/api/approvals?status=PENDING');
    await clientAdmin.post(`/api/approvals/${pending.body.items[0].id}/decision`, { status: 'APPROVED' });

    const notifications = await admin.get('/api/notifications');
    const titles = notifications.body.items.map((row: { title: string }) => row.title);
    expect(titles.some((title: string) => /approved/i.test(title))).toBe(true);
  });

  it('shows scheduled content on the calendar and reschedules it', async () => {
    await prisma.content.update({ where: { id: tenant.contentId }, data: { status: 'APPROVED' } });
    const when = new Date(Date.now() + 2 * 86400000).toISOString();
    await admin.post(`/api/content/${tenant.contentId}/schedule`, { scheduledAt: when });

    const calendar = await admin.get('/api/calendar?view=month');
    expect(calendar.status).toBe(200);
    expect(calendar.body.items.some((row: { id: string }) => row.id === tenant.contentId)).toBe(true);

    const moved = new Date(Date.now() + 5 * 86400000).toISOString();
    const response = await admin.patch(`/api/calendar/${tenant.contentId}/reschedule`, { scheduledAt: moved });
    expect(response.status).toBe(200);

    const event = await prisma.calendarEvent.findUnique({ where: { contentId: tenant.contentId } });
    expect(event?.startAt.toISOString()).toBe(moved);
  });

  it('will not reschedule content that has already published', async () => {
    await prisma.content.update({ where: { id: tenant.contentId }, data: { status: 'PUBLISHED' } });
    const response = await admin.patch(`/api/calendar/${tenant.contentId}/reschedule`, {
      scheduledAt: new Date(Date.now() + 86400000).toISOString(),
    });
    expect(response.status).toBe(400);
  });
});

describe('analytics and reports', () => {
  let tenant: Tenant;
  let admin: Agent;

  beforeEach(async () => {
    await resetDatabase();
    tenant = await createTenant('reportco');
    admin = agent();
    await admin.login(tenant.adminEmail);
  });

  it('computes dashboard totals from stored snapshots', async () => {
    const response = await admin.get('/api/analytics/dashboard');
    expect(response.status).toBe(200);
    // 5 seeded days: spend 100..104, clicks 200..204.
    expect(response.body.kpis.spend).toBeCloseTo(510, 2);
    expect(response.body.kpis.clicks).toBe(1010);
    expect(response.body.kpis.ctr).toBeGreaterThan(0);
    expect(Number.isFinite(response.body.kpis.roas)).toBe(true);
  });

  it('generates a report with frozen figures and AI insights', async () => {
    const response = await admin.post('/api/reports/generate', {
      clientId: tenant.clientId,
      type: 'MONTHLY',
      includeAi: true,
    });

    expect(response.status).toBe(201);
    const report = await prisma.report.findUnique({ where: { id: response.body.report.id } });
    const payload = report?.payload as Record<string, unknown>;

    expect(payload.totals).toBeTruthy();
    expect(payload.analysis).toBeTruthy();
    // No API key in tests, so the rule-based analyst must have produced it.
    expect((payload.aiMeta as { isFallback: boolean }).isFallback).toBe(true);
  });

  it('exports a report as self-contained HTML and as Markdown', async () => {
    const created = await admin.post('/api/reports/generate', { clientId: tenant.clientId });
    const id = created.body.report.id as string;

    const html = await admin.get(`/api/reports/${id}/export?format=html`);
    expect(html.status).toBe(200);
    expect(html.text).toMatch(/^<!doctype html>/i);
    expect(html.text).not.toMatch(/<script/i);

    const markdown = await admin.get(`/api/reports/${id}/export?format=md`);
    expect(markdown.status).toBe(200);
    expect(markdown.text).toMatch(/^# /);
  });

  it('produces analysis that quotes only measured figures', async () => {
    const response = await admin.post('/api/analytics/analyze', { clientId: tenant.clientId });
    expect(response.status).toBe(200);
    expect(response.body.analysis.summary).toBeTruthy();
    expect(Array.isArray(response.body.analysis.recommendations)).toBe(true);
    expect(response.body.meta.disclaimer).toMatch(/recommendations/i);
    // The measured spend must appear in the facts handed back to the caller.
    expect(response.body.facts.totals.spend).toBeCloseTo(510, 2);
  });
});

describe('AI content generation', () => {
  let tenant: Tenant;
  let admin: Agent;

  beforeEach(async () => {
    await resetDatabase();
    tenant = await createTenant('aico');
    admin = agent();
    await admin.login(tenant.adminEmail);
  });

  it('generates copy from Brand DNA without writing to the database', async () => {
    const before = await prisma.content.count();

    const response = await admin.post('/api/content/generate', {
      clientId: tenant.clientId,
      platform: 'INSTAGRAM',
      language: 'EN',
    });

    expect(response.status).toBe(200);
    expect(response.body.generated.headline).toBeTruthy();
    expect(response.body.generated.caption).toBeTruthy();
    expect(response.body.meta.isFallback).toBe(true);
    // Generation is a pure read: the user saves it explicitly afterwards.
    expect(await prisma.content.count()).toBe(before);
  });

  it('writes Arabic when Arabic is requested', async () => {
    const response = await admin.post('/api/content/generate', {
      clientId: tenant.clientId, platform: 'INSTAGRAM', language: 'AR',
    });
    expect(response.status).toBe(200);
    expect(response.body.generated.caption).toMatch(/[؀-ۿ]/);
  });

  it('strips brand-forbidden words from generated copy', async () => {
    await prisma.brand.update({
      where: { clientId: tenant.clientId },
      data: { forbiddenWords: ['Mezze'], products: ['Mezze platter'] },
    });

    const response = await admin.post('/api/content/generate', {
      clientId: tenant.clientId, platform: 'INSTAGRAM', language: 'EN', productService: 'Mezze platter',
    });

    const copy = response.body.generated;
    const combined = [copy.headline, copy.caption, copy.primaryText, copy.slogan].join(' ');
    expect(combined.toLowerCase()).not.toContain('mezze');
  });

  it('generates hashtags and respects the platform limit', async () => {
    const response = await admin.post('/api/content/hashtags', {
      clientId: tenant.clientId, platform: 'TIKTOK', language: 'EN',
    });
    expect(response.status).toBe(200);
    expect(response.body.hashtags.length).toBeGreaterThan(0);
    expect(response.body.hashtags.length).toBeLessThanOrEqual(8);
    for (const tag of response.body.hashtags) expect(tag.startsWith('#')).toBe(true);
  });

  it('returns no hashtags for Google Ads', async () => {
    const response = await admin.post('/api/content/hashtags', {
      clientId: tenant.clientId, platform: 'GOOGLE_ADS', language: 'EN',
    });
    expect(response.body.hashtags).toEqual([]);
  });

  it('records AI usage for billing and admin visibility', async () => {
    await admin.post('/api/content/generate', { clientId: tenant.clientId, platform: 'INSTAGRAM' });
    const usage = await prisma.aiUsage.findFirst({ where: { clientId: tenant.clientId } });
    expect(usage?.kind).toBe('CONTENT');
    expect(usage?.provider).toBe('template');
  });
});

describe('uploads and brand identity', () => {
  let tenant: Tenant;
  let admin: Agent;

  beforeEach(async () => {
    await resetDatabase();
    tenant = await createTenant('uploadco');
    admin = agent();
    await admin.login(tenant.adminEmail);
  });

  it('accepts a real PNG logo and suggests a palette without applying it', async () => {
    const response = await admin
      .post(`/api/brands/${tenant.clientId}/logo`)
      .attach('file', tinyPng(), { filename: 'logo.png', contentType: 'image/png' });

    expect(response.status).toBe(201);
    expect(response.body.suggested.primary).toMatch(/^#[0-9A-F]{6}$/);
    expect(response.body.suggested.contrast).toBeGreaterThan(0);

    const brand = await prisma.brand.findUnique({ where: { clientId: tenant.clientId } });
    expect(brand?.logoUrl).toBeTruthy();
    // Suggestion only: the live colours stay untouched until approval.
    expect(brand?.paletteApproved).toBe(false);
    expect(brand?.suggestedPalette).toBeTruthy();
  });

  it('applies the palette only when it is approved', async () => {
    const response = await admin.post(`/api/brands/${tenant.clientId}/palette`, {
      primaryColor: '#123456',
      secondaryColor: '#654321',
      accentColor: '#ABCDEF',
      backgroundColor: '#0B0F1A',
    });

    expect(response.status).toBe(200);
    const brand = await prisma.brand.findUnique({ where: { clientId: tenant.clientId } });
    expect(brand?.primaryColor).toBe('#123456');
    expect(brand?.paletteApproved).toBe(true);
    // Text colour is derived for contrast when the caller does not supply one.
    expect(brand?.textColor).toBeTruthy();
  });

  it('rejects an invalid colour', async () => {
    const response = await admin.post(`/api/brands/${tenant.clientId}/palette`, {
      primaryColor: 'red',
      secondaryColor: '#654321',
      accentColor: '#ABCDEF',
      backgroundColor: '#0B0F1A',
    });
    expect(response.status).toBe(400);
  });

  it('rejects a file whose bytes are not an image', async () => {
    const response = await admin
      .post(`/api/brands/${tenant.clientId}/logo`)
      .attach('file', Buffer.from('this is not a png'), { filename: 'fake.png', contentType: 'image/png' });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/not a readable image/i);
  });

  it('rejects SVG uploads, which can carry script', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const response = await admin
      .post('/api/media')
      .attach('files', svg, { filename: 'x.svg', contentType: 'image/svg+xml' });

    expect(response.status).toBe(400);
    expect(await prisma.media.count()).toBe(0);
  });

  it('stores an uploaded image in the media library with its dimensions', async () => {
    const response = await admin
      .post('/api/media')
      .field('clientId', tenant.clientId)
      .attach('files', tinyPng(), { filename: 'shot.png', contentType: 'image/png' });

    expect(response.status).toBe(201);
    expect(response.body.items[0].type).toBe('IMAGE');
    expect(response.body.items[0].width).toBe(1);
    expect(response.body.items[0].url).toMatch(/^\/uploads\//);
  });
});

describe('subscriptions', () => {
  it('reports usage against the plan limits', async () => {
    await resetDatabase();
    const tenant = await createTenant('subsco');
    const plan = await seedPlan();
    await prisma.subscription.create({
      data: {
        organizationId: tenant.organizationId,
        planId: plan.id,
        status: 'ACTIVE',
        renewalDate: new Date(Date.now() + 30 * 86400000),
      },
    });

    const admin = agent();
    await admin.login(tenant.adminEmail);
    const response = await admin.get('/api/subscriptions/usage');

    expect(response.status).toBe(200);
    expect(response.body.plan.name).toBe('Test plan');
    expect(response.body.usage.clients).toBe(1);
    expect(response.body.limits.clients).toBe(5);
    // No payment provider is wired up, and the API says so plainly.
    expect(response.body.billing.status).toBe('not_configured');
  });
});

describe('integrations', () => {
  it('refuses to connect and explains exactly what is missing', async () => {
    await resetDatabase();
    const tenant = await createTenant('intco');
    const admin = agent();
    await admin.login(tenant.adminEmail);

    const response = await admin.post(`/api/integrations/${tenant.clientId}/INSTAGRAM/connect`);

    // 503, not 501: a missing credential is a configuration gap with a known
    // fix, and the response names the variables so the operator can act on it
    // rather than being told the feature does not exist.
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('PROVIDER_NOT_CONFIGURED');
    expect(response.body.error.details.missingEnv).toContain('META_APP_ID');
    expect(response.body.error.details.readiness).toBe('NOT_CONFIGURED');
    expect(response.body.error.message).not.toMatch(/not implemented/i);

    // The row exists and is honestly marked disconnected.
    const integration = await prisma.integration.findFirst({ where: { clientId: tenant.clientId } });
    expect(integration?.status).toBe('DISCONNECTED');
  });
});

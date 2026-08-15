/** CRUD, the content pipeline, ads, tasks, reports and uploads. */

import { beforeEach, describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';

import {
  Agent, agent, createOwner, createRestaurant, prisma, resetDatabase,
  type RestaurantFixture,
} from './helpers.js';

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

/** Signs in the owner and builds one restaurant with everything attached. */
async function setup(slug: string): Promise<{ admin: Agent; fixture: RestaurantFixture }> {
  await resetDatabase();
  const owner = await createOwner();
  const admin = agent();
  await admin.login(owner.email);
  return { admin, fixture: await createRestaurant(slug) };
}

describe('restaurant and campaign CRUD', () => {
  let fixture: RestaurantFixture;
  let admin: Agent;

  beforeEach(async () => {
    ({ admin, fixture } = await setup('crud'));
  });

  it('updates and deletes a restaurant', async () => {
    const created = await admin.post('/api/restaurants', { name: 'Temp', businessName: 'Temp Ltd' });
    const id = created.body.restaurant.id as string;

    const updated = await admin.patch(`/api/restaurants/${id}`, {
      cuisine: 'Seafood',
      branches: ['Olaya', 'Al Malqa'],
      marketingObjectives: ['Grow weekend covers'],
    });
    expect(updated.status).toBe(200);
    expect(updated.body.restaurant.cuisine).toBe('Seafood');
    expect(updated.body.restaurant.branches).toEqual(['Olaya', 'Al Malqa']);

    expect((await admin.delete(`/api/restaurants/${id}`)).status).toBe(200);
    expect(await prisma.restaurant.findUnique({ where: { id } })).toBeNull();
  });

  it('rejects a campaign whose end date precedes its start', async () => {
    const response = await admin.post('/api/campaigns', {
      restaurantId: fixture.restaurantId,
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
      restaurantId: fixture.restaurantId, name: 'No platforms', budget: 500,
      startDate: '2026-06-01', endDate: '2026-07-01', platforms: [],
    });
    expect(response.status).toBe(400);
  });

  it('replaces the platform mix on update', async () => {
    const response = await admin.patch(`/api/campaigns/${fixture.campaignId}`, {
      platforms: [{ platform: 'TIKTOK', budget: 400 }, { platform: 'FACEBOOK', budget: 600 }],
    });
    expect(response.status).toBe(200);
    expect(response.body.campaign.platforms.map((p: { platform: string }) => p.platform).sort())
      .toEqual(['FACEBOOK', 'TIKTOK']);
  });

  it('defaults a campaign to the workspace currency', async () => {
    const response = await admin.post('/api/campaigns', {
      restaurantId: fixture.restaurantId, name: 'Currency check', budget: 1000,
      startDate: '2026-06-01', endDate: '2026-07-01',
      platforms: [{ platform: 'INSTAGRAM', budget: 1000 }],
    });
    expect(response.status).toBe(201);
    expect(response.body.campaign.currency).toBe('SAR');
  });

  it('serialises decimal money columns as numbers', async () => {
    const response = await admin.get(`/api/campaigns/${fixture.campaignId}`);
    expect(typeof response.body.campaign.budget).toBe('number');
    expect(typeof response.body.campaign.spend).toBe('number');
  });
});

describe('content pipeline and scheduling', () => {
  let fixture: RestaurantFixture;
  let admin: Agent;

  beforeEach(async () => {
    ({ admin, fixture } = await setup('flow'));
  });

  /*
   * The approval gate is gone with the client portal. Content used to require a
   * client's sign-off before it could be scheduled; the operator now both makes
   * and ships the work, so a draft schedules directly.
   */
  it('schedules a draft directly, with no approval step', async () => {
    const when = new Date(Date.now() + 3 * 86400000).toISOString();
    const response = await admin.post(`/api/content/${fixture.contentId}/schedule`, { scheduledAt: when });

    expect(response.status).toBe(200);
    expect(response.body.content.status).toBe('SCHEDULED');

    const event = await prisma.calendarEvent.findUnique({ where: { contentId: fixture.contentId } });
    expect(event).not.toBeNull();
    expect(event?.restaurantId).toBe(fixture.restaurantId);
  });

  it('moves through the pipeline by setting status directly', async () => {
    for (const status of ['IDEA', 'DRAFT', 'READY', 'ARCHIVED'] as const) {
      const response = await admin.patch(`/api/content/${fixture.contentId}`, { status });
      expect(response.status, status).toBe(200);
      expect(response.body.content.status).toBe(status);
    }
  });

  it('stamps publishedAt when content is marked published', async () => {
    const response = await admin.post(`/api/content/${fixture.contentId}/publish`);
    expect(response.status).toBe(200);
    expect(response.body.content.status).toBe('PUBLISHED');

    const content = await prisma.content.findUnique({ where: { id: fixture.contentId } });
    expect(content?.publishedAt).toBeInstanceOf(Date);

    // Publishing twice is a mistake, not an idempotent no-op: the second call
    // would move the timestamp and quietly change what the reports say.
    expect((await admin.post(`/api/content/${fixture.contentId}/publish`)).status).toBe(400);
  });

  it('will not reschedule content that has already published', async () => {
    await admin.post(`/api/content/${fixture.contentId}/publish`);

    const later = new Date(Date.now() + 86400000).toISOString();
    expect((await admin.post(`/api/content/${fixture.contentId}/schedule`, { scheduledAt: later })).status).toBe(400);
    expect((await admin.patch(`/api/calendar/${fixture.contentId}/reschedule`, { scheduledAt: later })).status).toBe(400);
  });

  it('shows scheduled content on the calendar and reschedules it', async () => {
    const when = new Date(Date.now() + 2 * 86400000).toISOString();
    await admin.post(`/api/content/${fixture.contentId}/schedule`, { scheduledAt: when });

    const calendar = await admin.get('/api/calendar?view=month');
    expect(calendar.status).toBe(200);
    expect(calendar.body.items.some((row: { id: string }) => row.id === fixture.contentId)).toBe(true);

    const moved = new Date(Date.now() + 5 * 86400000).toISOString();
    expect((await admin.patch(`/api/calendar/${fixture.contentId}/reschedule`, { scheduledAt: moved })).status).toBe(200);

    const event = await prisma.calendarEvent.findUnique({ where: { contentId: fixture.contentId } });
    expect(event?.startAt.toISOString()).toBe(moved);
  });

  it('filters the calendar by restaurant, platform and type', async () => {
    const other = await createRestaurant('othercal');
    const when = new Date(Date.now() + 86400000).toISOString();
    await admin.post(`/api/content/${fixture.contentId}/schedule`, { scheduledAt: when });
    await admin.post(`/api/content/${other.contentId}/schedule`, { scheduledAt: when });

    const all = await admin.get('/api/calendar?view=month');
    expect(all.body.items.length).toBe(2);

    const scoped = await admin.get(`/api/calendar?view=month&restaurantId=${fixture.restaurantId}`);
    expect(scoped.body.items.length).toBe(1);
    expect(scoped.body.items[0].restaurant.id).toBe(fixture.restaurantId);

    expect((await admin.get('/api/calendar?view=month&platform=TIKTOK')).body.items.length).toBe(0);
    expect((await admin.get('/api/calendar?view=month&type=POST')).body.items.length).toBe(2);
  });

  it('drops the calendar entry when a schedule is cleared', async () => {
    await admin.post(`/api/content/${fixture.contentId}/schedule`, {
      scheduledAt: new Date(Date.now() + 86400000).toISOString(),
    });
    expect(await prisma.calendarEvent.count({ where: { contentId: fixture.contentId } })).toBe(1);

    await admin.patch(`/api/content/${fixture.contentId}`, { scheduledAt: null });
    expect(await prisma.calendarEvent.count({ where: { contentId: fixture.contentId } })).toBe(0);
  });
});

describe('ads', () => {
  let fixture: RestaurantFixture;
  let admin: Agent;

  beforeEach(async () => {
    ({ admin, fixture } = await setup('adco'));
  });

  it('reports an ad with no figures as not recorded, rather than as zeroes', async () => {
    const response = await admin.get(`/api/ads/${fixture.adId}`);

    expect(response.status).toBe(200);
    expect(response.body.ad.metricsRecorded).toBe(false);
    expect(response.body.ad.metricsAt).toBeNull();
    // The figures are zero, but the flag above is what the UI reads — otherwise
    // "we spent nothing" and "we have not entered it yet" look identical.
    expect(response.body.ad.spend).toBe(0);
  });

  it('records figures and derives every rate from them', async () => {
    const response = await admin.post(`/api/ads/${fixture.adId}/metrics`, {
      spend: 500,
      revenue: 2000,
      impressions: 100000,
      reach: 60000,
      clicks: 2500,
      leads: 100,
      conversions: 50,
    });

    expect(response.status).toBe(200);
    expect(response.body.ad.metricsRecorded).toBe(true);
    expect(response.body.ad.metrics.ctr).toBeCloseTo(0.025, 5);
    expect(response.body.ad.metrics.cpc).toBeCloseTo(0.2, 5);
    expect(response.body.ad.metrics.roas).toBeCloseTo(4, 5);
    expect(response.body.ad.metrics.costPerLead).toBeCloseTo(5, 5);
  });

  it('recomputes the rates when a figure is corrected', async () => {
    await admin.post(`/api/ads/${fixture.adId}/metrics`, {
      spend: 500, revenue: 2000, impressions: 100000, reach: 60000, clicks: 2500, leads: 100, conversions: 50,
    });

    // Halving revenue must halve ROAS. A stored rate would not have moved.
    const corrected = await admin.post(`/api/ads/${fixture.adId}/metrics`, {
      spend: 500, revenue: 1000, impressions: 100000, reach: 60000, clicks: 2500, leads: 100, conversions: 50,
    });
    expect(corrected.body.ad.metrics.roas).toBeCloseTo(2, 5);
  });

  it('rejects negative figures', async () => {
    const response = await admin.post(`/api/ads/${fixture.adId}/metrics`, {
      spend: -100, revenue: 0, impressions: 0, reach: 0, clicks: 0, leads: 0, conversions: 0,
    });
    expect(response.status).toBe(400);
  });

  it('surfaces ads on the campaign it belongs to', async () => {
    const response = await admin.get(`/api/campaigns/${fixture.campaignId}`);
    expect(response.status).toBe(200);
    expect(response.body.campaign.ads).toHaveLength(1);
    expect(response.body.campaign.ads[0].id).toBe(fixture.adId);
  });

  it('counts active ads with no figures as something needing attention', async () => {
    await prisma.ad.update({ where: { id: fixture.adId }, data: { status: 'ACTIVE' } });

    const response = await admin.get('/api/analytics/dashboard');
    const titles = response.body.alerts.map((alert: { title: string }) => alert.title);
    expect(titles.some((title: string) => /no figures recorded/i.test(title))).toBe(true);
  });
});

describe('tasks', () => {
  let fixture: RestaurantFixture;
  let admin: Agent;

  beforeEach(async () => {
    ({ admin, fixture } = await setup('taskco'));
  });

  it('creates a task against a restaurant and completes it', async () => {
    const created = await admin.post('/api/tasks', {
      title: 'Send the August report',
      restaurantId: fixture.restaurantId,
      priority: 'HIGH',
      dueAt: new Date(Date.now() + 86400000).toISOString(),
    });
    expect(created.status).toBe(201);
    expect(created.body.task.restaurant.id).toBe(fixture.restaurantId);

    const done = await admin.patch(`/api/tasks/${created.body.task.id}`, { status: 'DONE' });
    expect(done.status).toBe(200);
    // completedAt tracks status, so "when was this finished" stays answerable.
    expect(done.body.task.completedAt).not.toBeNull();

    const reopened = await admin.patch(`/api/tasks/${created.body.task.id}`, { status: 'TODO' });
    expect(reopened.body.task.completedAt).toBeNull();
  });

  it('allows a task with no restaurant, for general workspace work', async () => {
    const response = await admin.post('/api/tasks', { title: 'Renew the Canva subscription' });
    expect(response.status).toBe(201);
    expect(response.body.task.restaurant).toBeNull();
  });

  it('counts overdue tasks and raises an alert for them', async () => {
    await admin.post('/api/tasks', {
      title: 'Overdue thing',
      restaurantId: fixture.restaurantId,
      dueAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    });

    const tasks = await admin.get('/api/tasks');
    expect(tasks.body.summary.overdue).toBe(1);

    const dashboard = await admin.get('/api/analytics/dashboard');
    const titles = dashboard.body.alerts.map((alert: { title: string }) => alert.title);
    expect(titles.some((title: string) => /overdue/i.test(title))).toBe(true);
  });

  it('refuses a campaign belonging to a different restaurant', async () => {
    const other = await createRestaurant('othertask');
    const response = await admin.post('/api/tasks', {
      title: 'Mismatched',
      restaurantId: fixture.restaurantId,
      campaignId: other.campaignId,
    });
    expect(response.status).toBe(404);
  });
});

describe('analytics and reports', () => {
  let fixture: RestaurantFixture;
  let admin: Agent;

  beforeEach(async () => {
    ({ admin, fixture } = await setup('reportco'));
  });

  it('computes dashboard totals from stored snapshots', async () => {
    const response = await admin.get('/api/analytics/dashboard');
    expect(response.status).toBe(200);
    // 5 seeded days: spend 100..104, clicks 200..204, leads 20..24.
    expect(response.body.kpis.spend).toBeCloseTo(510, 2);
    expect(response.body.kpis.clicks).toBe(1010);
    expect(response.body.kpis.leads).toBe(110);
    expect(response.body.kpis.ctr).toBeGreaterThan(0);
    expect(Number.isFinite(response.body.kpis.roas)).toBe(true);
  });

  it('names the best performing restaurant by measured revenue', async () => {
    const response = await admin.get('/api/analytics/dashboard');
    expect(response.body.best.restaurant.id).toBe(fixture.restaurantId);
    expect(response.body.best.restaurant.revenue).toBeGreaterThan(0);
  });

  it('generates a report with frozen figures and AI insights', async () => {
    const response = await admin.post('/api/reports/generate', {
      restaurantId: fixture.restaurantId,
      type: 'MONTHLY',
      includeAi: true,
    });

    expect(response.status).toBe(201);
    const report = await prisma.report.findUnique({ where: { id: response.body.report.id } });
    const payload = report?.payload as Record<string, unknown>;

    expect(payload.totals).toBeTruthy();
    expect(payload.analysis).toBeTruthy();
    // Currency is frozen in, so the report keeps it if the setting later changes.
    expect(payload.currency).toBe('SAR');
    // No API key in tests, so the rule-based analyst must have produced it.
    expect((payload.aiMeta as { isFallback: boolean }).isFallback).toBe(true);
  });

  it('exports a report as self-contained HTML and as Markdown', async () => {
    const created = await admin.post('/api/reports/generate', { restaurantId: fixture.restaurantId });
    const id = created.body.report.id as string;

    const html = await admin.get(`/api/reports/${id}/export?format=html`);
    expect(html.status).toBe(200);
    expect(html.text).toMatch(/^<!doctype html>/i);
    expect(html.text).not.toMatch(/<script/i);
    expect(html.text).toContain('SAR');

    const markdown = await admin.get(`/api/reports/${id}/export?format=md`);
    expect(markdown.status).toBe(200);
    expect(markdown.text).toMatch(/^# /);
  });

  it('marks an unmeasured ad as not recorded in the exported report', async () => {
    const created = await admin.post('/api/reports/generate', { restaurantId: fixture.restaurantId });
    // The fixture ad is DRAFT, so make it one the report includes.
    await prisma.ad.update({ where: { id: fixture.adId }, data: { status: 'ACTIVE' } });

    const regenerated = await admin.post('/api/reports/generate', { restaurantId: fixture.restaurantId });
    const markdown = await admin.get(`/api/reports/${regenerated.body.report.id}/export?format=md`);

    expect(created.status).toBe(201);
    expect(markdown.text).toMatch(/not recorded/i);
  });

  it('produces analysis that quotes only measured figures', async () => {
    const response = await admin.post('/api/analytics/analyze', { restaurantId: fixture.restaurantId });
    expect(response.status).toBe(200);
    expect(response.body.analysis.summary).toBeTruthy();
    expect(Array.isArray(response.body.analysis.recommendations)).toBe(true);
    expect(response.body.meta.disclaimer).toMatch(/recommendations/i);
    // The measured spend must appear in the facts handed back to the caller.
    expect(response.body.facts.totals.spend).toBeCloseTo(510, 2);
  });

  it('refuses to analyse a restaurant that does not exist', async () => {
    const response = await admin.post('/api/analytics/analyze', { restaurantId: 'nope' });
    expect(response.status).toBe(404);
  });
});

describe('AI content generation', () => {
  let fixture: RestaurantFixture;
  let admin: Agent;

  beforeEach(async () => {
    ({ admin, fixture } = await setup('aico'));
  });

  it('generates copy from the brand without writing to the database', async () => {
    const before = await prisma.content.count();

    const response = await admin.post('/api/content/generate', {
      restaurantId: fixture.restaurantId,
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
      restaurantId: fixture.restaurantId, platform: 'INSTAGRAM', language: 'AR',
    });
    expect(response.status).toBe(200);
    expect(response.body.generated.caption).toMatch(/[؀-ۿ]/);
  });

  it('uses only the named restaurant\'s brand, never another\'s', async () => {
    const other = await createRestaurant('rival');
    await prisma.brand.update({
      where: { restaurantId: other.restaurantId },
      data: { products: ['Rival signature burger'], usps: ['Rival exclusive recipe'] },
    });

    const response = await admin.post('/api/content/generate', {
      restaurantId: fixture.restaurantId, platform: 'INSTAGRAM', language: 'EN',
    });

    const copy = JSON.stringify(response.body.generated).toLowerCase();
    expect(copy).not.toContain('rival');
  });

  it('strips brand-forbidden words from generated copy', async () => {
    await prisma.brand.update({
      where: { restaurantId: fixture.restaurantId },
      data: { forbiddenWords: ['Mezze'], products: ['Mezze platter'] },
    });

    const response = await admin.post('/api/content/generate', {
      restaurantId: fixture.restaurantId, platform: 'INSTAGRAM', language: 'EN', productService: 'Mezze platter',
    });

    const copy = response.body.generated;
    const combined = [copy.headline, copy.caption, copy.primaryText, copy.slogan].join(' ');
    expect(combined.toLowerCase()).not.toContain('mezze');
  });

  it('generates hashtags and respects the platform limit', async () => {
    const response = await admin.post('/api/content/hashtags', {
      restaurantId: fixture.restaurantId, platform: 'TIKTOK', language: 'EN',
    });
    expect(response.status).toBe(200);
    expect(response.body.hashtags.length).toBeGreaterThan(0);
    expect(response.body.hashtags.length).toBeLessThanOrEqual(8);
    for (const tag of response.body.hashtags) expect(tag.startsWith('#')).toBe(true);
  });

  it('returns no hashtags for Google Ads', async () => {
    const response = await admin.post('/api/content/hashtags', {
      restaurantId: fixture.restaurantId, platform: 'GOOGLE_ADS', language: 'EN',
    });
    expect(response.body.hashtags).toEqual([]);
  });

  it('records AI usage against the restaurant', async () => {
    await admin.post('/api/content/generate', { restaurantId: fixture.restaurantId, platform: 'INSTAGRAM' });
    const usage = await prisma.aiUsage.findFirst({ where: { restaurantId: fixture.restaurantId } });
    expect(usage?.kind).toBe('CONTENT');
    expect(usage?.provider).toBe('template');
  });
});

describe('uploads and brand identity', () => {
  let fixture: RestaurantFixture;
  let admin: Agent;

  beforeEach(async () => {
    ({ admin, fixture } = await setup('uploadco'));
  });

  it('accepts a real PNG logo and suggests a palette without applying it', async () => {
    const response = await admin
      .post(`/api/brands/${fixture.restaurantId}/logo`)
      .attach('file', tinyPng(), { filename: 'logo.png', contentType: 'image/png' });

    expect(response.status).toBe(201);
    expect(response.body.suggested.primary).toMatch(/^#[0-9A-F]{6}$/);
    expect(response.body.suggested.contrast).toBeGreaterThan(0);

    const brand = await prisma.brand.findUnique({ where: { restaurantId: fixture.restaurantId } });
    expect(brand?.logoUrl).toBeTruthy();
    // Suggestion only: the live colours stay untouched until approval.
    expect(brand?.paletteApproved).toBe(false);
    expect(brand?.suggestedPalette).toBeTruthy();

    // The logo also becomes the restaurant's avatar and a media-library row.
    const restaurant = await prisma.restaurant.findUnique({ where: { id: fixture.restaurantId } });
    expect(restaurant?.logoUrl).toBe(brand?.logoUrl);
    expect(await prisma.media.count({ where: { restaurantId: fixture.restaurantId, type: 'LOGO' } })).toBe(1);
  });

  it('applies the palette only when it is approved', async () => {
    const response = await admin.post(`/api/brands/${fixture.restaurantId}/palette`, {
      primaryColor: '#123456',
      secondaryColor: '#654321',
      accentColor: '#ABCDEF',
      backgroundColor: '#0B0F1A',
    });

    expect(response.status).toBe(200);
    const brand = await prisma.brand.findUnique({ where: { restaurantId: fixture.restaurantId } });
    expect(brand?.primaryColor).toBe('#123456');
    expect(brand?.paletteApproved).toBe(true);
    // Text colour is derived for contrast when the caller does not supply one.
    expect(brand?.textColor).toBeTruthy();
  });

  it('rejects an invalid colour', async () => {
    const response = await admin.post(`/api/brands/${fixture.restaurantId}/palette`, {
      primaryColor: 'red',
      secondaryColor: '#654321',
      accentColor: '#ABCDEF',
      backgroundColor: '#0B0F1A',
    });
    expect(response.status).toBe(400);
  });

  /*
   * A file can pass the magic-number check and still fail to decode — a
   * truncated PNG is the common case. Before this was handled, the decoder's
   * exception escaped as a 500 "Something went wrong", which tells the operator
   * nothing about the file they just chose.
   */
  it('rejects a corrupt image with a useful message, not a 500', async () => {
    // Valid PNG header and IHDR, deliberately broken pixel data.
    const corrupt = Buffer.concat([tinyPng().subarray(0, 33), Buffer.from('not pixel data')]);

    const response = await admin
      .post(`/api/brands/${fixture.restaurantId}/logo`)
      .attach('file', corrupt, { filename: 'broken.png', contentType: 'image/png' });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/corrupt|could not be read/i);

    // And nothing was stored on the way to failing.
    const brand = await prisma.brand.findUnique({ where: { restaurantId: fixture.restaurantId } });
    expect(brand?.logoUrl).toBeNull();
    expect(await prisma.media.count()).toBe(0);
  });

  it('rejects a corrupt image in the media library too', async () => {
    const corrupt = Buffer.concat([tinyPng().subarray(0, 33), Buffer.from('not pixel data')]);

    const response = await admin
      .post('/api/media')
      .attach('files', corrupt, { filename: 'broken.png', contentType: 'image/png' });

    expect(response.status).toBe(400);
    expect(await prisma.media.count()).toBe(0);
  });

  it('rejects a file whose bytes are not an image', async () => {
    const response = await admin
      .post(`/api/brands/${fixture.restaurantId}/logo`)
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

  it('stores an uploaded image against its restaurant, with dimensions', async () => {
    const response = await admin
      .post('/api/media')
      .field('restaurantId', fixture.restaurantId)
      .attach('files', tinyPng(), { filename: 'shot.png', contentType: 'image/png' });

    expect(response.status).toBe(201);
    expect(response.body.items[0].type).toBe('IMAGE');
    expect(response.body.items[0].width).toBe(1);
    expect(response.body.items[0].restaurantId).toBe(fixture.restaurantId);
    expect(response.body.items[0].url).toMatch(/^\/uploads\//);
  });
});

describe('workspace settings', () => {
  let admin: Agent;

  beforeEach(async () => {
    ({ admin } = await setup('settingsco'));
  });

  it('creates the workspace on first read, so a fresh database just works', async () => {
    expect(await prisma.workspace.count()).toBe(0);

    const response = await admin.get('/api/settings');
    expect(response.status).toBe(200);
    expect(response.body.workspace.currency).toBe('SAR');
    expect(response.body.workspace.timezone).toBe('Asia/Riyadh');
    expect(await prisma.workspace.count()).toBe(1);
  });

  it('updates the currency and keeps exactly one workspace row', async () => {
    const response = await admin.patch('/api/settings', { currency: 'AED', name: 'My Agency' });
    expect(response.status).toBe(200);
    expect(response.body.workspace.currency).toBe('AED');
    expect(await prisma.workspace.count()).toBe(1);

    // New campaigns pick the new currency up.
    const fixture = await createRestaurant('currencyco');
    const campaign = await admin.post('/api/campaigns', {
      restaurantId: fixture.restaurantId, name: 'After the change', budget: 100,
      startDate: '2026-06-01', endDate: '2026-07-01',
      platforms: [{ platform: 'INSTAGRAM', budget: 100 }],
    });
    expect(campaign.body.campaign.currency).toBe('AED');
  });

  it('rejects a currency that is not a three-letter code', async () => {
    expect((await admin.patch('/api/settings', { currency: 'riyal' })).status).toBe(400);
  });
});

describe('integrations', () => {
  it('refuses to connect and explains exactly what is missing', async () => {
    const { admin, fixture } = await setup('intco');

    const response = await admin.post(`/api/integrations/${fixture.restaurantId}/INSTAGRAM/connect`);

    expect(response.status).toBe(501);
    expect(response.body.error.code).toBe('ADAPTER_NOT_IMPLEMENTED');
    expect(response.body.error.details.requiredEnv).toContain('META_APP_ID');

    // The row exists and is honestly marked disconnected.
    const integration = await prisma.integration.findFirst({ where: { restaurantId: fixture.restaurantId } });
    expect(integration?.status).toBe('DISCONNECTED');
  });
});

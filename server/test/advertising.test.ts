/**
 * The Paid Advertising Command Center.
 *
 * Two things carry the weight here, and both are about not lying with numbers.
 *
 * The first is the four-state rule under a storage trap. `AnalyticsSnapshot`
 * declares every metric column `@default(0)`, so "nobody has fetched insights"
 * and "the campaign delivered nothing" are indistinguishable at the column
 * level. On a screen whose whole job is telling someone whether their money is
 * working, reporting the first as a measured zero is the worst available
 * outcome, so most of what follows checks that an unfetched campaign reports
 * NOT_FETCHED and a measured one reports its real figure.
 *
 * The second is status. Every adapter creates campaigns paused so nothing
 * spends unattended, and only Meta reads its status back. Calling a published
 * advertisement "Active" because we managed to send it would report money being
 * spent that is not.
 *
 * The boundary tests are the usual ones, and they matter more than usual: these
 * rows carry how much of somebody's money was spent and what it bought.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { Platform, PublicationStatus } from '@prisma/client';

import { Agent, agent, createTenant, prisma, resetDatabase, type Tenant } from './helpers.js';
import { adStatusOf } from '../src/services/advertising/status.js';
import { qualify } from '../src/services/advertising/metrics.js';
import { buildPreview } from '../src/services/advertising/preview.js';
import { derive, sumSnapshots } from '../src/services/analytics.js';

const DAY = 24 * 60 * 60 * 1000;

describe('advertising command center', () => {
  let alpha: Tenant;
  let beta: Tenant;
  let alphaAdmin: Agent;
  let betaAdmin: Agent;

  /** A campaign plus, optionally, a day of measured performance. */
  async function seedCampaign(tenant: Tenant, overrides: Record<string, unknown> = {}, measured?: {
    spend: number; impressions: number; clicks: number; conversions: number; revenue?: number; reach?: number;
  }) {
    const campaign = await prisma.campaign.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        name: `campaign ${Math.random().toString(36).slice(2, 8)}`,
        status: 'RUNNING',
        objective: 'TRAFFIC',
        budget: 3000,
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-12-31'),
      },
    });

    const publication = await prisma.adPublication.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        campaignId: campaign.id,
        platform: Platform.FACEBOOK,
        status: PublicationStatus.PUBLISHED,
        name: 'Ramadan offer',
        objective: 'TRAFFIC',
        dailyBudget: 100,
        currency: 'SAR',
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-12-31'),
        countries: ['SA'],
        linkUrl: 'https://example.test/menu',
        message: 'Two for one, all week.',
        headline: 'Ramadan offer',
        callToAction: 'ORDER_NOW',
        providerStatus: 'ACTIVE',
        ...overrides,
      },
    });

    if (measured) {
      await prisma.analyticsSnapshot.create({
        data: {
          organizationId: tenant.organizationId,
          clientId: tenant.clientId,
          campaignId: campaign.id,
          platform: (overrides.platform as Platform) ?? Platform.FACEBOOK,
          date: new Date('2026-01-10'),
          spend: measured.spend,
          impressions: measured.impressions,
          clicks: measured.clicks,
          conversions: measured.conversions,
          revenue: measured.revenue ?? 0,
          reach: measured.reach ?? 0,
        },
      });
    }

    return { campaign, publication };
  }

  beforeAll(async () => {
    await resetDatabase();
    alpha = await createTenant('ads-alpha');
    beta = await createTenant('ads-beta');

    alphaAdmin = agent();
    await alphaAdmin.login(alpha.adminEmail);
    betaAdmin = agent();
    await betaAdmin.login(beta.adminEmail);
  });

  const metric = (metrics: Array<{ metric: string; value: number | null; state: string }>, name: string) =>
    metrics.find((entry) => entry.metric === name)!;

  // ------------------------------------------------------- metric states

  it('reports an unfetched campaign as NOT_FETCHED, never as a measured zero', async () => {
    /*
     * The trap this whole layer exists to avoid. The snapshot columns default
     * to 0, so without the row-presence check this campaign would report
     * "0 impressions, 0 clicks, 0 spent" as though someone had asked Meta.
     */
    const { publication } = await seedCampaign(alpha);

    const response = await alphaAdmin.get('/api/advertising/campaigns');
    const row = response.body.items.find((item: { id: string }) => item.id === publication.id);

    expect(response.status).toBe(200);
    for (const name of ['spend', 'impressions', 'clicks', 'conversions']) {
      expect(metric(row.metrics, name).state).toBe('NOT_FETCHED');
      expect(metric(row.metrics, name).value).toBeNull();
    }
  });

  it('reports a measured campaign with its real figures', async () => {
    const { publication } = await seedCampaign(alpha, { name: 'Measured' }, {
      spend: 400, impressions: 10_000, clicks: 250, conversions: 0, reach: 8000,
    });

    const response = await alphaAdmin.get(`/api/advertising/campaigns/${publication.id}`);
    const metrics = response.body.campaign.metrics;

    expect(metric(metrics, 'spend')).toMatchObject({ value: 400, state: 'ZERO' });
    expect(metric(metrics, 'impressions')).toMatchObject({ value: 10_000, state: 'ZERO' });
    expect(metric(metrics, 'ctr').value).toBeCloseTo(250 / 10_000);

    /*
     * Spent 400 and converted nobody. CPA does not exist — reporting it as 0.00
     * would state that conversions were free, the most flattering possible
     * reading of the worst possible outcome.
     */
    expect(metric(metrics, 'cpa').value).toBeNull();
    expect(metric(metrics, 'cpa').note).toMatch(/no conversions/i);
  });

  it('keeps budget visible before any insight has been fetched', () => {
    // Budget is ours, set when the campaign was drafted, so suppressing it
    // alongside the fetched figures would hide a number we certainly know.
    const qualified = qualify('budget', {
      platforms: [Platform.FACEBOOK],
      sampleSize: 0,
      providerErrored: false,
      derived: derive(sumSnapshots([])),
      budget: 250,
    });

    expect(qualified).toMatchObject({ value: 250, state: 'ZERO' });
  });

  it('reports a metric the platform does not have as UNAVAILABLE', () => {
    // Google Search has no reach: an impression is a query, not a person.
    const google = qualify('reach', {
      platforms: [Platform.GOOGLE_ADS],
      sampleSize: 5,
      providerErrored: false,
      derived: derive(sumSnapshots([])),
      budget: null,
    });
    expect(google.state).toBe('UNAVAILABLE');
    expect(google.value).toBeNull();

    // Meta does report it, so the same metric is measurable there.
    expect(qualify('reach', {
      platforms: [Platform.FACEBOOK],
      sampleSize: 0,
      providerErrored: false,
      derived: derive(sumSnapshots([])),
      budget: null,
    }).state).toBe('NOT_FETCHED');
  });

  it('distinguishes a provider refusal from an unfetched campaign', async () => {
    const { publication } = await seedCampaign(alpha, {
      status: PublicationStatus.FAILED,
      errorMessage: 'Meta rejected the creative: text exceeds 20% of the image.',
      errorStatus: 400,
      providerStatus: null,
    });

    const response = await alphaAdmin.get(`/api/advertising/campaigns/${publication.id}`);
    const metrics = response.body.campaign.metrics;

    expect(metric(metrics, 'impressions').state).toBe('PROVIDER_ERROR');
    // And the provider's own words survive to the operator, verbatim.
    expect(response.body.campaign.error.message).toMatch(/exceeds 20%/);
    expect(response.body.campaign.error.status).toBe(400);
  });

  it('does not attribute a running campaign\'s spend to a draft beside it', async () => {
    /*
     * Found by looking at the dashboard rather than at the code. A snapshot is
     * unique on (campaign, platform, day) — a *campaign* grain — while an
     * AdPublication is finer. Keying performance by campaignId therefore handed
     * the whole campaign's spend to every advertisement on it, including one
     * that had never been sent anywhere. The draft showed SAR 1.2k spent.
     */
    const { campaign } = await seedCampaign(alpha, { name: 'Live ad' }, {
      spend: 1240, impressions: 84_210, clicks: 2130, conversions: 0,
    });

    const draft = await prisma.adPublication.create({
      data: {
        organizationId: alpha.organizationId,
        clientId: alpha.clientId,
        campaignId: campaign.id,
        platform: Platform.FACEBOOK,
        status: PublicationStatus.DRAFT,
        name: 'Draft beside it',
        objective: 'TRAFFIC',
        dailyBudget: 120,
        currency: 'SAR',
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-12-31'),
        countries: ['SA'],
        linkUrl: 'https://example.test',
        message: 'Body',
        headline: 'Head',
      },
    });

    const response = await alphaAdmin.get(`/api/advertising/campaigns/${draft.id}`);
    const metrics = response.body.campaign.metrics;

    expect(metric(metrics, 'spend').state).toBe('NOT_FETCHED');
    expect(metric(metrics, 'spend').value).toBeNull();
    expect(metric(metrics, 'spend').note).toMatch(/not been published/i);
    // The budget is still ours and still known.
    expect(metric(metrics, 'budget').value).toBe(120);
  });

  it('refuses to split campaign-level performance between sibling advertisements', async () => {
    // Two published ads on one campaign and platform: the figure is jointly
    // theirs and individually neither's, so neither may print it.
    const { campaign, publication } = await seedCampaign(alpha, { name: 'Sibling one' }, {
      spend: 500, impressions: 1000, clicks: 10, conversions: 1,
    });

    await prisma.adPublication.create({
      data: {
        organizationId: alpha.organizationId,
        clientId: alpha.clientId,
        campaignId: campaign.id,
        platform: Platform.FACEBOOK,
        status: PublicationStatus.PUBLISHED,
        name: 'Sibling two',
        objective: 'TRAFFIC',
        dailyBudget: 80,
        currency: 'SAR',
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-12-31'),
        countries: ['SA'],
        linkUrl: 'https://example.test',
        message: 'Body',
        headline: 'Head',
        providerStatus: 'ACTIVE',
      },
    });

    const response = await alphaAdmin.get(`/api/advertising/campaigns/${publication.id}`);
    const spend = metric(response.body.campaign.metrics, 'spend');

    expect(spend.state).toBe('NOT_FETCHED');
    expect(spend.note).toMatch(/campaign level/i);
  });

  // ------------------------------------------------------------- status

  it('refuses to call a published advertisement active without the provider saying so', () => {
    // Every adapter creates campaigns paused. "Published" is our fact; running
    // is the provider's, and Google Ads and TikTok never read theirs back.
    const verdict = adStatusOf({
      status: PublicationStatus.PUBLISHED,
      providerStatus: null,
      endDate: new Date(Date.now() + DAY),
      errorMessage: null,
    });

    expect(verdict.status).toBe('UNKNOWN');
    expect(verdict.detail).toMatch(/has not been read back/i);
  });

  it('normalises each provider spelling of paused onto one status', () => {
    for (const raw of ['PAUSED', 'DISABLE', 'ADSET_PAUSED']) {
      expect(adStatusOf({
        status: PublicationStatus.PUBLISHED,
        providerStatus: raw,
        endDate: new Date(Date.now() + DAY),
        errorMessage: null,
      }).status).toBe('PAUSED');
    }
  });

  it('treats a finished flight as completed whatever the provider still calls it', () => {
    expect(adStatusOf({
      status: PublicationStatus.PUBLISHED,
      providerStatus: 'ACTIVE',
      endDate: new Date(Date.now() - DAY),
      errorMessage: null,
    }).status).toBe('COMPLETED');
  });

  it('maps a rejection and a reauth to different actionable states', () => {
    expect(adStatusOf({
      status: PublicationStatus.PUBLISHED, providerStatus: 'DISAPPROVED',
      endDate: new Date(Date.now() + DAY), errorMessage: null,
    }).status).toBe('REJECTED');

    expect(adStatusOf({
      status: PublicationStatus.REQUIRES_REAUTH, providerStatus: null,
      endDate: new Date(Date.now() + DAY), errorMessage: null,
    }).status).toBe('NEEDS_ATTENTION');
  });

  it('does not invent a status for a provider word it does not know', () => {
    const verdict = adStatusOf({
      status: PublicationStatus.PUBLISHED,
      providerStatus: 'SOME_NEW_META_STATE',
      endDate: new Date(Date.now() + DAY),
      errorMessage: null,
    });
    expect(verdict.status).toBe('UNKNOWN');
    expect(verdict.detail).toContain('SOME_NEW_META_STATE');
  });

  // ------------------------------------------------------------ preview

  it('refuses a preview for a platform with no advertising integration', () => {
    // LinkedIn Ads is NOT_IMPLEMENTED in the matrix; a preview of an
    // advertisement that cannot be created is a picture of nothing.
    const preview = buildPreview({
      platform: Platform.LINKEDIN,
      advertiserName: 'Pawse',
      advertiserAvatarUrl: null,
      headline: 'Hello', message: 'World', description: null,
      callToAction: 'LEARN_MORE', linkUrl: 'https://example.test',
      media: null,
    });

    expect(preview.placements).toEqual([]);
    expect(preview.unavailable).toBeTruthy();
  });

  it('marks a preview estimated rather than exact when a rendered field is missing', () => {
    const preview = buildPreview({
      platform: Platform.FACEBOOK,
      advertiserName: 'Pawse',
      advertiserAvatarUrl: null,
      headline: null, // Facebook feed chrome shows this, so its absence matters.
      message: 'Two for one, all week.',
      description: null,
      callToAction: 'ORDER_NOW',
      linkUrl: 'https://example.test/menu',
      media: {
        type: 'IMAGE', mimeType: 'image/jpeg', sizeBytes: 400_000,
        width: 1080, height: 1080, durationSeconds: null, url: '/api/creatives/x/file',
      },
    });

    const feed = preview.placements.find((placement) => placement.key === 'FACEBOOK_FEED')!;
    expect(feed.fidelity).toBe('ESTIMATED');
    expect(feed.reason).toMatch(/headline/i);
  });

  it('refuses a placement whose media the platform would reject', () => {
    const preview = buildPreview({
      platform: Platform.FACEBOOK,
      advertiserName: 'Pawse',
      advertiserAvatarUrl: null,
      headline: 'Offer', message: 'Body', description: null,
      callToAction: 'ORDER_NOW', linkUrl: 'https://example.test',
      media: {
        // A file type Meta will not take at all.
        type: 'IMAGE', mimeType: 'image/tiff', sizeBytes: 400_000,
        width: 1080, height: 1080, durationSeconds: null, url: '/api/creatives/x/file',
      },
    });

    // The existing validator decides this, not a second copy of its rules.
    const feed = preview.placements.find((placement) => placement.key === 'FACEBOOK_FEED')!;
    expect(feed.fidelity).toBe('UNAVAILABLE');
    expect(feed.reason).toBeTruthy();
  });

  it('has nothing to render without media, and says so', () => {
    const preview = buildPreview({
      platform: Platform.INSTAGRAM,
      advertiserName: 'Pawse', advertiserAvatarUrl: null,
      headline: 'Offer', message: 'Body', description: null,
      callToAction: 'ORDER_NOW', linkUrl: 'https://example.test',
      media: null,
    });

    expect(preview.placements.every((placement) => placement.fidelity === 'UNAVAILABLE')).toBe(true);
    expect(preview.unavailable).toMatch(/not enough/i);
  });

  it('serves a preview over HTTP for a real campaign', async () => {
    const { publication } = await seedCampaign(alpha, { name: 'Previewable' });
    const response = await alphaAdmin.get(`/api/advertising/campaigns/${publication.id}/preview`);

    expect(response.status).toBe(200);
    expect(response.body.preview.platform).toBe('FACEBOOK');
    // Copy comes from the campaign's own record, never from a placeholder.
    expect(response.body.preview.primaryText).toBe('Two for one, all week.');
    for (const placement of response.body.preview.placements) {
      expect(['EXACT', 'ESTIMATED', 'UNAVAILABLE']).toContain(placement.fidelity);
    }
  });

  // ------------------------------------------------------- capabilities

  it('reads platform availability from the capability matrix, not a second list', async () => {
    const response = await alphaAdmin.get('/api/advertising/platforms');
    const byPlatform = Object.fromEntries(
      response.body.platforms.map((entry: { platform: string }) => [entry.platform, entry]),
    );

    expect(response.status).toBe(200);
    // Built here, so selectable even when a credential is absent.
    expect(byPlatform.FACEBOOK.selectable).toBe(true);
    // No integration at all: listed with its reason, never offered as a filter.
    expect(byPlatform.LINKEDIN.state).toBe('NOT_IMPLEMENTED');
    expect(byPlatform.LINKEDIN.selectable).toBe(false);
    expect(byPlatform.SNAPCHAT.selectable).toBe(false);
  });

  it('never puts a token or secret in an advertising payload', async () => {
    await seedCampaign(alpha, { name: 'Token check' });
    const response = await alphaAdmin.get('/api/advertising/overview');
    const body = JSON.stringify(response.body);

    expect(response.status).toBe(200);
    for (const forbidden of ['accessTokenEnc', 'refreshTokenEnc', 'tokenFingerprint']) {
      expect(body).not.toContain(forbidden);
    }
  });

  // ---------------------------------------------------------- monitoring

  it('surfaces campaigns that need attention, and counts them', async () => {
    await seedCampaign(alpha, {
      name: 'Broken', status: PublicationStatus.FAILED,
      errorMessage: 'Invalid destination URL.', errorStatus: 400, providerStatus: null,
    });

    const response = await alphaAdmin.get('/api/advertising/overview');

    expect(response.body.counts.needsAttention).toBeGreaterThan(0);
    expect(response.body.needsAttention.some((row: { name: string }) => row.name === 'Broken')).toBe(true);
    // The provider's own message, not "something went wrong".
    const broken = response.body.needsAttention.find((row: { name: string }) => row.name === 'Broken');
    expect(broken.error.message).toBe('Invalid destination URL.');
  });

  // ------------------------------------------------------------ calendar

  it('spans a paid flight across every day it covers', async () => {
    await seedCampaign(alpha, {
      name: 'Flight',
      startDate: new Date('2026-03-10'),
      endDate: new Date('2026-03-14'),
    });

    const response = await alphaAdmin.get(
      '/api/advertising/calendar?from=2026-03-01T00:00:00.000Z&to=2026-03-31T00:00:00.000Z',
    );

    const flight = response.body.items.find((item: { name: string }) => item.name === 'Flight');
    expect(response.status).toBe(200);
    // A campaign is a flight, not a moment: five days, not one.
    expect(flight.days).toEqual(['2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13', '2026-03-14']);
    expect(flight.dailyBudget).toBe(100);
  });

  it('includes a campaign that spans the whole window rather than dropping it', async () => {
    // Overlap, not containment. A campaign running all month starts before the
    // window and ends after it, and is exactly the one worth seeing.
    await seedCampaign(alpha, {
      name: 'Always on',
      startDate: new Date('2026-01-01'),
      endDate: new Date('2026-12-31'),
    });

    const response = await alphaAdmin.get(
      '/api/advertising/calendar?from=2026-06-01T00:00:00.000Z&to=2026-06-30T00:00:00.000Z',
    );

    expect(response.body.items.some((item: { name: string }) => item.name === 'Always on')).toBe(true);
  });

  // ------------------------------------------------------------- library

  it('offers download only for artwork this deployment actually stores', async () => {
    const { campaign } = await seedCampaign(alpha, { name: 'With creative' });

    const creative = await prisma.creative.create({
      data: {
        organizationId: alpha.organizationId,
        clientId: alpha.clientId,
        platform: Platform.FACEBOOK,
        preset: 'FEED_SQUARE',
        width: 1080,
        height: 1080,
        storageKey: 'clients/alpha/creatives/abc.png',
        url: '/api/creatives/abc/file',
        sizeBytes: 400_000,
      },
    });

    await prisma.adPublication.create({
      data: {
        organizationId: alpha.organizationId,
        clientId: alpha.clientId,
        campaignId: campaign.id,
        creativeId: creative.id,
        platform: Platform.FACEBOOK,
        status: PublicationStatus.PUBLISHED,
        name: 'Has artwork',
        objective: 'TRAFFIC',
        dailyBudget: 50,
        currency: 'SAR',
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-12-31'),
        countries: ['SA'],
        linkUrl: 'https://example.test',
        message: 'Body',
        headline: 'Head',
        providerStatus: 'ACTIVE',
      },
    });

    const response = await alphaAdmin.get('/api/advertising/creatives');
    const card = response.body.items.find((item: { campaignName: string }) => item.campaignName === 'Has artwork');

    expect(response.status).toBe(200);
    // We hold the bytes, so the operator may have them back.
    expect(card.downloadUrl).toBeTruthy();
    expect(card.kind).toBe('IMAGE');

    // A publication with no local artwork is not in the library at all — there
    // is nothing to put on a card, and a card with no picture is not a card.
    expect(
      response.body.items.some((item: { campaignName: string }) => item.campaignName === 'With creative'),
    ).toBe(false);
  });

  // ------------------------------------------------------------ boundary

  it('hides another organisation\'s campaigns from every list', async () => {
    await seedCampaign(beta, { name: 'Beta secret' }, {
      spend: 9999, impressions: 1, clicks: 1, conversions: 1,
    });

    for (const path of ['/api/advertising/campaigns', '/api/advertising/creatives']) {
      const response = await alphaAdmin.get(path);
      expect(response.status).toBe(200);
      for (const item of response.body.items) expect(item.clientId).toBe(alpha.clientId);
    }

    const overview = await alphaAdmin.get('/api/advertising/overview');
    // Beta's 9,999 must not reach alpha's spend under any aggregation.
    const spend = metric(overview.body.kpis, 'spend');
    expect(spend.value === null || spend.value < 9999).toBe(true);
  });

  it('refuses to read another organisation\'s campaign by naming its id', async () => {
    const { publication } = await seedCampaign(beta, { name: 'Beta only' });

    for (const path of [
      `/api/advertising/campaigns/${publication.id}`,
      `/api/advertising/campaigns/${publication.id}/preview`,
    ]) {
      const response = await alphaAdmin.get(path);
      // 404, not 403: the response must not confirm the row exists.
      expect(response.status).toBe(404);
    }

    // And beta can still read its own.
    expect((await betaAdmin.get(`/api/advertising/campaigns/${publication.id}`)).status).toBe(200);
  });

  it('does not let a client filter reach across organisations', async () => {
    const response = await alphaAdmin.get(`/api/advertising/campaigns?clientId=${beta.clientId}`);
    // The filter is not an authorisation: it narrows within scope, never past it.
    expect(response.status).toBe(200);
    expect(response.body.items).toEqual([]);
  });

  it('refuses an unauthenticated caller on every advertising route', async () => {
    for (const path of [
      '/api/advertising/overview',
      '/api/advertising/campaigns',
      '/api/advertising/creatives',
      '/api/advertising/calendar',
      '/api/advertising/platforms',
    ]) {
      expect((await agent().get(path)).status).toBe(401);
    }
  });
});

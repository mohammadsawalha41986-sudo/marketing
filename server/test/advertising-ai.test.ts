/**
 * The AI Advertising Engine.
 *
 * Almost every test here is a negative one, because the failure mode that
 * matters is not the engine missing an insight — it is the engine confidently
 * asserting one from three data points. "Meta has the best CPA" reads
 * identically whether it was computed from six months or from one afternoon,
 * and an operator moves budget on it either way.
 *
 * So: insufficient data must produce a *stated* non-finding rather than a quiet
 * omission, absent metrics must never be ranked as low ones, confidence must
 * follow the evidence rather than the size of the gap, and nothing anywhere may
 * change a budget.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { Platform, PublicationStatus, RecommendationStatus } from '@prisma/client';

import { Agent, agent, createTenant, prisma, resetDatabase, type Tenant } from './helpers.js';
import { canCompare, confidenceFor, isMaterialChange, isComparable } from '../src/services/advertising/ai/sufficiency.js';
import { derive, sumSnapshots } from '../src/services/analytics.js';

const DAY = 86_400_000;

/** A comparable entry built from real totals, as the engine builds them. */
function entry(key: string, rows: Array<Record<string, number>>, days = 14) {
  const snapshots = rows.map((row) => ({
    platform: Platform.FACEBOOK,
    date: new Date('2026-06-01'),
    spend: row.spend ?? 0,
    reach: row.reach ?? 0,
    impressions: row.impressions ?? 0,
    clicks: row.clicks ?? 0,
    conversions: row.conversions ?? 0,
    revenue: row.revenue ?? 0,
    engagements: 0,
  }));
  return {
    key,
    label: key,
    totals: derive(sumSnapshots(snapshots)),
    days,
    sampleSize: snapshots.length,
  };
}

describe('ai advertising engine', () => {
  let alpha: Tenant;
  let beta: Tenant;
  let alphaAdmin: Agent;
  let betaAdmin: Agent;
  let alphaClientUser: Agent;

  async function seedCampaign(tenant: Tenant, overrides: Record<string, unknown> = {}, measured?: {
    spend: number; impressions: number; clicks: number; conversions: number; date?: Date; platform?: Platform;
  }) {
    const campaign = await prisma.campaign.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        name: `campaign ${Math.random().toString(36).slice(2, 8)}`,
        status: 'RUNNING',
        objective: 'TRAFFIC',
        budget: 5000,
        startDate: new Date('2026-06-01'),
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
        name: 'Seeded ad',
        objective: 'TRAFFIC',
        dailyBudget: 100,
        currency: 'SAR',
        startDate: new Date('2026-06-01'),
        endDate: new Date('2026-12-31'),
        countries: ['SA'],
        linkUrl: 'https://example.test',
        message: 'Body',
        headline: 'Head',
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
          platform: measured.platform ?? (overrides.platform as Platform) ?? Platform.FACEBOOK,
          date: measured.date ?? new Date('2026-06-10'),
          spend: measured.spend,
          impressions: measured.impressions,
          clicks: measured.clicks,
          conversions: measured.conversions,
          revenue: 0,
          reach: 0,
        },
      });
    }

    return { campaign, publication };
  }

  const section = (body: { sections: Array<{ key: string; insights: unknown[] }> }, key: string) =>
    body.sections.find((entry) => entry.key === key)!;

  beforeAll(async () => {
    await resetDatabase();
    alpha = await createTenant('ai-alpha');
    beta = await createTenant('ai-beta');

    alphaAdmin = agent();
    await alphaAdmin.login(alpha.adminEmail);
    betaAdmin = agent();
    await betaAdmin.login(beta.adminEmail);
    alphaClientUser = agent();
    await alphaClientUser.login(alpha.clientAdminEmail);
  });

  // ------------------------------------------------- sufficiency, in units

  it('refuses to compare a group of one', () => {
    const verdict = canCompare([entry('only', [{ impressions: 50_000, clicks: 900 }])], 'ctr');
    expect(verdict.sufficiency).toBe('INSUFFICIENT');
    expect(verdict.reason).toMatch(/nothing to compare/i);
  });

  it('distinguishes never-measured from measured-but-thin', () => {
    // Nothing fetched at all: no amount of waiting on this data helps.
    const unmeasured = canCompare(
      [{ ...entry('a', []), sampleSize: 0 }, { ...entry('b', []), sampleSize: 0 }],
      'ctr',
    );
    expect(unmeasured.sufficiency).toBe('UNMEASURED');

    // Fetched, but nobody delivered enough to judge.
    const thin = canCompare(
      [entry('a', [{ impressions: 40, clicks: 1 }]), entry('b', [{ impressions: 30, clicks: 1 }])],
      'ctr',
    );
    expect(thin.sufficiency).toBe('INSUFFICIENT');
  });

  it('does not treat a campaign with 40 impressions as having a usable CTR', () => {
    expect(isComparable(entry('tiny', [{ impressions: 40, clicks: 4 }]), 'ctr')).toBe(false);
    expect(isComparable(entry('real', [{ impressions: 400_000, clicks: 4000 }]), 'ctr')).toBe(true);
  });

  it('caps a two-way comparison below HIGH however wide the gap', () => {
    // With two entries, one outlier is the result. A large gap between two thin
    // samples is still a thin sample.
    expect(confidenceFor({ groupSize: 2, days: 90, deliveryRatio: 1000 })).toBe('MEDIUM');
    expect(confidenceFor({ groupSize: 2, days: 2, deliveryRatio: 1000 })).toBe('LOW');
    expect(confidenceFor({ groupSize: 5, days: 30, deliveryRatio: 10 })).toBe('HIGH');
  });

  it('will not call a short window high confidence', () => {
    expect(confidenceFor({ groupSize: 6, days: 3, deliveryRatio: 50 })).toBe('LOW');
  });

  it('ignores a large relative move on a tiny base', () => {
    // 0.4% → 0.6% is a 50% rise and almost certainly nothing.
    expect(isMaterialChange({
      current: 0.006, previous: 0.004, minRelative: 0.2, currentSample: 0, previousSample: 3,
    })).toBe(false);

    expect(isMaterialChange({
      current: 0.006, previous: 0.004, minRelative: 0.2, currentSample: 30, previousSample: 30,
    })).toBe(true);
  });

  // ---------------------------------------------------- stated non-findings

  it('says it looked and found nothing, rather than omitting the card', async () => {
    /*
     * The distinction the whole engine turns on. An absent "best platform"
     * card cannot tell an operator whether the engine looked and found nothing
     * or never ran at all.
     */
    const response = await alphaAdmin.get('/api/advertising/ai/insights');

    expect(response.status).toBe(200);
    const platform = section(response.body, 'BEST_PLATFORM');
    expect(platform.insights).toHaveLength(1);
    expect((platform.insights[0] as { state: string }).state).toBe('INSUFFICIENT_DATA');
    expect((platform.insights[0] as { reason: string }).reason.length).toBeGreaterThan(0);
  });

  it('states that no audience data is fetched rather than inventing segments', async () => {
    const response = await alphaAdmin.get('/api/advertising/ai/insights');
    const audience = section(response.body, 'AUDIENCE').insights[0] as {
      state: string; finding: string; reason: string;
    };

    expect(audience.state).toBe('INSUFFICIENT_DATA');
    expect(audience.finding).toMatch(/no audience/i);
    // And it says why deriving them from targeting would be wrong.
    expect(audience.reason).toMatch(/requested/i);
  });

  it('reports no comparison period rather than inventing an anomaly', async () => {
    const response = await alphaAdmin.get('/api/advertising/ai/insights');
    const anomaly = section(response.body, 'ANOMALY').insights[0] as { state: string; reason: string };
    expect(['INSUFFICIENT_DATA', 'PERFORMING']).toContain(anomaly.state);
  });

  // -------------------------------------------------------- real findings

  it('compares platforms once both have delivered enough', async () => {
    await seedCampaign(alpha, { name: 'FB', platform: Platform.FACEBOOK }, {
      spend: 500, impressions: 100_000, clicks: 3000, conversions: 50, platform: Platform.FACEBOOK,
    });
    await seedCampaign(alpha, { name: 'TT', platform: Platform.TIKTOK }, {
      spend: 900, impressions: 100_000, clicks: 1000, conversions: 20, platform: Platform.TIKTOK,
    });

    const response = await alphaAdmin.get(
      '/api/advertising/ai/insights?from=2026-06-01T00:00:00.000Z&to=2026-06-30T00:00:00.000Z',
    );
    const insight = section(response.body, 'BEST_PLATFORM').insights[0] as {
      state: string; title: string; evidence: unknown[]; dataSources: string[]; confidence: string;
    };

    // Facebook: 500/50 = 10 CPA. TikTok: 900/20 = 45. Facebook wins.
    expect(insight.state).toBe('PERFORMING');
    expect(insight.title).toMatch(/Facebook/);
    expect(insight.evidence.length).toBeGreaterThan(0);
    expect(insight.dataSources).toContain('AnalyticsSnapshot');
    // Two platforms only, so never HIGH.
    expect(insight.confidence).not.toBe('HIGH');
  });

  it('carries evidence with figures on every real finding', async () => {
    const response = await alphaAdmin.get(
      '/api/advertising/ai/insights?from=2026-06-01T00:00:00.000Z&to=2026-06-30T00:00:00.000Z',
    );

    for (const sec of response.body.sections) {
      for (const insight of sec.insights as Array<{
        state: string; evidence: unknown[]; dataSources: string[];
      }>) {
        // A recommendation without its numbers is an opinion.
        if (insight.state !== 'INSUFFICIENT_DATA') {
          expect(insight.evidence.length).toBeGreaterThan(0);
        }
        expect(Array.isArray(insight.dataSources)).toBe(true);
      }
    }
  });

  it('surfaces a provider refusal at the highest priority', async () => {
    await seedCampaign(alpha, {
      name: 'Rejected ad',
      status: PublicationStatus.FAILED,
      errorMessage: 'Meta rejected the creative.',
      errorStatus: 400,
      providerStatus: null,
    });

    const response = await alphaAdmin.get(
      '/api/advertising/ai/insights?from=2026-06-01T00:00:00.000Z&to=2026-12-31T00:00:00.000Z',
    );
    const warnings = section(response.body, 'WARNINGS').insights as Array<{
      priority: string; finding: string;
    }>;

    const rejected = warnings.find((insight) => insight.finding.includes('Meta rejected the creative.'));
    expect(rejected).toBeTruthy();
    expect(rejected!.priority).toBe('P0');
  });

  // ------------------------------------------------------- money safety

  it('never proposes a budget figure it cannot justify', async () => {
    const response = await alphaAdmin.get(
      '/api/advertising/ai/insights?from=2026-06-01T00:00:00.000Z&to=2026-06-30T00:00:00.000Z',
    );

    for (const insight of section(response.body, 'BUDGET').insights as Array<{
      proposedChange: { to: unknown } | null; recommendedAction: string | null;
    }>) {
      // A `to` value would be a number the engine cannot defend: the right size
      // of a shift depends on headroom it does not measure.
      if (insight.proposedChange) expect(insight.proposedChange.to).toBeNull();
      if (insight.recommendedAction) expect(insight.recommendedAction).toMatch(/approve|review|nothing/i);
    }
  });

  it('has no route that applies a recommendation', async () => {
    await seedCampaign(alpha, { name: 'For persistence' }, {
      spend: 100, impressions: 50_000, clicks: 900, conversions: 10,
    });
    await alphaAdmin.get(
      `/api/advertising/ai/insights?persist=true&clientId=${alpha.clientId}`
      + '&from=2026-06-01T00:00:00.000Z&to=2026-12-31T00:00:00.000Z',
    );

    const list = await alphaAdmin.get('/api/advertising/ai/recommendations');
    const first = list.body.items[0];
    expect(first).toBeTruthy();

    // Accepting records agreement; it does not apply anything.
    const accepted = await alphaAdmin.post(
      `/api/advertising/ai/recommendations/${first.id}/decision`, { decision: 'ACCEPTED' },
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body.recommendation.status).toBe(RecommendationStatus.APPROVED);
    expect(accepted.body.recommendation.appliedAt).toBeNull();

    // And APPLIED is not reachable from the decision vocabulary.
    const applied = await alphaAdmin.post(
      `/api/advertising/ai/recommendations/${first.id}/decision`, { decision: 'APPLIED' },
    );
    expect(applied.status).toBe(400);
  });

  it('does not let a client-portal user decide on advertising spend', async () => {
    const list = await alphaAdmin.get('/api/advertising/ai/recommendations');
    const first = list.body.items[0];
    expect(first).toBeTruthy();

    const response = await alphaClientUser.post(
      `/api/advertising/ai/recommendations/${first.id}/decision`, { decision: 'DISMISSED' },
    );
    expect(response.status).toBe(403);
  });

  // ------------------------------------------------------- persistence

  it('supersedes a previous run without discarding decisions', async () => {
    const before = await alphaAdmin.get('/api/advertising/ai/recommendations');
    const decided = before.body.items.find(
      (item: { status: string }) => item.status === RecommendationStatus.APPROVED,
    );
    expect(decided).toBeTruthy();

    await alphaAdmin.get(
      `/api/advertising/ai/insights?persist=true&clientId=${alpha.clientId}`
      + '&from=2026-06-01T00:00:00.000Z&to=2026-12-31T00:00:00.000Z',
    );

    // The accepted row is somebody's decision and survives the new run.
    const after = await prisma.aiRecommendation.findUnique({ where: { id: decided.id } });
    expect(after?.status).toBe(RecommendationStatus.APPROVED);
  });

  it('hides superseded findings from the list', async () => {
    const response = await alphaAdmin.get('/api/advertising/ai/recommendations');
    for (const item of response.body.items) {
      expect(item.status).not.toBe(RecommendationStatus.EXPIRED);
    }
  });

  it('records the data sources it actually queried', async () => {
    const response = await alphaAdmin.get('/api/advertising/ai/recommendations');
    for (const item of response.body.items) {
      expect(Array.isArray(item.dataSources)).toBe(true);
      expect(item.dataSources.length).toBeGreaterThan(0);
    }
  });

  // --------------------------------------------------------------- brief

  it('refuses a brief for a platform with no advertising integration', async () => {
    // LinkedIn Ads is NOT_IMPLEMENTED; a brief for it describes an
    // advertisement nobody can run, and somebody would act on it.
    const response = await alphaAdmin.post('/api/advertising/ai/brief', {
      clientId: alpha.clientId,
      platform: 'LINKEDIN',
      objective: 'TRAFFIC',
      language: 'EN',
    });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('BRIEF_UNAVAILABLE');
  });

  it('labels a template-written brief as rule based rather than AI generated', async () => {
    // No OPENAI_API_KEY in the test environment, so the existing template
    // engine answers — and the brief must not imply a model was consulted.
    const response = await alphaAdmin.post('/api/advertising/ai/brief', {
      clientId: alpha.clientId,
      platform: 'FACEBOOK',
      objective: 'TRAFFIC',
      language: 'EN',
    });

    expect(response.status).toBe(200);
    expect(response.body.brief.origin).toBe('RULE_BASED');
    expect(response.body.brief.provider.isFallback).toBe(true);
    expect(response.body.brief.limitations.join(' ')).toMatch(/template|no language model/i);
  });

  it('names only placements the platform actually has, with real constraints', async () => {
    const response = await alphaAdmin.post('/api/advertising/ai/brief', {
      clientId: alpha.clientId,
      platform: 'INSTAGRAM',
      objective: 'TRAFFIC',
      language: 'EN',
    });

    const keys = response.body.brief.placements.map((placement: { key: string }) => placement.key);
    expect(keys).toContain('INSTAGRAM_FEED');
    // Read from the registries, never asked of the model.
    expect(keys).not.toContain('LINKEDIN_FEED');
  });

  it('calls hashtags relevance recommendations, never best performing', async () => {
    // No hashtag performance data is fetched from any platform.
    const response = await alphaAdmin.post('/api/advertising/ai/brief', {
      clientId: alpha.clientId, platform: 'INSTAGRAM', objective: 'TRAFFIC', language: 'EN',
    });
    expect(response.body.brief.hashtagBasis).toBe('RELEVANCE');
  });

  it('generates Arabic when Arabic is asked for', async () => {
    const response = await alphaAdmin.post('/api/advertising/ai/brief', {
      clientId: alpha.clientId, platform: 'FACEBOOK', objective: 'TRAFFIC', language: 'AR',
    });

    expect(response.status).toBe(200);
    const text = `${response.body.brief.headline} ${response.body.brief.primaryText}`;
    expect(/[؀-ۿ]/.test(text)).toBe(true);
  });

  // ------------------------------------------------------------ boundary

  it('never lets one organisation see another\'s insights', async () => {
    await seedCampaign(beta, { name: 'Beta only' }, {
      spend: 99_999, impressions: 900_000, clicks: 50_000, conversions: 900,
    });

    const response = await alphaAdmin.get(
      '/api/advertising/ai/insights?from=2026-06-01T00:00:00.000Z&to=2026-12-31T00:00:00.000Z',
    );
    const body = JSON.stringify(response.body);

    expect(response.status).toBe(200);
    expect(body).not.toContain('Beta only');
    expect(body).not.toContain('99999');
  });

  it('never lets one organisation see another\'s recommendations', async () => {
    await betaAdmin.get(
      `/api/advertising/ai/insights?persist=true&clientId=${beta.clientId}`
      + '&from=2026-06-01T00:00:00.000Z&to=2026-12-31T00:00:00.000Z',
    );

    const response = await alphaAdmin.get('/api/advertising/ai/recommendations');
    for (const item of response.body.items) {
      const row = await prisma.aiRecommendation.findUnique({ where: { id: item.id } });
      expect(row?.organizationId).toBe(alpha.organizationId);
    }
  });

  it('refuses to decide on another organisation\'s recommendation', async () => {
    const betaRow = await prisma.aiRecommendation.findFirst({
      where: { organizationId: beta.organizationId },
    });
    expect(betaRow).toBeTruthy();

    const response = await alphaAdmin.post(
      `/api/advertising/ai/recommendations/${betaRow!.id}/decision`, { decision: 'DISMISSED' },
    );
    // 404, not 403: the response must not confirm the row exists.
    expect(response.status).toBe(404);

    // And beta's row is untouched.
    const after = await prisma.aiRecommendation.findUnique({ where: { id: betaRow!.id } });
    expect(after?.status).toBe(betaRow!.status);
  });

  it('refuses a brief against another organisation\'s client', async () => {
    const response = await alphaAdmin.post('/api/advertising/ai/brief', {
      clientId: beta.clientId, platform: 'FACEBOOK', objective: 'TRAFFIC', language: 'EN',
    });
    expect(response.status).toBe(404);
  });

  it('refuses every AI route to an unauthenticated caller', async () => {
    for (const path of ['/api/advertising/ai/insights', '/api/advertising/ai/recommendations']) {
      expect((await agent().get(path)).status).toBe(401);
    }
    expect((await agent().post('/api/advertising/ai/brief', {})).status).toBe(401);
  });

  // ---------------------------------------------------------- ai status

  it('reports whether a model is configured, without exposing a key', async () => {
    const response = await alphaAdmin.get('/api/advertising/ai/insights');

    expect(response.body.ai.configured).toBe(false);
    expect(response.body.ai.provider).toBe('template');
    expect(JSON.stringify(response.body)).not.toMatch(/sk-[A-Za-z0-9]/);
  });

  it('keeps the analysis window in the report so a claim can be re-checked', async () => {
    const response = await alphaAdmin.get(
      '/api/advertising/ai/insights?from=2026-06-01T00:00:00.000Z&to=2026-06-30T00:00:00.000Z',
    );
    expect(response.body.window.days).toBe(29);
    expect(new Date(response.body.window.from).getTime()).toBe(new Date('2026-06-01T00:00:00.000Z').getTime());
  });

  it('names what it could not analyse rather than staying silent', async () => {
    const response = await alphaAdmin.get(
      `/api/advertising/ai/insights?clientId=${alpha.clientId}&from=2020-01-01T00:00:00.000Z&to=2020-01-31T00:00:00.000Z`,
    );
    expect(Array.isArray(response.body.limitations)).toBe(true);
    expect(response.body.limitations.join(' ')).toMatch(/been fetched/i);
  });

  it('does not recommend promoting organic posts without a baseline', async () => {
    const response = await alphaAdmin.get(
      `/api/advertising/ai/insights?clientId=${alpha.clientId}`,
    );
    const bridge = section(response.body, 'ORGANIC_TO_PAID').insights[0] as {
      state: string; reason: string;
    } | undefined;

    if (bridge) {
      expect(bridge.state).toBe('INSUFFICIENT_DATA');
      expect(bridge.reason).toMatch(/baseline|at least/i);
    }
  });

  it('never counts an unfetched organic post as a zero-engagement post', async () => {
    // The baseline is the median of *measured* posts. Including unfetched ones
    // as zeros would drag it down and make ordinary posts look exceptional.
    // One post per group: PlatformPost is unique on (postGroup, platform).
    for (let index = 0; index < 6; index += 1) {
      const group = await prisma.postGroup.create({
        data: {
          organizationId: alpha.organizationId,
          clientId: alpha.clientId,
          name: `bridge fixture ${index}`,
          status: 'PUBLISHED',
        },
      });

      await prisma.platformPost.create({
        data: {
          postGroupId: group.id,
          platform: Platform.INSTAGRAM,
          caption: 'seeded',
          status: 'PUBLISHED',
          publishedAt: new Date(Date.now() - index * DAY),
          // No config.metrics at all: never fetched.
          config: {},
        },
      });
    }

    const response = await alphaAdmin.get(`/api/advertising/ai/insights?clientId=${alpha.clientId}`);
    const bridge = section(response.body, 'ORGANIC_TO_PAID').insights[0] as {
      state: string; evidence: Array<{ value: string }>;
    };

    // Six unfetched posts are zero measured posts, not six zero-engagement ones.
    expect(bridge.state).toBe('INSUFFICIENT_DATA');
    expect(bridge.evidence[0]?.value).toBe('0');
  });
});

/**
 * The optimizer, and the things it must refuse to say.
 *
 * Recommendations are cheap to generate and expensive to act on, so most of
 * these assertions are about restraint: no advice from an empty window, no
 * budget move without a target and enough conversions, and above all no
 * reasoning from a ratio that does not exist. Spend with no attributed revenue
 * is a tracking finding, not a failing campaign — concluding otherwise blames
 * the campaign for a measurement gap.
 *
 * The apply path is tested for what it refuses. No provider mutation surface is
 * implemented, so applying must 501 and leave the recommendation unapplied
 * rather than marking a change nobody made.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Platform, Prisma, RecommendationType } from '@prisma/client';

import { agent, createTenant, prisma, resetDatabase, type Tenant } from './helpers.js';
import { optimize, recordRecommendations } from '../src/services/campaign/optimizer.js';

describe('campaign optimizer', () => {
  let tenant: Tenant;
  const from = new Date('2026-08-01T00:00:00.000Z');
  const to = new Date('2026-08-30T00:00:00.000Z');

  beforeAll(async () => {
    await resetDatabase();
    tenant = await createTenant('optimizer');
  });

  beforeEach(async () => {
    await prisma.aiRecommendation.deleteMany({ where: { organizationId: tenant.organizationId } });
    await prisma.analyticsSnapshot.deleteMany({ where: { organizationId: tenant.organizationId } });
    await prisma.integration.deleteMany({ where: { clientId: tenant.clientId } });
    await prisma.campaign.update({
      where: { id: tenant.campaignId },
      data: { targetRoas: null, targetCpa: null, currency: 'SAR' },
    });
  });

  const measure = (input: {
    date: string; spend: number; impressions: number; clicks: number;
    conversions?: number; revenue?: number;
  }) =>
    prisma.analyticsSnapshot.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        campaignId: tenant.campaignId,
        platform: Platform.FACEBOOK,
        date: new Date(`${input.date}T00:00:00.000Z`),
        spend: new Prisma.Decimal(input.spend),
        impressions: input.impressions,
        reach: Math.round(input.impressions * 0.7),
        clicks: input.clicks,
        conversions: input.conversions ?? 0,
        revenue: new Prisma.Decimal(input.revenue ?? 0),
      },
    });

  const run = () =>
    optimize({ prisma, organizationId: tenant.organizationId, clientId: tenant.clientId, from, to });

  it('says nothing needs changing rather than returning an empty list', async () => {
    const report = await run();

    expect(report.state).toBe('INSUFFICIENT_DATA');
    expect(report.recommendations).toHaveLength(1);
    expect(report.recommendations[0]?.type).toBe(RecommendationType.NO_ACTION);
    // "The optimizer did not run" and "nothing needs changing" must not look alike.
    expect(report.summary).toMatch(/no provider metrics/i);
  });

  it('treats spend with no attributed revenue as a tracking finding, not a failure', async () => {
    await measure({ date: '2026-08-10', spend: 400, impressions: 40_000, clicks: 900 });

    const report = await run();
    const tracking = report.recommendations.find((row) => row.type === RecommendationType.REVIEW_TRACKING);

    expect(tracking).toBeTruthy();
    expect(tracking?.state).toBe('INSUFFICIENT_DATA');
    // The ROAS evidence says unavailable, explicitly not zero.
    const roasEvidence = tracking?.evidence.find((row) => row.metric === 'roas');
    expect(roasEvidence?.value).toBe('unavailable');
    expect(roasEvidence?.detail).toMatch(/not zero/i);
    // And no budget recommendation is made from an unmeasurable return.
    expect(report.recommendations.some((row) => row.type === RecommendationType.INCREASE_BUDGET)).toBe(false);
  });

  it('recommends more budget only with a target, a return and enough conversions', async () => {
    await prisma.campaign.update({ where: { id: tenant.campaignId }, data: { targetRoas: new Prisma.Decimal(3) } });
    await measure({ date: '2026-08-10', spend: 500, impressions: 50_000, clicks: 1_200, conversions: 40, revenue: 2_400 });

    const report = await run();
    const increase = report.recommendations.find((row) => row.type === RecommendationType.INCREASE_BUDGET);

    expect(increase).toBeTruthy();
    // Exactly the sentence the brief asks for: the numbers, not an adjective.
    expect(increase?.reason).toMatch(/ROAS is 4\.80x over the selected period versus a target of 3\.00x/);
    expect(increase?.confidence).toBe('HIGH');
    expect(increase?.proposedChange).toEqual({ field: 'dailyBudgetPercent', from: 100, to: 120 });

    const evidence = increase?.evidence.find((row) => row.metric === 'roas');
    expect(evidence?.kind).toBe('OBSERVED');
    expect(evidence?.comparison).toContain('3.00x');
  });

  it('withholds a budget recommendation when conversions are below the floor', async () => {
    await prisma.campaign.update({ where: { id: tenant.campaignId }, data: { targetRoas: new Prisma.Decimal(3) } });
    // Great ROAS, but on two conversions — not enough to move money on.
    await measure({ date: '2026-08-10', spend: 200, impressions: 30_000, clicks: 600, conversions: 2, revenue: 1_600 });

    const report = await run();
    expect(report.recommendations.some((row) => row.type === RecommendationType.INCREASE_BUDGET)).toBe(false);
  });

  it('recommends reducing spend on a return well below target', async () => {
    await prisma.campaign.update({ where: { id: tenant.campaignId }, data: { targetRoas: new Prisma.Decimal(4) } });
    await measure({ date: '2026-08-10', spend: 600, impressions: 60_000, clicks: 900, conversions: 20, revenue: 720 });

    const report = await run();
    const decrease = report.recommendations.find((row) => row.type === RecommendationType.DECREASE_BUDGET);

    expect(decrease?.state).toBe('UNDERPERFORMING');
    expect(decrease?.reason).toMatch(/1\.20x against a target of 4\.00x/);
  });

  it('flags a broken connection as at risk', async () => {
    await prisma.integration.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        platform: Platform.FACEBOOK,
        status: 'ERROR',
      },
    });

    const report = await run();
    expect(report.state).toBe('AT_RISK');
    expect(report.recommendations[0]?.type).toBe(RecommendationType.REAUTHORIZE_ACCOUNT);
    expect(report.recommendations[0]?.evidence[0]?.kind).toBe('OBSERVED');
  });

  it('separates what it observed from what it inferred', async () => {
    await measure({ date: '2026-08-10', spend: 400, impressions: 40_000, clicks: 900 });
    const report = await run();

    const kinds = report.recommendations.flatMap((row) => row.evidence.map((item) => item.kind));
    expect(kinds).toContain('OBSERVED');
    expect(kinds).toContain('INFERRED');
  });

  it('records the metrics each recommendation was computed from', async () => {
    await prisma.campaign.update({ where: { id: tenant.campaignId }, data: { targetRoas: new Prisma.Decimal(3) } });
    await measure({ date: '2026-08-10', spend: 500, impressions: 50_000, clicks: 1_200, conversions: 40, revenue: 2_400 });

    const report = await run();
    const ids = await recordRecommendations({
      prisma, organizationId: tenant.organizationId, clientId: tenant.clientId, report,
    });

    expect(ids.length).toBeGreaterThan(0);
    const stored = await prisma.aiRecommendation.findFirstOrThrow({ where: { id: ids[0] } });

    expect(stored.status).toBe('PENDING');
    // Re-checkable later against the numbers that produced it.
    expect((stored.metricsSnapshot as Record<string, unknown>).spend).toBe(500);
    expect(stored.windowFrom).toBeTruthy();
    expect(Array.isArray(stored.evidence)).toBe(true);
  });

  it('expires an earlier run\'s pending rows instead of deleting them', async () => {
    await prisma.campaign.update({ where: { id: tenant.campaignId }, data: { targetRoas: new Prisma.Decimal(3) } });
    await measure({ date: '2026-08-10', spend: 500, impressions: 50_000, clicks: 1_200, conversions: 40, revenue: 2_400 });

    const first = await recordRecommendations({
      prisma, organizationId: tenant.organizationId, clientId: tenant.clientId, report: await run(),
    });
    await recordRecommendations({
      prisma, organizationId: tenant.organizationId, clientId: tenant.clientId, report: await run(),
    });

    const original = await prisma.aiRecommendation.findFirstOrThrow({ where: { id: first[0] } });
    expect(original.status).toBe('EXPIRED');
    // The log stays complete.
    expect(await prisma.aiRecommendation.count({ where: { organizationId: tenant.organizationId } })).toBeGreaterThan(1);
  });

  it('never reasons from another tenant\'s data', async () => {
    await measure({ date: '2026-08-10', spend: 400, impressions: 40_000, clicks: 900 });
    const other = await createTenant('optimizer-other');

    const report = await optimize({
      prisma, organizationId: other.organizationId, clientId: other.clientId, from, to,
    });
    expect(report.recommendations[0]?.type).toBe(RecommendationType.NO_ACTION);
  });
});

describe('applying a recommendation', () => {
  let tenant: Tenant;

  beforeAll(async () => {
    await resetDatabase();
    tenant = await createTenant('apply');
  });

  const seed = (type: RecommendationType = RecommendationType.INCREASE_BUDGET) =>
    prisma.aiRecommendation.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        campaignId: tenant.campaignId,
        type,
        state: 'PERFORMING',
        title: 'Increase budget',
        reason: 'ROAS is 4.80x versus a target of 3.00x.',
        evidence: [],
      },
    });

  it('refuses to apply a spend change that has not been approved', async () => {
    const recommendation = await seed();
    const client = agent();
    await client.login(tenant.adminEmail);

    const response = await client.post(`/api/analytics/recommendations/${recommendation.id}/apply`);

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/must be approved/i);
  });

  it('refuses to mark anything applied while no provider mutation exists', async () => {
    const recommendation = await seed();
    const client = agent();
    await client.login(tenant.adminEmail);

    await client.post(`/api/analytics/recommendations/${recommendation.id}/approve`);
    const response = await client.post(`/api/analytics/recommendations/${recommendation.id}/apply`);

    expect(response.status).toBe(501);
    expect(response.body.error.code).toBe('PROVIDER_MUTATION_NOT_IMPLEMENTED');

    // The critical assertion: local state was not updated on a change nobody made.
    const after = await prisma.aiRecommendation.findFirstOrThrow({ where: { id: recommendation.id } });
    expect(after.status).toBe('APPROVED');
    expect(after.appliedAt).toBeNull();
  });

  it('cannot apply another tenant\'s recommendation', async () => {
    const recommendation = await seed();
    const other = await createTenant('apply-other');
    const intruder = agent();
    await intruder.login(other.adminEmail);

    const response = await intruder.post(`/api/analytics/recommendations/${recommendation.id}/apply`);
    expect(response.status).toBe(404);
  });
});

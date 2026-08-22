/**
 * Which creative is working — and refusing to say so before we know.
 *
 * The assertions split into two halves. One is arithmetic: a creative used in
 * two campaigns is summed across both, because the same uploaded advertisement
 * being reused is the normal case and reporting only one campaign's half would
 * be silently wrong.
 *
 * The other is restraint. A rosette on 200 impressions is noise with a label,
 * so verdicts require evidence, thresholds are configurable, and a creative
 * that has not cleared them says exactly what it is still waiting for.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PerformanceGrain, Platform, Prisma } from '@prisma/client';

import { createTenant, prisma, resetDatabase, type Tenant } from './helpers.js';
import {
  creativePerformance,
  DEFAULT_THRESHOLDS,
  type PerformanceThresholds,
} from '../src/services/analytics/creative-performance.js';

describe('creative-level performance', () => {
  let tenant: Tenant;
  let creativeA: string;
  let creativeB: string;
  let secondCampaign: string;

  const from = new Date('2026-08-01T00:00:00.000Z');
  const to = new Date('2026-08-31T00:00:00.000Z');

  beforeAll(async () => {
    await resetDatabase();
    tenant = await createTenant('creative-perf');

    const media = await prisma.media.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        type: 'IMAGE',
        filename: 'perf-key',
        originalName: 'ad.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1000,
        url: '/api/media/x/file',
      },
    });

    const make = (headline: string) =>
      prisma.creative.create({
        data: {
          organizationId: tenant.organizationId,
          clientId: tenant.clientId,
          source: 'UPLOADED',
          mediaId: media.id,
          platform: Platform.FACEBOOK,
          preset: 'UPLOADED',
          width: 1080,
          height: 1080,
          storageKey: 'perf-key',
          url: '/api/creatives/x/file',
          sizeBytes: 1000,
          headline,
        },
      });

    creativeA = (await make('Burger')).id;
    creativeB = (await make('Brunch')).id;

    const campaign = await prisma.campaign.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        name: 'Second campaign',
        budget: new Prisma.Decimal(1000),
        startDate: from,
        endDate: to,
      },
    });
    secondCampaign = campaign.id;
  });

  beforeEach(async () => {
    await prisma.creativePerformance.deleteMany({ where: { organizationId: tenant.organizationId } });
  });

  const measure = (input: {
    creativeId: string;
    date: string;
    spend: number;
    impressions: number;
    clicks: number;
    conversions?: number;
    revenue?: number;
    campaignId?: string;
    videoViews?: number;
    videoCompletions?: number;
  }) =>
    prisma.creativePerformance.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        platform: Platform.FACEBOOK,
        date: new Date(`${input.date}T00:00:00.000Z`),
        creativeId: input.creativeId,
        campaignId: input.campaignId ?? tenant.campaignId,
        providerAdId: `ad-${input.creativeId}-${input.date}-${input.campaignId ?? 'default'}`,
        grain: PerformanceGrain.AD,
        currency: 'SAR',
        spend: new Prisma.Decimal(input.spend),
        impressions: input.impressions,
        reach: Math.round(input.impressions * 0.8),
        clicks: input.clicks,
        conversions: input.conversions ?? 0,
        revenue: new Prisma.Decimal(input.revenue ?? 0),
        videoViews: input.videoViews ?? null,
        videoCompletions: input.videoCompletions ?? null,
      },
    });

  const run = (thresholds?: PerformanceThresholds) =>
    creativePerformance({ prisma, organizationId: tenant.organizationId, from, to, thresholds });

  it('sums a creative across every campaign it ran in', async () => {
    await measure({ creativeId: creativeA, date: '2026-08-10', spend: 100, impressions: 5_000, clicks: 100 });
    await measure({
      creativeId: creativeA, date: '2026-08-10', spend: 60, impressions: 3_000, clicks: 40,
      campaignId: secondCampaign,
    });

    const { rows } = await run();
    const row = rows.find((entry) => entry.creativeId === creativeA)!;

    // One creative, one row, both campaigns' numbers in it.
    expect(rows).toHaveLength(1);
    expect(row.totals.spend).toBe(160);
    expect(row.totals.impressions).toBe(8_000);
    expect(row.campaignIds).toHaveLength(2);
  });

  it('refuses a verdict below the thresholds and says what is missing', async () => {
    await measure({ creativeId: creativeA, date: '2026-08-10', spend: 5, impressions: 200, clicks: 3 });

    const { rows } = await run();
    expect(rows[0]?.verdict).toBe('INSUFFICIENT_DATA');
    expect(rows[0]?.missing.join(' ')).toMatch(/impressions/);
    expect(rows[0]?.verdictReason).toMatch(/not enough data/i);
  });

  it('honours caller-supplied thresholds', async () => {
    await measure({ creativeId: creativeA, date: '2026-08-10', spend: 60, impressions: 2_000, clicks: 80 });
    await measure({ creativeId: creativeB, date: '2026-08-10', spend: 60, impressions: 2_000, clicks: 20 });

    // Default bar: both clear it and get judged.
    const strict = await run({ ...DEFAULT_THRESHOLDS, minImpressions: 100_000 });
    expect(strict.rows.every((row) => row.verdict === 'INSUFFICIENT_DATA')).toBe(true);

    const lenient = await run({ minImpressions: 100, minClicks: 1, minSpend: 1, minConversions: 1 });
    expect(lenient.rows.some((row) => row.verdict !== 'INSUFFICIENT_DATA')).toBe(true);
  });

  it('ranks against the account\'s own average, with the numbers in the reason', async () => {
    // A is well above the blended CTR, B well below.
    await measure({ creativeId: creativeA, date: '2026-08-10', spend: 100, impressions: 10_000, clicks: 400 });
    await measure({ creativeId: creativeB, date: '2026-08-10', spend: 100, impressions: 10_000, clicks: 40 });

    const { rows, baseline } = await run();
    const a = rows.find((row) => row.creativeId === creativeA)!;
    const b = rows.find((row) => row.creativeId === creativeB)!;

    expect(a.verdict).toBe('WINNER');
    expect(b.verdict).toBe('WEAK');
    // Never "CTR is good": the sentence carries both numbers.
    expect(a.verdictReason).toMatch(/click-through against an account average of/i);
    expect(baseline.ctr).toBeCloseTo(0.022, 3);
  });

  it('says a creative is judged on engagement when return cannot be measured', async () => {
    await measure({ creativeId: creativeA, date: '2026-08-10', spend: 100, impressions: 10_000, clicks: 400 });
    await measure({ creativeId: creativeB, date: '2026-08-10', spend: 100, impressions: 10_000, clicks: 40 });

    const { rows } = await run();
    expect(rows[0]?.verdictReason).toMatch(/return could not be measured/i);
  });

  it('uses ROAS over CTR once revenue and conversions are there', async () => {
    await measure({
      creativeId: creativeA, date: '2026-08-10', spend: 100, impressions: 10_000, clicks: 200,
      conversions: 20, revenue: 800,
    });
    await measure({
      creativeId: creativeB, date: '2026-08-10', spend: 100, impressions: 10_000, clicks: 200,
      conversions: 10, revenue: 100,
    });

    const { rows } = await run();
    const a = rows.find((row) => row.creativeId === creativeA)!;

    expect(a.verdict).toBe('WINNER');
    expect(a.verdictReason).toMatch(/ROAS/);
    expect(a.totals.roas).toBeCloseTo(8, 3);
  });

  it('never reports a zero ratio where the metric does not exist', async () => {
    await measure({ creativeId: creativeA, date: '2026-08-10', spend: 400, impressions: 20_000, clicks: 200 });

    const { rows } = await run();
    // Spend with no conversions: CPA and ROAS are unavailable, not 0.
    expect(rows[0]?.totals.cpa).toBeNull();
    expect(rows[0]?.totals.roas).toBeNull();
    expect(rows[0]?.totals.reasons.cpa).toMatch(/no conversions/i);
  });

  it('leaves video metrics unmeasured rather than zero when the provider omits them', async () => {
    await measure({ creativeId: creativeA, date: '2026-08-10', spend: 100, impressions: 5_000, clicks: 50 });
    const withoutVideo = await run();
    expect(withoutVideo.rows[0]?.totals.videoViews).toBeNull();
    expect(withoutVideo.rows[0]?.totals.completionRate).toBeNull();

    await prisma.creativePerformance.deleteMany({ where: { organizationId: tenant.organizationId } });
    await measure({
      creativeId: creativeA, date: '2026-08-11', spend: 100, impressions: 5_000, clicks: 50,
      videoViews: 1_000, videoCompletions: 250,
    });
    const withVideo = await run();
    expect(withVideo.rows[0]?.totals.videoViews).toBe(1_000);
    expect(withVideo.rows[0]?.totals.completionRate).toBeCloseTo(0.25, 3);
  });

  it('counts distinct days and reports the window it saw', async () => {
    await measure({ creativeId: creativeA, date: '2026-08-10', spend: 50, impressions: 2_000, clicks: 20 });
    await measure({ creativeId: creativeA, date: '2026-08-12', spend: 50, impressions: 2_000, clicks: 20 });

    const { rows } = await run();
    expect(rows[0]?.days).toBe(2);
    expect(rows[0]?.firstSeen).toBe('2026-08-10');
    expect(rows[0]?.lastSeen).toBe('2026-08-12');
    expect(rows[0]?.trend).toHaveLength(2);
  });

  it('cannot see another tenant\'s creatives', async () => {
    await measure({ creativeId: creativeA, date: '2026-08-10', spend: 100, impressions: 5_000, clicks: 50 });
    const other = await createTenant('creative-perf-other');

    const { rows } = await creativePerformance({
      prisma,
      organizationId: other.organizationId,
      from,
      to,
    });
    expect(rows).toHaveLength(0);
  });
});

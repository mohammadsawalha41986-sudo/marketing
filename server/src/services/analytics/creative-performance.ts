/**
 * How each creative is actually doing.
 *
 * This is the feature the product's promise rests on. If the operator makes the
 * ad and we run it, the one thing we owe them back is which ad worked — not
 * which campaign, which *ad*, because the campaign is our structure and the ad
 * is their work.
 *
 * Two rules run through the whole file.
 *
 * **A creative belongs to many campaigns.** The same uploaded advertisement can
 * run in a Ramadan push and a weekend brunch push, and its performance is the
 * sum across both. Anything that assumes one creative = one campaign will
 * report the wrong number the first time somebody reuses a file, which they
 * will, because reuse is the point of a creative library.
 *
 * **A verdict needs enough data to be a verdict.** Declaring a winner on 200
 * impressions is not analysis, it is noise with a rosette on it. Thresholds are
 * configurable and every insufficient result says exactly what it is still
 * waiting for.
 */

import { Prisma, type PrismaClient, type Platform } from '@prisma/client';

import { derive, type Derived } from '../analytics.js';

/**
 * How much evidence a verdict needs.
 *
 * Deliberately configurable: a restaurant spending 50 SAR a day and an operator
 * spending 5,000 need different bars, and a hardcoded one would be wrong for
 * both. The defaults are conservative — it is far cheaper to say "not enough
 * data yet" for another day than to pause the creative that was about to work.
 */
export interface PerformanceThresholds {
  minImpressions: number;
  minClicks: number;
  minSpend: number;
  /** Conversions needed before CPA or ROAS drive a verdict. */
  minConversions: number;
}

export const DEFAULT_THRESHOLDS: PerformanceThresholds = {
  minImpressions: 1_000,
  minClicks: 30,
  minSpend: 50,
  minConversions: 5,
};

export type PerformanceVerdict = 'WINNER' | 'GOOD' | 'AVERAGE' | 'WEAK' | 'INSUFFICIENT_DATA';

export interface CreativeTotals extends Derived {
  linkClicks: number;
  videoViews: number | null;
  videoThruplays: number | null;
  videoCompletions: number | null;
  /** Completions / views, null when either is unmeasured. */
  completionRate: number | null;
}

export interface CreativePerformanceRow {
  creativeId: string;
  platform: Platform | null;
  currency: string;
  /** Days with at least one measurement, so "since when" is answerable. */
  days: number;
  firstSeen: string | null;
  lastSeen: string | null;
  totals: CreativeTotals;
  verdict: PerformanceVerdict;
  /** Why this verdict, in the operator's terms and with the numbers in it. */
  verdictReason: string;
  /** What is still missing, when the verdict is INSUFFICIENT_DATA. */
  missing: string[];
  campaignIds: string[];
  /** Daily points, for the sparkline. */
  trend: Array<{ date: string; spend: number; clicks: number; conversions: number }>;
}

interface Baseline {
  ctr: number | null;
  cpa: number | null;
  roas: number | null;
}

/**
 * Is there enough here to judge?
 *
 * Impressions and spend gate everything, because a creative nobody saw has no
 * performance. Conversion-based verdicts additionally need conversions — which
 * is why a campaign with plenty of clicks and no purchases lands on
 * INSUFFICIENT_DATA for ROAS rather than on WEAK: not converting and not being
 * measured look identical from here, and only one of them is the creative's
 * fault.
 */
function sufficiency(totals: Derived, thresholds: PerformanceThresholds): string[] {
  const missing: string[] = [];
  if (totals.impressions < thresholds.minImpressions) {
    missing.push(`${totals.impressions.toLocaleString('en-US')} of ${thresholds.minImpressions.toLocaleString('en-US')} impressions`);
  }
  if (totals.clicks < thresholds.minClicks) {
    missing.push(`${totals.clicks} of ${thresholds.minClicks} clicks`);
  }
  if (totals.spend < thresholds.minSpend) {
    missing.push(`${totals.spend.toFixed(2)} of ${thresholds.minSpend} spend`);
  }
  return missing;
}

/**
 * Rank a creative against the account's own baseline, not an industry number.
 *
 * "Good CTR" depends entirely on the business, the country and the placement.
 * The only honest comparison available is against the rest of this operator's
 * own creatives over the same window.
 */
function judge(
  totals: Derived,
  baseline: Baseline,
  thresholds: PerformanceThresholds,
): { verdict: PerformanceVerdict; reason: string; missing: string[] } {
  const missing = sufficiency(totals, thresholds);
  if (missing.length > 0) {
    return {
      verdict: 'INSUFFICIENT_DATA',
      reason: `Not enough data to judge this creative yet — still needs ${missing.join(', ')}.`,
      missing,
    };
  }

  // ROAS first when it is measurable: revenue is the only outcome that settles
  // an argument. It needs both a measured return and enough conversions.
  if (totals.roas !== null && baseline.roas !== null && totals.conversions >= thresholds.minConversions) {
    const delta = totals.roas / baseline.roas;
    if (delta >= 1.25) {
      return {
        verdict: 'WINNER',
        reason: `${totals.roas.toFixed(2)}x ROAS against an account average of ${baseline.roas.toFixed(2)}x, on ${totals.conversions} conversions.`,
        missing: [],
      };
    }
    if (delta >= 1.0) {
      return { verdict: 'GOOD', reason: `${totals.roas.toFixed(2)}x ROAS, at or above the account average of ${baseline.roas.toFixed(2)}x.`, missing: [] };
    }
    if (delta >= 0.75) {
      return { verdict: 'AVERAGE', reason: `${totals.roas.toFixed(2)}x ROAS against an account average of ${baseline.roas.toFixed(2)}x.`, missing: [] };
    }
    return {
      verdict: 'WEAK',
      reason: `${totals.roas.toFixed(2)}x ROAS against an account average of ${baseline.roas.toFixed(2)}x, on ${totals.spend.toFixed(2)} of spend.`,
      missing: [],
    };
  }

  // No measurable return: fall back to CTR, and say that is what happened.
  if (totals.ctr !== null && baseline.ctr !== null && baseline.ctr > 0) {
    const delta = totals.ctr / baseline.ctr;
    const note = totals.roas === null ? ' Return could not be measured, so this is judged on engagement alone.' : '';

    if (delta >= 1.3) {
      return {
        verdict: 'WINNER',
        reason: `${(totals.ctr * 100).toFixed(2)}% click-through against an account average of ${(baseline.ctr * 100).toFixed(2)}%.${note}`,
        missing: [],
      };
    }
    if (delta >= 1.0) {
      return { verdict: 'GOOD', reason: `${(totals.ctr * 100).toFixed(2)}% click-through, above the account average of ${(baseline.ctr * 100).toFixed(2)}%.${note}`, missing: [] };
    }
    if (delta >= 0.7) {
      return { verdict: 'AVERAGE', reason: `${(totals.ctr * 100).toFixed(2)}% click-through against an account average of ${(baseline.ctr * 100).toFixed(2)}%.${note}`, missing: [] };
    }
    return {
      verdict: 'WEAK',
      reason: `${(totals.ctr * 100).toFixed(2)}% click-through against an account average of ${(baseline.ctr * 100).toFixed(2)}%.${note}`,
      missing: [],
    };
  }

  return {
    verdict: 'INSUFFICIENT_DATA',
    reason: 'This creative has delivery but no measurable click-through or return to judge it by.',
    missing: ['a measurable click-through rate'],
  };
}

const num = (value: Prisma.Decimal | number | null): number =>
  value === null ? 0 : typeof value === 'number' ? value : Number(value.toString());

export interface CreativePerformanceQuery {
  prisma: PrismaClient;
  organizationId: string;
  clientId?: string;
  from: Date;
  to: Date;
  thresholds?: PerformanceThresholds;
}

/**
 * Performance for every creative with measurements in the window.
 *
 * Rows are summed per creative *across campaigns*, which is the whole reason
 * this exists separately from the campaign rollups.
 */
export async function creativePerformance(input: CreativePerformanceQuery): Promise<{
  rows: CreativePerformanceRow[];
  baseline: Baseline;
  thresholds: PerformanceThresholds;
}> {
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;

  const measurements = await input.prisma.creativePerformance.findMany({
    where: {
      organizationId: input.organizationId,
      ...(input.clientId ? { clientId: input.clientId } : {}),
      date: { gte: input.from, lte: input.to },
      creativeId: { not: null },
    },
    orderBy: { date: 'asc' },
  });

  const grouped = new Map<string, typeof measurements>();
  for (const row of measurements) {
    const key = row.creativeId as string;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

  // The account's own average, computed once over everything in the window.
  const accountTotals = derive(
    measurements.reduce(
      (acc, row) => ({
        spend: acc.spend + num(row.spend),
        reach: acc.reach + row.reach,
        impressions: acc.impressions + row.impressions,
        clicks: acc.clicks + row.clicks,
        conversions: acc.conversions + row.conversions,
        revenue: acc.revenue + num(row.revenue),
        engagements: acc.engagements + row.engagements,
      }),
      { spend: 0, reach: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0, engagements: 0 },
    ),
  );

  const baseline: Baseline = { ctr: accountTotals.ctr, cpa: accountTotals.cpa, roas: accountTotals.roas };

  const rows: CreativePerformanceRow[] = [...grouped.entries()].map(([creativeId, group]) => {
    const totals = derive(
      group.reduce(
        (acc, row) => ({
          spend: acc.spend + num(row.spend),
          reach: acc.reach + row.reach,
          impressions: acc.impressions + row.impressions,
          clicks: acc.clicks + row.clicks,
          conversions: acc.conversions + row.conversions,
          revenue: acc.revenue + num(row.revenue),
          engagements: acc.engagements + row.engagements,
        }),
        { spend: 0, reach: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0, engagements: 0 },
      ),
    );

    // Video figures are null-preserving: a provider that omits them leaves the
    // metric unmeasured rather than zero.
    const videoViews = group.some((row) => row.videoViews !== null)
      ? group.reduce((sum, row) => sum + (row.videoViews ?? 0), 0)
      : null;
    const videoThruplays = group.some((row) => row.videoThruplays !== null)
      ? group.reduce((sum, row) => sum + (row.videoThruplays ?? 0), 0)
      : null;
    const videoCompletions = group.some((row) => row.videoCompletions !== null)
      ? group.reduce((sum, row) => sum + (row.videoCompletions ?? 0), 0)
      : null;

    const { verdict, reason, missing } = judge(totals, baseline, thresholds);

    return {
      creativeId,
      platform: group[0]?.platform ?? null,
      currency: group[0]?.currency ?? 'USD',
      days: new Set(group.map((row) => row.date.toISOString().slice(0, 10))).size,
      firstSeen: group[0]?.date.toISOString().slice(0, 10) ?? null,
      lastSeen: group[group.length - 1]?.date.toISOString().slice(0, 10) ?? null,
      totals: {
        ...totals,
        linkClicks: group.reduce((sum, row) => sum + row.linkClicks, 0),
        videoViews,
        videoThruplays,
        videoCompletions,
        completionRate:
          videoCompletions !== null && videoViews !== null && videoViews > 0 ? videoCompletions / videoViews : null,
      },
      verdict,
      verdictReason: reason,
      missing,
      campaignIds: [...new Set(group.map((row) => row.campaignId).filter((id): id is string => Boolean(id)))],
      trend: group.map((row) => ({
        date: row.date.toISOString().slice(0, 10),
        spend: num(row.spend),
        clicks: row.clicks,
        conversions: row.conversions,
      })),
    };
  });

  // Spend first: the creative burning the most money is the one worth looking
  // at, whether it is winning or losing.
  rows.sort((a, b) => b.totals.spend - a.totals.spend);

  return { rows, baseline, thresholds };
}

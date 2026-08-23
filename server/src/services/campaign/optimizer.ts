/**
 * The optimizer.
 *
 * It reads measured provider metrics and proposes changes. It does not apply
 * them, does not touch a provider, and does not write to the campaign — that
 * separation is deliberate, because a recommendation and a mutation have very
 * different consequences and only one of them spends money.
 *
 * The rule that shapes every line here: **a recommendation without its numbers
 * is an opinion.** "ROAS is good" tells an operator nothing they can check,
 * argue with, or defend to whoever owns the budget. Every recommendation this
 * produces carries the exact figures it was computed from, the window they came
 * from, and what it expects to change — so the operator can disagree with the
 * reasoning rather than just the conclusion.
 *
 * Three things it must never do:
 *
 * - invent a number it did not measure
 * - convert an unmeasurable ratio into a zero and reason from it
 * - propose an action against a provider surface we have not implemented
 */

import { Prisma, RecommendationConfidence, RecommendationType, type PrismaClient } from '@prisma/client';

import { derive, type Derived } from '../analytics.js';
import { creativePerformance, DEFAULT_THRESHOLDS, type PerformanceThresholds } from '../analytics/creative-performance.js';

export type PerformanceState = 'PERFORMING' | 'UNDERPERFORMING' | 'AT_RISK' | 'INSUFFICIENT_DATA';

/**
 * A single measured fact, stated so it can be re-checked.
 *
 * `observed` is what the data says. `inferred` is what we concluded from it.
 * Keeping them apart in the payload is what lets the UI label them differently
 * — the master brief's OBSERVED / INFERRED / RECOMMENDED distinction is not a
 * presentation detail, it is the difference between a measurement and a guess.
 */
export interface Evidence {
  kind: 'OBSERVED' | 'INFERRED';
  metric: string;
  /** Formatted for a human, with units. */
  value: string;
  /** What it is being compared against, when there is a comparison. */
  comparison?: string;
  detail: string;
}

export interface Recommendation {
  type: RecommendationType;
  state: PerformanceState;
  title: string;
  reason: string;
  evidence: Evidence[];
  confidence: RecommendationConfidence;
  proposedChange: { field: string; from: number | string | null; to: number | string | null } | null;
  expectedImpact: string | null;
  campaignId?: string | null;
  creativeId?: string | null;
  publicationId?: string | null;
}

export interface OptimizerInput {
  prisma: PrismaClient;
  organizationId: string;
  clientId: string;
  from: Date;
  to: Date;
  thresholds?: PerformanceThresholds;
  now?: Date;
}

export interface OptimizerReport {
  state: PerformanceState;
  /** Why the overall state is what it is. */
  summary: string;
  recommendations: Recommendation[];
  /** The figures every recommendation was computed from. */
  metricsSnapshot: Derived & { windowDays: number };
  /** What could not be measured, and therefore was not reasoned about. */
  limitations: string[];
  window: { from: string; to: string };
}

const money = (value: number, currency = '') => `${value.toFixed(2)}${currency ? ` ${currency}` : ''}`;
const percent = (value: number) => `${(value * 100).toFixed(2)}%`;
const num = (value: Prisma.Decimal | number | null): number =>
  value === null ? 0 : typeof value === 'number' ? value : Number(value.toString());

/**
 * Analyse one restaurant's campaigns and say what to do about them.
 *
 * Returns recommendations in priority order. NO_ACTION is a real answer and is
 * returned rather than an empty list, because "nothing needs changing" and "the
 * optimizer did not run" must not look the same on screen.
 */
export async function optimize(input: OptimizerInput): Promise<OptimizerReport> {
  const { prisma } = input;
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;
  const windowDays = Math.max(1, Math.round((input.to.getTime() - input.from.getTime()) / 86_400_000));

  const snapshots = await prisma.analyticsSnapshot.findMany({
    where: {
      organizationId: input.organizationId,
      clientId: input.clientId,
      date: { gte: input.from, lte: input.to },
    },
    include: { campaign: { select: { id: true, name: true, targetRoas: true, targetCpa: true, currency: true, status: true } } },
  });

  const totals = derive({
    spend: snapshots.reduce((sum, row) => sum + num(row.spend), 0),
    reach: snapshots.reduce((sum, row) => sum + row.reach, 0),
    impressions: snapshots.reduce((sum, row) => sum + row.impressions, 0),
    clicks: snapshots.reduce((sum, row) => sum + row.clicks, 0),
    conversions: snapshots.reduce((sum, row) => sum + row.conversions, 0),
    revenue: snapshots.reduce((sum, row) => sum + num(row.revenue), 0),
    engagements: snapshots.reduce((sum, row) => sum + row.engagements, 0),
  });

  const recommendations: Recommendation[] = [];
  const limitations: string[] = [];

  // Everything unmeasurable is named once, up front, and then not reasoned from.
  for (const [key, reason] of Object.entries(totals.reasons)) {
    limitations.push(`${key.toUpperCase()}: ${reason}.`);
  }

  // ------------------------------------------------------------ tracking
  const integration = await prisma.integration.findFirst({
    where: { clientId: input.clientId, status: { not: 'CONNECTED' } },
    select: { id: true, platform: true, status: true },
  });

  if (integration) {
    recommendations.push({
      type: RecommendationType.REAUTHORIZE_ACCOUNT,
      state: 'AT_RISK',
      title: `Reconnect ${integration.platform.toLowerCase()}`,
      reason: `The ${integration.platform.toLowerCase()} connection is ${integration.status.toLowerCase()}, so campaigns on it cannot be published or measured.`,
      evidence: [
        {
          kind: 'OBSERVED',
          metric: 'integration.status',
          value: integration.status,
          detail: 'Read from the stored connection, not inferred.',
        },
      ],
      confidence: RecommendationConfidence.HIGH,
      proposedChange: null,
      expectedImpact: 'Restores publishing and metric ingestion for this platform.',
    });
  }

  /*
   * Spend with no attributed revenue is the highest-value finding in the whole
   * system, and it is a *tracking* recommendation rather than a performance one.
   * Concluding "this campaign is failing" from unmeasured revenue would blame
   * the campaign for a measurement gap.
   */
  if (totals.spend > 0 && totals.revenue === 0) {
    recommendations.push({
      type: RecommendationType.REVIEW_TRACKING,
      state: 'INSUFFICIENT_DATA',
      title: 'Revenue is not being measured',
      reason:
        `${money(totals.spend)} of spend over ${windowDays} days has no revenue attributed to it. ` +
        'Return on ad spend cannot be calculated, so no budget decision here can be based on it.',
      evidence: [
        { kind: 'OBSERVED', metric: 'spend', value: money(totals.spend), detail: `Summed from provider metrics over ${windowDays} days.` },
        { kind: 'OBSERVED', metric: 'revenue', value: money(0), detail: 'No conversion value has been attributed to these campaigns.' },
        {
          kind: 'INFERRED',
          metric: 'roas',
          value: 'unavailable',
          detail: 'Not zero — unmeasurable. This is usually a tracking gap rather than a campaign that returned nothing.',
        },
      ],
      confidence: RecommendationConfidence.HIGH,
      proposedChange: null,
      expectedImpact: 'Makes ROAS and CPA computable, which every budget recommendation depends on.',
    });
  }

  // ------------------------------------------------------ campaign budgets
  const byCampaign = new Map<string, typeof snapshots>();
  for (const row of snapshots) {
    if (!row.campaignId) continue;
    byCampaign.set(row.campaignId, [...(byCampaign.get(row.campaignId) ?? []), row]);
  }

  for (const [campaignId, rows] of byCampaign) {
    const campaign = rows[0]?.campaign;
    if (!campaign) continue;

    const campaignTotals = derive({
      spend: rows.reduce((sum, row) => sum + num(row.spend), 0),
      reach: rows.reduce((sum, row) => sum + row.reach, 0),
      impressions: rows.reduce((sum, row) => sum + row.impressions, 0),
      clicks: rows.reduce((sum, row) => sum + row.clicks, 0),
      conversions: rows.reduce((sum, row) => sum + row.conversions, 0),
      revenue: rows.reduce((sum, row) => sum + num(row.revenue), 0),
      engagements: rows.reduce((sum, row) => sum + row.engagements, 0),
    });

    if (campaignTotals.spend < thresholds.minSpend || campaignTotals.impressions < thresholds.minImpressions) {
      continue;
    }

    const targetRoas = campaign.targetRoas ? Number(campaign.targetRoas.toString()) : null;
    const targetCpa = campaign.targetCpa ? Number(campaign.targetCpa.toString()) : null;

    // ROAS against an explicit target is the only budget signal strong enough
    // to justify moving money, and only when both sides exist.
    if (campaignTotals.roas !== null && targetRoas !== null && campaignTotals.conversions >= thresholds.minConversions) {
      const evidence: Evidence[] = [
        {
          kind: 'OBSERVED',
          metric: 'roas',
          value: `${campaignTotals.roas.toFixed(2)}x`,
          comparison: `target ${targetRoas.toFixed(2)}x`,
          detail: `${money(campaignTotals.revenue, campaign.currency)} revenue on ${money(campaignTotals.spend, campaign.currency)} spend over ${windowDays} days.`,
        },
        {
          kind: 'OBSERVED',
          metric: 'conversions',
          value: String(campaignTotals.conversions),
          detail: `Above the ${thresholds.minConversions}-conversion floor this verdict requires.`,
        },
      ];

      if (campaignTotals.roas >= targetRoas * 1.2) {
        recommendations.push({
          type: RecommendationType.INCREASE_BUDGET,
          state: 'PERFORMING',
          title: `Increase budget on ${campaign.name}`,
          reason: `ROAS is ${campaignTotals.roas.toFixed(2)}x over the selected period versus a target of ${targetRoas.toFixed(2)}x.`,
          evidence,
          confidence: RecommendationConfidence.HIGH,
          // A percentage, not an absolute: the daily budget lives at the
          // provider and this proposal is validated against it at apply time.
          proposedChange: { field: 'dailyBudgetPercent', from: 100, to: 120 },
          expectedImpact: 'More delivery at a return that is already above target. Raise gradually — a large step resets learning.',
          campaignId,
        });
      } else if (campaignTotals.roas < targetRoas * 0.6) {
        recommendations.push({
          type: RecommendationType.DECREASE_BUDGET,
          state: 'UNDERPERFORMING',
          title: `Reduce spend on ${campaign.name}`,
          reason: `ROAS is ${campaignTotals.roas.toFixed(2)}x against a target of ${targetRoas.toFixed(2)}x, on ${money(campaignTotals.spend, campaign.currency)} of spend.`,
          evidence,
          confidence: RecommendationConfidence.MEDIUM,
          proposedChange: { field: 'dailyBudgetPercent', from: 100, to: 75 },
          expectedImpact: 'Limits further spend at a return below target while the creative or audience is reviewed.',
          campaignId,
        });
      }
    }

    // CPA against target, when ROAS is not available but conversions are.
    if (
      campaignTotals.roas === null &&
      campaignTotals.cpa !== null &&
      targetCpa !== null &&
      campaignTotals.conversions >= thresholds.minConversions &&
      campaignTotals.cpa > targetCpa * 1.5
    ) {
      recommendations.push({
        type: RecommendationType.REVIEW_AUDIENCE,
        state: 'UNDERPERFORMING',
        title: `Review the audience on ${campaign.name}`,
        reason: `Cost per conversion is ${money(campaignTotals.cpa, campaign.currency)} against a target of ${money(targetCpa, campaign.currency)}.`,
        evidence: [
          {
            kind: 'OBSERVED',
            metric: 'cpa',
            value: money(campaignTotals.cpa, campaign.currency),
            comparison: `target ${money(targetCpa, campaign.currency)}`,
            detail: `${campaignTotals.conversions} conversions from ${money(campaignTotals.spend, campaign.currency)} of spend.`,
          },
        ],
        confidence: RecommendationConfidence.MEDIUM,
        proposedChange: null,
        expectedImpact: 'A narrower or better-matched audience usually moves CPA before creative changes do.',
        campaignId,
      });
    }
  }

  // ----------------------------------------------------------- creatives
  const { rows: creatives, baseline } = await creativePerformance({
    prisma,
    organizationId: input.organizationId,
    clientId: input.clientId,
    from: input.from,
    to: input.to,
    thresholds,
  });

  for (const creative of creatives) {
    if (creative.verdict === 'WEAK') {
      recommendations.push({
        type: RecommendationType.PAUSE_CREATIVE,
        state: 'UNDERPERFORMING',
        title: 'Pause the weakest creative',
        reason: creative.verdictReason,
        evidence: [
          {
            kind: 'OBSERVED',
            metric: 'spend',
            value: money(creative.totals.spend, creative.currency),
            detail: `Over ${creative.days} day(s) in ${creative.campaignIds.length} campaign(s).`,
          },
          ...(creative.totals.ctr !== null && baseline.ctr !== null
            ? [{
                kind: 'OBSERVED' as const,
                metric: 'ctr',
                value: percent(creative.totals.ctr),
                comparison: `account average ${percent(baseline.ctr)}`,
                detail: 'Measured from provider insights for this creative across every campaign it ran in.',
              }]
            : []),
        ],
        confidence: RecommendationConfidence.MEDIUM,
        proposedChange: { field: 'creative.status', from: 'ACTIVE', to: 'PAUSED' },
        expectedImpact: 'Stops spend on the weakest performer so the budget concentrates on the rest.',
        creativeId: creative.creativeId,
      });
    }

    if (creative.verdict === 'WINNER') {
      recommendations.push({
        type: RecommendationType.ADD_CREATIVE_VARIANT,
        state: 'PERFORMING',
        title: 'Make more like this one',
        reason: creative.verdictReason,
        evidence: [
          {
            kind: 'OBSERVED',
            metric: 'verdict',
            value: 'WINNER',
            detail: creative.verdictReason,
          },
          {
            kind: 'INFERRED',
            metric: 'creative fatigue',
            value: 'expected',
            detail: 'A creative that is working now will decay as frequency rises. A variant ready in advance avoids the gap.',
          },
        ],
        confidence: RecommendationConfidence.LOW,
        proposedChange: null,
        expectedImpact: 'Keeps the format that is working available when this specific file tires.',
        creativeId: creative.creativeId,
      });
    }
  }

  // ------------------------------------------------------- overall state
  /*
   * At risk outranks everything, including having no data. A dead connection is
   * a risk precisely when nothing is coming in — reporting INSUFFICIENT_DATA
   * there describes the symptom and hides the cause.
   */
  const state: PerformanceState =
    recommendations.some((row) => row.state === 'AT_RISK')
      ? 'AT_RISK'
      : snapshots.length === 0
        ? 'INSUFFICIENT_DATA'
        : totals.roas === null
          ? 'INSUFFICIENT_DATA'
          : recommendations.some((row) => row.state === 'UNDERPERFORMING')
            ? 'UNDERPERFORMING'
            : 'PERFORMING';

  if (recommendations.length === 0) {
    recommendations.push({
      type: RecommendationType.NO_ACTION,
      state,
      title: 'Nothing needs changing',
      reason:
        snapshots.length === 0
          ? `No measured campaign data in this ${windowDays}-day window, so there is nothing to act on.`
          : `Every measured campaign is within its targets over the last ${windowDays} days.`,
      evidence: [
        {
          kind: 'OBSERVED',
          metric: 'measurements',
          value: String(snapshots.length),
          detail: `Daily rows read for this restaurant between ${input.from.toISOString().slice(0, 10)} and ${input.to.toISOString().slice(0, 10)}.`,
        },
      ],
      confidence: snapshots.length === 0 ? RecommendationConfidence.LOW : RecommendationConfidence.MEDIUM,
      proposedChange: null,
      expectedImpact: null,
    });
  }

  return {
    state,
    summary:
      snapshots.length === 0
        ? 'No provider metrics have been ingested for this restaurant in this window, so no recommendation is based on measured performance.'
        : `${money(totals.spend)} of measured spend over ${windowDays} days, ` +
          (totals.roas === null
            ? `with return unmeasurable: ${(totals.reasons.roas ?? '').toLowerCase()}.`
            : `returning ${totals.roas.toFixed(2)}x.`),
    recommendations,
    metricsSnapshot: { ...totals, windowDays },
    limitations,
    window: { from: input.from.toISOString().slice(0, 10), to: input.to.toISOString().slice(0, 10) },
  };
}

/**
 * Persist a run's recommendations so they can be approved, applied and audited.
 *
 * Pending rows from earlier runs are expired rather than deleted: a
 * recommendation somebody read yesterday should still be findable, and the
 * decision log is only useful if it is complete.
 */
export async function recordRecommendations(input: {
  prisma: PrismaClient;
  organizationId: string;
  clientId: string;
  report: OptimizerReport;
  now?: Date;
}): Promise<string[]> {
  const { prisma } = input;

  await prisma.aiRecommendation.updateMany({
    where: { organizationId: input.organizationId, clientId: input.clientId, status: 'PENDING' },
    data: { status: 'EXPIRED' },
  });

  const created = await Promise.all(
    input.report.recommendations
      // NO_ACTION is a real answer for the operator to read, but storing it as
      // a pending decision would fill the log with things nobody can act on.
      .filter((recommendation) => recommendation.type !== RecommendationType.NO_ACTION)
      .map((recommendation) =>
        prisma.aiRecommendation.create({
          data: {
            organizationId: input.organizationId,
            clientId: input.clientId,
            campaignId: recommendation.campaignId ?? null,
            creativeId: recommendation.creativeId ?? null,
            publicationId: recommendation.publicationId ?? null,
            type: recommendation.type,
            state: recommendation.state,
            title: recommendation.title,
            reason: recommendation.reason,
            evidence: recommendation.evidence as unknown as Prisma.InputJsonValue,
            confidence: recommendation.confidence,
            proposedChange: (recommendation.proposedChange ?? undefined) as unknown as Prisma.InputJsonValue,
            expectedImpact: recommendation.expectedImpact,
            metricsSnapshot: input.report.metricsSnapshot as unknown as Prisma.InputJsonValue,
            windowFrom: new Date(input.report.window.from),
            windowTo: new Date(input.report.window.to),
          },
          select: { id: true },
        }),
      ),
  );

  return created.map((row) => row.id);
}

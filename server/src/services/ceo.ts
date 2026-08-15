/**
 * Executive intelligence: the portfolio view a CEO reads in two minutes.
 *
 * Everything here is an aggregate over per-campaign figures computed in
 * `finance.ts` and `campaign-health.ts`. Two aggregation rules matter, and both
 * exist to stop a portfolio number from being quietly wrong:
 *
 * 1. A total is built only from the campaigns that actually have the figure,
 *    and it always carries how many of them did. "Revenue 40,000 (3 of 11
 *    campaigns)" is a usable number; "Revenue 40,000" over eleven campaigns
 *    where eight have no POS data is a misleading one.
 *
 * 2. A portfolio ratio is never the average of per-campaign ratios. Averaging
 *    ROAS gives a tiny campaign the same vote as one spending fifty times more.
 *    Ratios are recomputed from the summed numerator and denominator.
 */

import { CampaignStatus } from '@prisma/client';

import type { HealthScore, Recommendation } from './campaign-health.js';
import { bandFor, MIN_COVERAGE, type HealthBand } from './campaign-health.js';
import { figure, ratio, unavailable, type CampaignFinance, type Figure } from './finance.js';

/** A portfolio total plus how much of the portfolio it covers. */
export interface Aggregate {
  figure: Figure;
  contributing: number;
  total: number;
}

function sumOf(values: Figure[], missing: string): Aggregate {
  const available = values.filter((value): value is Extract<Figure, { available: true }> => value.available);
  return {
    figure: available.length === 0 ? unavailable(missing) : figure(available.reduce((sum, v) => sum + v.value, 0)),
    contributing: available.length,
    total: values.length,
  };
}

export interface CampaignRollup {
  id: string;
  name: string;
  clientId: string;
  clientName: string;
  status: CampaignStatus;
  finance: CampaignFinance;
  health: HealthScore;
  recommendation: Recommendation;
}

export type AttentionSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface AttentionItem {
  severity: AttentionSeverity;
  kind: string;
  title: string;
  detail: string;
  campaignId?: string;
  clientId?: string;
  link?: string;
}

const SEVERITY_ORDER: Record<AttentionSeverity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

export interface ExecutiveOverview {
  currency: string;
  campaigns: { total: number; active: number };
  marketingSpend: Aggregate;
  attributedRevenue: Aggregate;
  grossProfit: Aggregate;
  contributionProfit: Aggregate;
  investment: Aggregate;
  conversions: Aggregate;
  roas: Figure;
  roi: Figure;
  cpa: Figure;
  budgetUtilization: Figure;
  health: HealthScore;
  attention: AttentionItem[];
}

/**
 * Portfolio health.
 *
 * Weighted by each campaign's ad spend, so the score tracks where the money is
 * rather than how many campaigns happen to exist. Campaigns whose own score is
 * INSUFFICIENT_DATA are excluded from the score and surfaced in the attention
 * list instead — they are a data problem, not a performance one.
 */
function portfolioHealth(rollups: CampaignRollup[]): HealthScore {
  const scored = rollups.filter((rollup) => rollup.health.score !== null);

  if (rollups.length === 0) {
    return {
      score: null,
      band: 'INSUFFICIENT_DATA',
      coverage: 0,
      components: [],
      explanation: 'No campaigns to report on yet.',
    };
  }

  const coverage = scored.length / rollups.length;
  if (scored.length === 0 || coverage < MIN_COVERAGE) {
    return {
      score: null,
      band: 'INSUFFICIENT_DATA',
      coverage,
      components: [],
      explanation: `Only ${scored.length} of ${rollups.length} campaigns have enough recorded data to score. Connect a platform or record results before reading a portfolio score.`,
    };
  }

  // Spend is the weight; a campaign with no spend recorded still counts, at
  // the smallest non-zero weight, so it cannot be silently dropped.
  const weightOf = (rollup: CampaignRollup) =>
    rollup.finance.adSpend.available && rollup.finance.adSpend.value > 0 ? rollup.finance.adSpend.value : 1;

  const totalWeight = scored.reduce((sum, rollup) => sum + weightOf(rollup), 0);
  const score = Math.round(
    scored.reduce((sum, rollup) => sum + (rollup.health.score ?? 0) * weightOf(rollup), 0) / totalWeight,
  );

  const band: HealthBand = bandFor(score);
  const worst = [...scored].sort((a, b) => (a.health.score ?? 0) - (b.health.score ?? 0))[0];

  return {
    score,
    band,
    coverage,
    components: [],
    explanation:
      `Spend-weighted across ${scored.length} of ${rollups.length} campaigns. ` +
      (worst ? `Lowest scoring: ${worst.name} at ${worst.health.score}/100.` : ''),
  };
}

/** Everything worth a CEO's attention, most severe first. */
export function attentionCenter(
  rollups: CampaignRollup[],
  extra: { pendingApprovals: number; upcoming: Array<{ id: string; name: string; startDate: Date }> },
): AttentionItem[] {
  const items: AttentionItem[] = [];

  for (const rollup of rollups) {
    const base = { campaignId: rollup.id, clientId: rollup.clientId, link: `/app/campaigns/${rollup.id}` };

    if (rollup.finance.budget.status === 'OVER_BUDGET') {
      items.push({
        ...base,
        severity: 'CRITICAL',
        kind: 'budget',
        title: `${rollup.name} is over budget`,
        detail: rollup.finance.budget.explanation,
      });
    } else if (rollup.finance.budget.status === 'AT_RISK') {
      items.push({
        ...base,
        severity: 'MEDIUM',
        kind: 'budget',
        title: `${rollup.name} is spending ahead of schedule`,
        detail: rollup.finance.budget.explanation,
      });
    }

    if (rollup.finance.roas.available && rollup.finance.roas.value < 1) {
      items.push({
        ...base,
        severity: 'CRITICAL',
        kind: 'roas',
        title: `${rollup.name} is below break-even`,
        detail: `ROAS ${rollup.finance.roas.value.toFixed(2)}x — the campaign returns less than it spends on media.`,
      });
    }

    const cpa = rollup.finance.targets.find((target) => target.metric === 'cpa');
    if (cpa?.status === 'BELOW_TARGET' && (cpa.delta ?? 0) < -0.25) {
      items.push({
        ...base,
        severity: 'HIGH',
        kind: 'cpa',
        title: `${rollup.name} is over its cost-per-acquisition target`,
        detail: `Actual ${cpa.actual.value?.toFixed(2)} against a target of ${cpa.target.value?.toFixed(2)}.`,
      });
    }

    if (rollup.finance.contributionProfit.available && rollup.finance.contributionProfit.value < 0) {
      items.push({
        ...base,
        severity: 'HIGH',
        kind: 'profit',
        title: `${rollup.name} is making a contribution loss`,
        detail: `Contribution profit ${rollup.finance.contributionProfit.value.toFixed(2)} ${rollup.finance.currency} once all costs are counted.`,
      });
    }

    if (rollup.health.band === 'INSUFFICIENT_DATA' && rollup.status === CampaignStatus.RUNNING) {
      items.push({
        ...base,
        severity: 'HIGH',
        kind: 'tracking',
        title: `${rollup.name} is running with no measurement`,
        detail: rollup.health.explanation,
      });
    }
  }

  if (extra.pendingApprovals > 0) {
    items.push({
      severity: extra.pendingApprovals > 5 ? 'MEDIUM' : 'LOW',
      kind: 'approvals',
      title: `${extra.pendingApprovals} item${extra.pendingApprovals === 1 ? '' : 's'} waiting for approval`,
      detail: 'Content cannot be scheduled until it is approved.',
      link: '/app/approvals',
    });
  }

  for (const campaign of extra.upcoming) {
    items.push({
      severity: 'LOW',
      kind: 'upcoming',
      title: `${campaign.name} starts soon`,
      detail: `Scheduled to start ${campaign.startDate.toISOString().slice(0, 10)}.`,
      campaignId: campaign.id,
      link: `/app/campaigns/${campaign.id}`,
    });
  }

  return items.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

export function executiveOverview(
  rollups: CampaignRollup[],
  extra: { pendingApprovals: number; upcoming: Array<{ id: string; name: string; startDate: Date }>; currency: string },
): ExecutiveOverview {
  const marketingSpend = sumOf(rollups.map((r) => r.finance.adSpend), 'No advertising spend recorded on any campaign');
  const attributedRevenue = sumOf(rollups.map((r) => r.finance.attributedRevenue), 'No attributed revenue on any campaign');
  const grossProfit = sumOf(rollups.map((r) => r.finance.grossProfit), 'Gross profit needs recorded revenue and cost of goods');
  const contributionProfit = sumOf(rollups.map((r) => r.finance.contributionProfit), 'Contribution profit needs gross profit and campaign costs');
  const investment = sumOf(rollups.map((r) => r.finance.investment), 'No campaign costs or spend recorded');
  const conversions = sumOf(rollups.map((r) => r.finance.conversions), 'No conversions recorded on any campaign');

  const budgets = rollups.map((r) => r.finance.budget.budget).reduce((sum, value) => sum + value, 0);

  return {
    currency: extra.currency,
    campaigns: {
      total: rollups.length,
      active: rollups.filter((r) => r.status === CampaignStatus.RUNNING).length,
    },
    marketingSpend,
    attributedRevenue,
    grossProfit,
    contributionProfit,
    investment,
    conversions,
    // Recomputed from the totals, never averaged across campaigns.
    roas: ratio(attributedRevenue.figure, marketingSpend.figure, 'No advertising spend recorded, so ROAS has no denominator'),
    roi: ratio(contributionProfit.figure, investment.figure, 'No campaign investment recorded, so ROI has no denominator'),
    cpa: ratio(marketingSpend.figure, conversions.figure, 'No conversions recorded, so cost per acquisition has no denominator'),
    budgetUtilization:
      budgets > 0
        ? ratio(marketingSpend.figure, figure(budgets), 'No budget set across the portfolio')
        : unavailable('No budget set across the portfolio'),
    health: portfolioHealth(rollups),
    attention: attentionCenter(rollups, extra),
  };
}

/**
 * The executive brief, written from the figures that exist.
 *
 * This is a deliberate template rather than a model call. The brief is the one
 * place a hallucinated number would be read as a fact and acted on, so every
 * sentence here is generated from a figure that passed the `available` check
 * and nothing else. When too little is known it says so and stops.
 */
export function executiveBrief(overview: ExecutiveOverview, rollups: CampaignRollup[]): string[] {
  const lines: string[] = [];
  const money = (value: number) => `${value.toLocaleString('en-US', { maximumFractionDigits: 0 })} ${overview.currency}`;

  if (overview.campaigns.total === 0) {
    return ['No campaigns have been created yet, so there is nothing to report.'];
  }

  if (overview.health.score === null) {
    lines.push(`Insufficient data. ${overview.health.explanation}`);
  } else {
    lines.push(
      `Marketing health is ${overview.health.band.replace(/_/g, ' ').toLowerCase()} at ${overview.health.score}/100 across ${overview.campaigns.total} campaign${overview.campaigns.total === 1 ? '' : 's'}.`,
    );
  }

  if (overview.marketingSpend.figure.available) {
    const spend = `Marketing spend is ${money(overview.marketingSpend.figure.value)}`;
    lines.push(
      overview.attributedRevenue.figure.available && overview.roas.available
        ? `${spend}, returning ${money(overview.attributedRevenue.figure.value)} at ${overview.roas.value.toFixed(2)}x ROAS.`
        : `${spend}. No revenue is attributed to it yet, so return cannot be calculated.`,
    );
  }

  if (overview.contributionProfit.figure.available) {
    const value = overview.contributionProfit.figure.value;
    lines.push(
      `Contribution profit across ${overview.contributionProfit.contributing} of ${overview.contributionProfit.total} campaigns is ${money(value)}${value < 0 ? ' — a loss once every cost is counted.' : '.'}`,
    );
  } else {
    lines.push(`Profit cannot be calculated: ${overview.contributionProfit.figure.reason}.`);
  }

  // Best and worst by ROAS, only among campaigns that actually have one.
  const withRoas = rollups.filter((r) => r.finance.roas.available);
  if (withRoas.length > 1) {
    const sorted = [...withRoas].sort((a, b) => (b.finance.roas.value ?? 0) - (a.finance.roas.value ?? 0));
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    if (best && worst && best.id !== worst.id) {
      lines.push(
        `${best.name} is the strongest performer at ${best.finance.roas.value?.toFixed(2)}x; ${worst.name} is the weakest at ${worst.finance.roas.value?.toFixed(2)}x.`,
      );
    }
  }

  const critical = overview.attention.filter((item) => item.severity === 'CRITICAL');
  if (critical.length > 0) {
    lines.push(`${critical.length} issue${critical.length === 1 ? '' : 's'} need immediate attention: ${critical.map((item) => item.title).join('; ')}.`);
  }

  const topAction = rollups
    .filter((rollup) => rollup.recommendation.priority === 'CRITICAL' || rollup.recommendation.priority === 'HIGH')
    .sort(
      (a, b) => SEVERITY_ORDER[a.recommendation.priority] - SEVERITY_ORDER[b.recommendation.priority],
    )[0];
  if (topAction) {
    lines.push(`Recommendation: ${topAction.recommendation.suggestedAction} (${topAction.name}).`);
  } else if (overview.health.score !== null && overview.health.score >= 70) {
    lines.push('Recommendation: no urgent action. Keep the current plan and review at the next reporting point.');
  }

  return lines;
}

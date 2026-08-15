/**
 * Campaign cost, financial and performance engine.
 *
 * Every number a CEO would act on is derived here, from rows that exist. The
 * one rule the whole module is built around: **a figure that cannot be computed
 * is reported as unavailable with the reason, never as zero.**
 *
 * That rule is not decoration. Zero revenue and unknown revenue lead to
 * opposite decisions — the first says "kill this campaign", the second says
 * "connect your POS" — and a zero-filled default makes the two impossible to
 * tell apart on a dashboard. So the return type of every derived figure is
 * `Figure`, which is either a value or a reason it is missing, and the UI is
 * obliged to handle both.
 *
 * The three money concepts the brief insists on keeping apart:
 *
 *   budget         what was authorised to be spent on media
 *   ad spend       what has actually been spent on media
 *   campaign cost  ad spend *plus* creative, photography, management, fees…
 *
 * ROAS is measured against ad spend, because that is what the ad platforms
 * bought. ROI is measured against total campaign investment, because that is
 * what the business actually paid. Using one denominator for both is the most
 * common way these reports end up flattering.
 */

import { CostCategory, CostKind, Prisma } from '@prisma/client';

// ---------------------------------------------------------------- figures

/** A derived number, or an explicit statement that it cannot be derived. */
export type Figure =
  | { available: true; value: number }
  | { available: false; value: null; reason: string };

export const figure = (value: number): Figure => ({ available: true, value });
export const unavailable = (reason: string): Figure => ({ available: false, value: null, reason });

/**
 * Divide, refusing rather than guessing.
 *
 * A zero denominator is the interesting case: 0 revenue on 0 spend is not a
 * ROAS of 0, it is the absence of a ratio, and reporting 0 would show a
 * campaign that has not started yet as the worst performer on the dashboard.
 */
export function ratio(numerator: Figure, denominator: Figure, whenZero: string): Figure {
  if (!numerator.available) return numerator;
  if (!denominator.available) return denominator;
  if (denominator.value === 0) return unavailable(whenZero);
  return figure(numerator.value / denominator.value);
}

const toNumber = (value: Prisma.Decimal | number | null | undefined): number | null =>
  value === null || value === undefined ? null : typeof value === 'number' ? value : Number(value.toString());

/** A recorded amount, or the reason it is missing. */
const recorded = (value: Prisma.Decimal | number | null | undefined, missing: string): Figure => {
  const parsed = toNumber(value);
  return parsed === null ? unavailable(missing) : figure(parsed);
};

// ---------------------------------------------------------------- inputs

export interface CostRow {
  kind: CostKind;
  category: CostCategory;
  amount: Prisma.Decimal | number;
}

export interface FinanceInput {
  budget: Prisma.Decimal | number;
  currency: string;
  startDate: Date;
  endDate: Date;
  grossRevenue?: Prisma.Decimal | number | null;
  discounts?: Prisma.Decimal | number | null;
  cogs?: Prisma.Decimal | number | null;
  targetCpa?: Prisma.Decimal | number | null;
  targetRoas?: Prisma.Decimal | number | null;
  targetRevenue?: Prisma.Decimal | number | null;
  targetConversions?: number | null;
  costs: CostRow[];
  /** Totals already aggregated from AnalyticsSnapshot rows for this campaign. */
  performance: {
    hasSnapshots: boolean;
    spend: number;
    revenue: number;
    conversions: number;
    clicks: number;
    impressions: number;
  };
}

// ---------------------------------------------------------------- costs

export interface CostBreakdown {
  category: CostCategory;
  planned: number;
  actual: number;
  variance: number;
}

export interface CostSummary {
  planned: Figure;
  actual: Figure;
  breakdown: CostBreakdown[];
}

const CATEGORIES = Object.values(CostCategory);

export function summariseCosts(costs: CostRow[]): CostSummary {
  const planned = new Map<CostCategory, number>();
  const actual = new Map<CostCategory, number>();

  for (const cost of costs) {
    const target = cost.kind === CostKind.PLANNED ? planned : actual;
    target.set(cost.category, (target.get(cost.category) ?? 0) + (toNumber(cost.amount) ?? 0));
  }

  const breakdown = CATEGORIES.filter((category) => planned.has(category) || actual.has(category)).map(
    (category) => {
      const plannedValue = planned.get(category) ?? 0;
      const actualValue = actual.get(category) ?? 0;
      return { category, planned: plannedValue, actual: actualValue, variance: actualValue - plannedValue };
    },
  );

  const sum = (map: Map<CostCategory, number>) => [...map.values()].reduce((a, b) => a + b, 0);

  return {
    // "No planned lines" is a real state — a campaign nobody costed — and is
    // not the same as a plan that came to zero.
    planned: planned.size === 0 ? unavailable('No planned cost lines recorded') : figure(sum(planned)),
    actual: actual.size === 0 ? unavailable('No actual cost lines recorded') : figure(sum(actual)),
    breakdown,
  };
}

// ---------------------------------------------------------------- budget

export type BudgetStatus = 'UNDER_BUDGET' | 'ON_TRACK' | 'AT_RISK' | 'OVER_BUDGET' | 'NO_DATA';

export interface BudgetHealth {
  budget: number;
  spend: Figure;
  remaining: Figure;
  utilization: Figure;
  /** Share of the campaign's calendar that has passed, 0–1. */
  elapsed: Figure;
  status: BudgetStatus;
  explanation: string;
}

/**
 * Budget health, paced against the calendar rather than against a flat
 * threshold. 87% spent is healthy in the last week of a campaign and alarming
 * in the first — a fixed cutoff cannot tell those apart, and would cry wolf on
 * every campaign that is simply nearly finished.
 */
export function budgetHealth(input: FinanceInput, adSpend: Figure, now: Date): BudgetHealth {
  const budget = toNumber(input.budget) ?? 0;

  const total = input.endDate.getTime() - input.startDate.getTime();
  const elapsed: Figure =
    total <= 0
      ? unavailable('Campaign start and end fall on the same moment')
      : figure(Math.min(Math.max((now.getTime() - input.startDate.getTime()) / total, 0), 1));

  if (!adSpend.available) {
    return {
      budget,
      spend: adSpend,
      remaining: adSpend,
      utilization: adSpend,
      elapsed,
      status: 'NO_DATA',
      explanation: adSpend.reason,
    };
  }
  if (budget <= 0) {
    const reason = 'No budget set for this campaign';
    return {
      budget,
      spend: adSpend,
      remaining: unavailable(reason),
      utilization: unavailable(reason),
      elapsed,
      status: 'NO_DATA',
      explanation: reason,
    };
  }

  const utilization = adSpend.value / budget;
  const remaining = budget - adSpend.value;

  let status: BudgetStatus;
  let explanation: string;
  const pct = (value: number) => `${Math.round(value * 100)}%`;

  if (utilization > 1) {
    status = 'OVER_BUDGET';
    explanation = `Spent ${pct(utilization)} of budget — ${pct(utilization - 1)} over.`;
  } else if (!elapsed.available) {
    // Without a pace to compare against, fall back to the flat reading.
    status = utilization >= 0.9 ? 'AT_RISK' : 'ON_TRACK';
    explanation = `Spent ${pct(utilization)} of budget.`;
  } else if (utilization - elapsed.value > 0.15) {
    status = 'AT_RISK';
    explanation = `Spending ahead of schedule: ${pct(utilization)} of budget used with ${pct(elapsed.value)} of the campaign elapsed.`;
  } else if (utilization + 0.15 < elapsed.value) {
    status = 'UNDER_BUDGET';
    explanation = `Underspending: ${pct(utilization)} of budget used with ${pct(elapsed.value)} of the campaign elapsed.`;
  } else {
    status = 'ON_TRACK';
    explanation = `Spent ${pct(utilization)} of budget with ${pct(elapsed.value)} of the campaign elapsed.`;
  }

  return { budget, spend: adSpend, remaining: figure(remaining), utilization: figure(utilization), elapsed, status, explanation };
}

// ---------------------------------------------------------------- targets

export type TargetStatus = 'BEATING_TARGET' | 'ON_TARGET' | 'BELOW_TARGET' | 'NO_DATA';

export interface TargetComparison {
  metric: 'cpa' | 'roas' | 'revenue' | 'conversions';
  target: Figure;
  actual: Figure;
  status: TargetStatus;
  /** Signed share away from target; negative is worse. Null when NO_DATA. */
  delta: number | null;
}

/** Within this band either side of target counts as hitting it. */
const ON_TARGET_BAND = 0.05;

function compare(
  metric: TargetComparison['metric'],
  target: Figure,
  actual: Figure,
  direction: 'higher-is-better' | 'lower-is-better',
): TargetComparison {
  if (!target.available || !actual.available) {
    return { metric, target, actual, status: 'NO_DATA', delta: null };
  }
  if (target.value === 0) {
    return { metric, target, actual, status: 'NO_DATA', delta: null };
  }

  const raw = (actual.value - target.value) / Math.abs(target.value);
  // For CPA a lower number is the better outcome, so the sign is flipped to
  // keep "positive delta means doing well" true for every metric.
  const delta = direction === 'lower-is-better' ? -raw : raw;

  const status: TargetStatus =
    Math.abs(delta) <= ON_TARGET_BAND ? 'ON_TARGET' : delta > 0 ? 'BEATING_TARGET' : 'BELOW_TARGET';

  return { metric, target, actual, status, delta };
}

// ---------------------------------------------------------------- engine

export interface CampaignFinance {
  currency: string;
  costs: CostSummary;
  /** Media spend only. */
  adSpend: Figure;
  adSpendSource: 'snapshots' | 'cost-lines' | 'none';
  /** Ad spend plus every other recorded cost. */
  investment: Figure;
  investmentSource: 'complete' | 'cost-lines' | 'ad-spend-only' | 'none';
  attributedRevenue: Figure;
  grossRevenue: Figure;
  grossRevenueSource: 'recorded' | 'attributed' | 'none';
  discounts: Figure;
  netRevenue: Figure;
  cogs: Figure;
  grossProfit: Figure;
  contributionProfit: Figure;
  roas: Figure;
  roi: Figure;
  cpa: Figure;
  cpc: Figure;
  cpm: Figure;
  conversions: Figure;
  budget: BudgetHealth;
  targets: TargetComparison[];
}

export function computeCampaignFinance(input: FinanceInput, now: Date = new Date()): CampaignFinance {
  const costs = summariseCosts(input.costs);

  // --- ad spend --------------------------------------------------------
  // Snapshots are the better source because they come from the platforms.
  // Advertising cost lines are the fallback for a campaign whose spend is
  // recorded by hand. Which one was used is reported, never hidden.
  const advertisingActual = input.costs
    .filter((cost) => cost.kind === CostKind.ACTUAL && cost.category === CostCategory.ADVERTISING)
    .reduce((total, cost) => total + (toNumber(cost.amount) ?? 0), 0);
  const hasAdvertisingLines = input.costs.some(
    (cost) => cost.kind === CostKind.ACTUAL && cost.category === CostCategory.ADVERTISING,
  );

  let adSpend: Figure;
  let adSpendSource: CampaignFinance['adSpendSource'];
  if (input.performance.hasSnapshots) {
    adSpend = figure(input.performance.spend);
    adSpendSource = 'snapshots';
  } else if (hasAdvertisingLines) {
    adSpend = figure(advertisingActual);
    adSpendSource = 'cost-lines';
  } else {
    adSpend = unavailable('No platform data and no advertising cost lines recorded');
    adSpendSource = 'none';
  }

  // --- investment ------------------------------------------------------
  /*
   * Total investment is ad spend *plus* every non-advertising cost line.
   *
   * Both halves are needed and neither may be double counted, which is subtler
   * than it looks. Taking the cost lines alone drops media spend entirely
   * whenever it arrives from the platforms rather than as a typed-in invoice —
   * a campaign with 4,737 of ad spend and one 1,200 photography line would show
   * an investment of 1,200 and an ROI several times too flattering. Adding the
   * two totals blindly is the mirror failure: if somebody records advertising
   * as a cost line *and* the platform reports it, the same money is counted
   * twice. So advertising is excluded from the cost-line side and taken solely
   * from `adSpend`, which already picked the better of the two sources.
   */
  const nonAdvertisingActual = input.costs
    .filter((cost) => cost.kind === CostKind.ACTUAL && cost.category !== CostCategory.ADVERTISING)
    .reduce((total, cost) => total + (toNumber(cost.amount) ?? 0), 0);
  const hasNonAdvertisingLines = input.costs.some(
    (cost) => cost.kind === CostKind.ACTUAL && cost.category !== CostCategory.ADVERTISING,
  );

  let investment: Figure;
  let investmentSource: CampaignFinance['investmentSource'];
  if (adSpend.available && hasNonAdvertisingLines) {
    investment = figure(adSpend.value + nonAdvertisingActual);
    investmentSource = 'complete';
  } else if (adSpend.available) {
    // Honest but partial: media spend is a floor for what the campaign cost.
    investment = adSpend;
    investmentSource = 'ad-spend-only';
  } else if (hasNonAdvertisingLines) {
    investment = figure(nonAdvertisingActual);
    investmentSource = 'cost-lines';
  } else {
    investment = unavailable('No cost lines and no recorded spend');
    investmentSource = 'none';
  }

  // --- revenue ---------------------------------------------------------
  const attributedRevenue: Figure = input.performance.hasSnapshots
    ? figure(input.performance.revenue)
    : unavailable('No platform or imported conversion data for this campaign');

  const recordedGross = recorded(input.grossRevenue, 'Gross revenue not recorded');
  let grossRevenue: Figure;
  let grossRevenueSource: CampaignFinance['grossRevenueSource'];
  if (recordedGross.available) {
    grossRevenue = recordedGross;
    grossRevenueSource = 'recorded';
  } else if (attributedRevenue.available) {
    grossRevenue = attributedRevenue;
    grossRevenueSource = 'attributed';
  } else {
    grossRevenue = unavailable('No revenue recorded and none attributed');
    grossRevenueSource = 'none';
  }

  // An unrecorded discount really is no discount; unlike COGS, absence here
  // carries a safe meaning and does not distort the figure.
  const discountAmount = toNumber(input.discounts) ?? 0;
  const discounts = figure(discountAmount);
  const netRevenue: Figure = grossRevenue.available
    ? figure(grossRevenue.value - discountAmount)
    : unavailable(grossRevenue.reason);

  const cogs = recorded(input.cogs, 'Cost of goods sold not recorded — gross profit cannot be calculated');
  const grossProfit: Figure =
    netRevenue.available && cogs.available ? figure(netRevenue.value - cogs.value) : netRevenue.available ? cogs : netRevenue;

  const contributionProfit: Figure =
    grossProfit.available && investment.available
      ? figure(grossProfit.value - investment.value)
      : grossProfit.available
        ? investment
        : grossProfit;

  // --- ratios ----------------------------------------------------------
  const conversions: Figure = input.performance.hasSnapshots
    ? figure(input.performance.conversions)
    : unavailable('No conversion data recorded');

  const roas = ratio(attributedRevenue, adSpend, 'No advertising spend recorded, so ROAS has no denominator');
  const roi = ratio(contributionProfit, investment, 'No campaign investment recorded, so ROI has no denominator');
  const cpa = ratio(adSpend, conversions, 'No conversions recorded, so cost per acquisition has no denominator');
  const cpc = ratio(
    adSpend,
    input.performance.hasSnapshots ? figure(input.performance.clicks) : unavailable('No click data recorded'),
    'No clicks recorded, so cost per click has no denominator',
  );
  const cpm = ratio(
    adSpend.available ? figure(adSpend.value * 1000) : adSpend,
    input.performance.hasSnapshots ? figure(input.performance.impressions) : unavailable('No impression data recorded'),
    'No impressions recorded, so cost per mille has no denominator',
  );

  return {
    currency: input.currency,
    costs,
    adSpend,
    adSpendSource,
    investment,
    investmentSource,
    attributedRevenue,
    grossRevenue,
    grossRevenueSource,
    discounts,
    netRevenue,
    cogs,
    grossProfit,
    contributionProfit,
    roas,
    roi,
    cpa,
    cpc,
    cpm,
    conversions,
    budget: budgetHealth(input, adSpend, now),
    targets: [
      compare('cpa', recorded(input.targetCpa, 'No target CPA set'), cpa, 'lower-is-better'),
      compare('roas', recorded(input.targetRoas, 'No target ROAS set'), roas, 'higher-is-better'),
      compare('revenue', recorded(input.targetRevenue, 'No target revenue set'), grossRevenue, 'higher-is-better'),
      compare(
        'conversions',
        recorded(input.targetConversions, 'No target conversion count set'),
        conversions,
        'higher-is-better',
      ),
    ],
  };
}

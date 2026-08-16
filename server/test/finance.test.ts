/**
 * Campaign finance, health and recommendation engine.
 *
 * These are pure functions over plain inputs, so the suite drives them
 * directly rather than through HTTP — the arithmetic is the thing under test,
 * and a round trip would only add ways for the test to fail for other reasons.
 *
 * The cases that matter most are the *absent* ones. A regression that turns a
 * missing figure back into a confident zero would still produce a working
 * dashboard, and would still be wrong in the way that gets a budget cut, so
 * every derived figure has a test pinning what it does when its input is gone.
 */

import { describe, expect, it } from 'vitest';
import { CampaignStatus, CostCategory, CostKind } from '@prisma/client';

import {
  budgetHealth,
  computeCampaignFinance,
  figure,
  ratio,
  summariseCosts,
  unavailable,
  type FinanceInput,
} from '../src/services/finance.js';
import { campaignHealth, recommend, bandFor, MIN_COVERAGE } from '../src/services/campaign-health.js';
import { executiveBrief, executiveOverview, type CampaignRollup } from '../src/services/ceo.js';

const START = new Date('2026-08-01T00:00:00.000Z');
const END = new Date('2026-08-31T00:00:00.000Z');
/** Halfway through the campaign, so pacing is exactly 50%. */
const MIDPOINT = new Date('2026-08-16T00:00:00.000Z');

function input(overrides: Partial<FinanceInput> = {}): FinanceInput {
  return {
    budget: 10_000,
    currency: 'SAR',
    startDate: START,
    endDate: END,
    costs: [],
    performance: { hasSnapshots: false, spend: 0, revenue: 0, conversions: 0, clicks: 0, impressions: 0 },
    ...overrides,
  };
}

const perf = (over: Partial<FinanceInput['performance']> = {}): FinanceInput['performance'] => ({
  hasSnapshots: true,
  spend: 0,
  revenue: 0,
  conversions: 0,
  clicks: 0,
  impressions: 0,
  ...over,
});

describe('figures never fabricate', () => {
  it('refuses to divide by zero instead of reporting a ratio of zero', () => {
    const result = ratio(figure(500), figure(0), 'no denominator');
    expect(result.available).toBe(false);
    expect(result.value).toBeNull();
    expect(result.available === false && result.reason).toBe('no denominator');
  });

  it('propagates the reason from an unavailable numerator', () => {
    const result = ratio(unavailable('no revenue recorded'), figure(10), 'no denominator');
    expect(result.available === false && result.reason).toBe('no revenue recorded');
  });

  it('reports ROAS as unavailable when nothing has been spent, not as 0x', () => {
    const finance = computeCampaignFinance(input(), MIDPOINT);
    expect(finance.roas.available).toBe(false);
    expect(finance.roas.value).toBeNull();
  });

  it('reports gross profit as unavailable when cost of goods is not recorded', () => {
    const finance = computeCampaignFinance(
      input({ grossRevenue: 40_000, performance: perf({ spend: 5_000, revenue: 40_000 }) }),
      MIDPOINT,
    );
    expect(finance.netRevenue.value).toBe(40_000);
    expect(finance.grossProfit.available).toBe(false);
    expect(finance.grossProfit.available === false && finance.grossProfit.reason).toMatch(/cost of goods/i);
    // And the figure that depends on it must not quietly become a number.
    expect(finance.contributionProfit.available).toBe(false);
  });
});

describe('cost engine', () => {
  it('keeps planned and actual apart and reports variance per category', () => {
    const summary = summariseCosts([
      { kind: CostKind.PLANNED, category: CostCategory.ADVERTISING, amount: 8_000 },
      { kind: CostKind.PLANNED, category: CostCategory.PHOTOGRAPHY, amount: 1_500 },
      { kind: CostKind.ACTUAL, category: CostCategory.ADVERTISING, amount: 8_700 },
      { kind: CostKind.ACTUAL, category: CostCategory.PHOTOGRAPHY, amount: 1_200 },
      { kind: CostKind.ACTUAL, category: CostCategory.MANAGEMENT, amount: 900 },
    ]);

    expect(summary.planned.value).toBe(9_500);
    expect(summary.actual.value).toBe(10_800);

    const advertising = summary.breakdown.find((row) => row.category === CostCategory.ADVERTISING);
    expect(advertising).toMatchObject({ planned: 8_000, actual: 8_700, variance: 700 });

    // A category with actuals but no plan still appears, with its plan at zero.
    const management = summary.breakdown.find((row) => row.category === CostCategory.MANAGEMENT);
    expect(management).toMatchObject({ planned: 0, actual: 900, variance: 900 });
  });

  it('distinguishes "no lines recorded" from "lines totalling zero"', () => {
    expect(summariseCosts([]).planned.available).toBe(false);
    expect(summariseCosts([{ kind: CostKind.PLANNED, category: CostCategory.OTHER, amount: 0 }]).planned).toEqual({
      available: true,
      value: 0,
    });
  });

  it('separates ad spend from total campaign cost', () => {
    const finance = computeCampaignFinance(
      input({
        performance: perf({ spend: 8_700, revenue: 30_000 }),
        costs: [
          { kind: CostKind.ACTUAL, category: CostCategory.ADVERTISING, amount: 8_700 },
          { kind: CostKind.ACTUAL, category: CostCategory.PHOTOGRAPHY, amount: 1_200 },
          { kind: CostKind.ACTUAL, category: CostCategory.MANAGEMENT, amount: 900 },
        ],
      }),
      MIDPOINT,
    );

    expect(finance.adSpend.value).toBe(8_700);
    expect(finance.investment.value).toBe(10_800);
    expect(finance.investmentSource).toBe('complete');
    // ROAS is measured on media spend, ROI on the whole investment.
    expect(finance.roas.value).toBeCloseTo(30_000 / 8_700, 6);
  });

  it('adds platform ad spend to non-advertising cost lines without double counting', () => {
    // The case that broke on real data: media spend arrives from the platform
    // while only a photography invoice is typed in as a cost line. Counting the
    // lines alone dropped the 4,737 of media entirely and inflated ROI.
    const finance = computeCampaignFinance(
      input({
        performance: perf({ spend: 4_737, revenue: 38_000, conversions: 300 }),
        costs: [{ kind: CostKind.ACTUAL, category: CostCategory.PHOTOGRAPHY, amount: 1_200 }],
      }),
      MIDPOINT,
    );

    expect(finance.adSpend.value).toBe(4_737);
    expect(finance.investment.value).toBe(5_937);
    expect(finance.investmentSource).toBe('complete');
  });

  it('counts advertising once when it is both reported and recorded by hand', () => {
    // Platform says 5,000; someone also typed a 5,000 advertising line. The
    // money was spent once and must be counted once.
    const finance = computeCampaignFinance(
      input({
        performance: perf({ spend: 5_000, revenue: 20_000, conversions: 100 }),
        costs: [
          { kind: CostKind.ACTUAL, category: CostCategory.ADVERTISING, amount: 5_000 },
          { kind: CostKind.ACTUAL, category: CostCategory.MANAGEMENT, amount: 800 },
        ],
      }),
      MIDPOINT,
    );

    expect(finance.adSpend.value).toBe(5_000);
    expect(finance.investment.value).toBe(5_800);
  });

  it('uses non-advertising lines alone when nothing reports media spend', () => {
    const finance = computeCampaignFinance(
      input({ costs: [{ kind: CostKind.ACTUAL, category: CostCategory.CREATIVE, amount: 900 }] }),
      MIDPOINT,
    );
    expect(finance.investment.value).toBe(900);
    expect(finance.investmentSource).toBe('cost-lines');
  });

  it('falls back to advertising cost lines when no platform data exists, and says so', () => {
    const finance = computeCampaignFinance(
      input({ costs: [{ kind: CostKind.ACTUAL, category: CostCategory.ADVERTISING, amount: 4_000 }] }),
      MIDPOINT,
    );
    expect(finance.adSpendSource).toBe('cost-lines');
    expect(finance.adSpend.value).toBe(4_000);
  });
});

describe('financial engine', () => {
  it('computes the full chain from gross revenue to contribution profit', () => {
    const finance = computeCampaignFinance(
      input({
        grossRevenue: 50_000,
        discounts: 5_000,
        cogs: 18_000,
        performance: perf({ spend: 9_000, revenue: 46_000, conversions: 300, clicks: 4_000, impressions: 500_000 }),
        costs: [
          { kind: CostKind.ACTUAL, category: CostCategory.ADVERTISING, amount: 9_000 },
          { kind: CostKind.ACTUAL, category: CostCategory.MANAGEMENT, amount: 2_000 },
        ],
      }),
      MIDPOINT,
    );

    expect(finance.netRevenue.value).toBe(45_000);
    expect(finance.grossProfit.value).toBe(27_000);
    expect(finance.investment.value).toBe(11_000);
    expect(finance.contributionProfit.value).toBe(16_000);
    expect(finance.roi.value).toBeCloseTo(16_000 / 11_000, 6);
    expect(finance.cpa.value).toBeCloseTo(9_000 / 300, 6);
    expect(finance.cpc.value).toBeCloseTo(9_000 / 4_000, 6);
    expect(finance.cpm.value).toBeCloseTo((9_000 * 1000) / 500_000, 6);
  });

  it('prefers recorded revenue over attributed revenue and reports which was used', () => {
    const attributed = computeCampaignFinance(
      input({ performance: perf({ spend: 1_000, revenue: 3_000 }) }),
      MIDPOINT,
    );
    expect(attributed.grossRevenueSource).toBe('attributed');
    expect(attributed.grossRevenue.value).toBe(3_000);

    const recorded = computeCampaignFinance(
      input({ grossRevenue: 12_000, performance: perf({ spend: 1_000, revenue: 3_000 }) }),
      MIDPOINT,
    );
    expect(recorded.grossRevenueSource).toBe('recorded');
    expect(recorded.grossRevenue.value).toBe(12_000);
    // ROAS still uses attributed revenue — it measures what the ads returned.
    expect(recorded.roas.value).toBeCloseTo(3, 6);
  });
});

describe('budget health', () => {
  it('reads 87% spent at 87% elapsed as on track, not as at risk', () => {
    const elapsed87 = new Date(START.getTime() + (END.getTime() - START.getTime()) * 0.87);
    const health = budgetHealth(input(), figure(8_700), elapsed87);
    expect(health.utilization.value).toBeCloseTo(0.87, 6);
    expect(health.status).toBe('ON_TRACK');
  });

  it('flags spending well ahead of the calendar', () => {
    expect(budgetHealth(input(), figure(8_700), MIDPOINT).status).toBe('AT_RISK');
  });

  it('flags underspending', () => {
    expect(budgetHealth(input(), figure(1_000), MIDPOINT).status).toBe('UNDER_BUDGET');
  });

  it('flags overspending regardless of pace', () => {
    const health = budgetHealth(input(), figure(11_000), END);
    expect(health.status).toBe('OVER_BUDGET');
    expect(health.remaining.value).toBe(-1_000);
  });

  it('reports NO_DATA rather than 0% when spend is unknown', () => {
    const health = budgetHealth(input(), unavailable('nothing recorded'), MIDPOINT);
    expect(health.status).toBe('NO_DATA');
    expect(health.utilization.value).toBeNull();
  });
});

describe('performance against target', () => {
  const withTargets = (over: Partial<FinanceInput>) =>
    computeCampaignFinance(
      input({ targetCpa: 30, targetRoas: 4, targetRevenue: 50_000, targetConversions: 400, ...over }),
      MIDPOINT,
    );

  const status = (finance: ReturnType<typeof withTargets>, metric: string) =>
    finance.targets.find((target) => target.metric === metric)?.status;

  it('treats a result within 5% of target as on target', () => {
    const finance = withTargets({ performance: perf({ spend: 3_100, revenue: 12_400, conversions: 100 }) });
    expect(status(finance, 'cpa')).toBe('ON_TARGET');
  });

  it('recognises beating a lower-is-better target', () => {
    const finance = withTargets({ performance: perf({ spend: 2_000, revenue: 12_000, conversions: 100 }) });
    expect(status(finance, 'cpa')).toBe('BEATING_TARGET');
    expect(status(finance, 'roas')).toBe('BEATING_TARGET');
  });

  it('recognises missing a higher-is-better target', () => {
    const finance = withTargets({ performance: perf({ spend: 5_000, revenue: 5_000, conversions: 50 }) });
    expect(status(finance, 'roas')).toBe('BELOW_TARGET');
    expect(status(finance, 'cpa')).toBe('BELOW_TARGET');
  });

  it('reports NO_DATA when no target was set', () => {
    const finance = computeCampaignFinance(
      input({ performance: perf({ spend: 1_000, revenue: 5_000, conversions: 20 }) }),
      MIDPOINT,
    );
    expect(status(finance, 'roas')).toBe('NO_DATA');
  });
});

// ---------------------------------------------------------------- health

const brief = (over: Partial<Parameters<typeof campaignHealth>[0]['brief']> = {}) => ({
  hasObjective: true,
  hasAudience: true,
  hasOffer: true,
  hasLandingPage: true,
  hasCta: true,
  hasStrategy: true,
  ...over,
});

describe('campaign health score', () => {
  it('refuses to publish a score when almost nothing is measurable', () => {
    const finance = computeCampaignFinance(input(), MIDPOINT);
    const health = campaignHealth({
      status: CampaignStatus.RUNNING,
      finance,
      brief: brief(),
      content: { total: 0, approved: 0 },
    });

    // Brief and tracking are always judgeable; everything else is missing.
    expect(health.coverage).toBeLessThan(MIN_COVERAGE);
    expect(health.score).toBeNull();
    expect(health.band).toBe('INSUFFICIENT_DATA');
  });

  it('scores a well-measured, well-performing campaign highly', () => {
    const finance = computeCampaignFinance(
      input({
        targetCpa: 30,
        targetRoas: 4,
        grossRevenue: 60_000,
        cogs: 20_000,
        performance: perf({ spend: 5_000, revenue: 30_000, conversions: 250, clicks: 3_000, impressions: 400_000 }),
        costs: [{ kind: CostKind.ACTUAL, category: CostCategory.ADVERTISING, amount: 5_000 }],
      }),
      new Date(START.getTime() + (END.getTime() - START.getTime()) * 0.5),
    );

    const health = campaignHealth({
      status: CampaignStatus.RUNNING,
      finance,
      brief: brief(),
      content: { total: 10, approved: 9 },
    });

    expect(health.score).not.toBeNull();
    expect(health.coverage).toBeGreaterThanOrEqual(MIN_COVERAGE);
    expect(health.band === 'EXCELLENT' || health.band === 'HEALTHY').toBe(true);
  });

  it('never scores a component it has no data for', () => {
    const finance = computeCampaignFinance(
      input({ performance: perf({ spend: 5_000, revenue: 20_000, conversions: 100 }) }),
      MIDPOINT,
    );
    const health = campaignHealth({
      status: CampaignStatus.RUNNING,
      finance,
      brief: brief(),
      content: { total: 0, approved: 0 },
    });

    expect(health.components.find((c) => c.key === 'content')?.score).toBeNull();
    // No target and no universally "good" value, so CPA stays unjudged.
    expect(health.components.find((c) => c.key === 'cpa')?.score).toBeNull();
    expect(health.components.find((c) => c.key === 'tracking')?.score).toBe(100);
  });

  it('still scores a measured campaign that has no targets set', () => {
    // The common real case: platform data is flowing, nobody set a target.
    // Return has an absolute anchor (break-even), so this must not collapse
    // to INSUFFICIENT_DATA the way a target-only rule would make it.
    const finance = computeCampaignFinance(
      input({ performance: perf({ spend: 5_000, revenue: 41_000, conversions: 400, clicks: 3_000, impressions: 200_000 }) }),
      new Date(START.getTime() + (END.getTime() - START.getTime()) * 0.5),
    );
    const health = campaignHealth({
      status: CampaignStatus.RUNNING,
      finance,
      brief: brief(),
      content: { total: 5, approved: 5 },
    });

    expect(finance.roas.value).toBeCloseTo(8.2, 1);
    expect(health.score).not.toBeNull();
    expect(health.band).not.toBe('INSUFFICIENT_DATA');
    expect(health.components.find((c) => c.key === 'roas')?.detail).toMatch(/no target set/i);
  });

  it('scores below break-even poorly even with no target', () => {
    const finance = computeCampaignFinance(
      input({ performance: perf({ spend: 5_000, revenue: 2_000, conversions: 20 }) }),
      MIDPOINT,
    );
    const health = campaignHealth({
      status: CampaignStatus.RUNNING,
      finance,
      brief: brief(),
      content: { total: 5, approved: 5 },
    });
    expect(health.components.find((c) => c.key === 'roas')?.score).toBeLessThan(40);
  });

  it('maps scores onto the documented bands', () => {
    expect(bandFor(90)).toBe('EXCELLENT');
    expect(bandFor(70)).toBe('HEALTHY');
    expect(bandFor(50)).toBe('NEEDS_ATTENTION');
    expect(bandFor(30)).toBe('AT_RISK');
    expect(bandFor(10)).toBe('CRITICAL');
  });
});

// ------------------------------------------------------- recommendations

function rollupFrom(over: Partial<FinanceInput>, name = 'Campaign', now = MIDPOINT): CampaignRollup {
  const finance = computeCampaignFinance(input(over), now);
  const health = campaignHealth({
    status: CampaignStatus.RUNNING,
    finance,
    brief: brief(),
    content: { total: 4, approved: 4 },
  });
  return {
    id: name.toLowerCase().replace(/\s+/g, '-'),
    name,
    clientId: 'client-1',
    clientName: 'Test Client',
    status: CampaignStatus.RUNNING,
    finance,
    health,
    recommendation: recommend({ finance, health, status: CampaignStatus.RUNNING }),
  };
}

describe('recommendation engine', () => {
  it('investigates rather than judging when there is no data', () => {
    const recommendation = rollupFrom({}).recommendation;
    expect(recommendation.action).toBe('INVESTIGATE');
    expect(recommendation.suggestedAction).toMatch(/connect|record/i);
  });

  it('pauses a campaign returning less than it spends', () => {
    const recommendation = rollupFrom({
      targetRoas: 4,
      performance: perf({ spend: 10_000, revenue: 4_000, conversions: 40 }),
    }).recommendation;
    expect(recommendation.action).toBe('PAUSE');
    expect(recommendation.priority).toBe('CRITICAL');
  });

  it('reduces an over-budget campaign ahead of any other finding', () => {
    const recommendation = rollupFrom({
      performance: perf({ spend: 12_000, revenue: 2_000, conversions: 10 }),
    }).recommendation;
    expect(recommendation.action).toBe('REDUCE');
  });

  it('carries the evidence it used', () => {
    const recommendation = rollupFrom({
      targetRoas: 4,
      performance: perf({ spend: 5_000, revenue: 2_000, conversions: 30 }),
    }).recommendation;
    expect(recommendation.evidence.some((line) => line.includes('ROAS'))).toBe(true);
  });
});

// ------------------------------------------------------------------ CEO

describe('executive overview', () => {
  const strong = () =>
    rollupFrom(
      {
        targetRoas: 3,
        targetCpa: 25,
        grossRevenue: 60_000,
        cogs: 20_000,
        performance: perf({ spend: 5_000, revenue: 30_000, conversions: 250, clicks: 2_000, impressions: 300_000 }),
        costs: [{ kind: CostKind.ACTUAL, category: CostCategory.ADVERTISING, amount: 5_000 }],
      },
      'Weekend Burger Promotion',
    );

  const weak = () =>
    rollupFrom(
      {
        targetRoas: 3,
        targetCpa: 25,
        grossRevenue: 4_000,
        cogs: 3_000,
        performance: perf({ spend: 4_000, revenue: 2_000, conversions: 20, clicks: 900, impressions: 120_000 }),
        costs: [{ kind: CostKind.ACTUAL, category: CostCategory.ADVERTISING, amount: 4_000 }],
      },
      'Coffee Awareness',
    );

  const empty = { pendingApprovals: 0, upcoming: [], currency: 'SAR' };

  it('recomputes portfolio ratios from totals rather than averaging them', () => {
    const overview = executiveOverview([strong(), weak()], empty);
    // 32,000 revenue over 9,000 spend — not the mean of 6.0x and 0.5x.
    expect(overview.roas.value).toBeCloseTo(32_000 / 9_000, 6);
    expect(overview.marketingSpend.figure.value).toBe(9_000);
  });

  it('reports how much of the portfolio a total covers', () => {
    const overview = executiveOverview([strong(), rollupFrom({}, 'Unmeasured')], empty);
    expect(overview.attributedRevenue.contributing).toBe(1);
    expect(overview.attributedRevenue.total).toBe(2);
  });

  it('surfaces a below-break-even campaign as critical', () => {
    const overview = executiveOverview([strong(), weak()], empty);
    const critical = overview.attention.filter((item) => item.severity === 'CRITICAL');
    expect(critical.some((item) => item.kind === 'roas')).toBe(true);
    // Sorted most severe first.
    expect(overview.attention[0]?.severity).toBe('CRITICAL');
  });

  it('surfaces a running campaign that has no measurement at all', () => {
    const overview = executiveOverview([rollupFrom({}, 'Unmeasured')], empty);
    expect(overview.attention.some((item) => item.kind === 'tracking')).toBe(true);
  });

  it('includes pending approvals and upcoming campaigns', () => {
    const overview = executiveOverview([strong()], {
      pendingApprovals: 3,
      upcoming: [{ id: 'c2', name: 'Ramadan Push', startDate: new Date('2026-09-01T00:00:00.000Z') }],
      currency: 'SAR',
    });
    expect(overview.attention.some((item) => item.kind === 'approvals')).toBe(true);
    expect(overview.attention.some((item) => item.kind === 'upcoming')).toBe(true);
  });

  it('withholds a portfolio score when too few campaigns are measurable', () => {
    const overview = executiveOverview([rollupFrom({}, 'A'), rollupFrom({}, 'B')], empty);
    expect(overview.health.score).toBeNull();
    expect(overview.health.band).toBe('INSUFFICIENT_DATA');
  });
});

describe('executive brief', () => {
  it('says so plainly when there is nothing to report', () => {
    const overview = executiveOverview([], { pendingApprovals: 0, upcoming: [], currency: 'SAR' });
    expect(executiveBrief(overview, [])).toEqual(['No campaigns have been created yet, so there is nothing to report.']);
  });

  it('states insufficient data rather than inventing a summary', () => {
    const rollups = [rollupFrom({}, 'A'), rollupFrom({}, 'B')];
    const overview = executiveOverview(rollups, { pendingApprovals: 0, upcoming: [], currency: 'SAR' });
    expect(executiveBrief(overview, rollups)[0]).toMatch(/insufficient data/i);
  });

  it('quotes only figures that exist', () => {
    const rollups = [
      rollupFrom(
        {
          targetRoas: 3,
          grossRevenue: 60_000,
          cogs: 20_000,
          performance: perf({ spend: 5_000, revenue: 30_000, conversions: 250 }),
          costs: [{ kind: CostKind.ACTUAL, category: CostCategory.ADVERTISING, amount: 5_000 }],
        },
        'Weekend Burger Promotion',
      ),
    ];
    const overview = executiveOverview(rollups, { pendingApprovals: 0, upcoming: [], currency: 'SAR' });
    const text = executiveBrief(overview, rollups).join(' ');

    expect(text).toContain('6.00x ROAS');
    expect(text).not.toMatch(/NaN|undefined|null/);
  });

  it('never quotes profit it cannot calculate', () => {
    const rollups = [
      rollupFrom({ targetRoas: 3, performance: perf({ spend: 5_000, revenue: 30_000, conversions: 250 }) }, 'No COGS'),
    ];
    const overview = executiveOverview(rollups, { pendingApprovals: 0, upcoming: [], currency: 'SAR' });
    const text = executiveBrief(overview, rollups).join(' ');
    expect(text).toMatch(/profit cannot be calculated/i);
  });
});

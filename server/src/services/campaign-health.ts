/**
 * Campaign health score and recommendation engine.
 *
 * The score is deliberately *not* an average over a fixed list of components.
 * Most campaigns are missing some of their inputs — no POS revenue, no targets
 * set, no platform connected — and scoring a missing input as zero would punish
 * a campaign for its owner's integrations rather than for its performance. A
 * campaign with no data would score 0 and sit at the top of the "at risk" list,
 * which is exactly the wrong place to send someone's attention.
 *
 * So each component scores only when its data exists, the score is the weighted
 * average over the components that *did* apply, and `coverage` reports how much
 * of the intended weight that was. Below `MIN_COVERAGE` no score is published at
 * all — the campaign is INSUFFICIENT_DATA, and the honest recommendation is to
 * go and connect something rather than to act on a number built from very little.
 */

import { CampaignStatus } from '@prisma/client';

import type { CampaignFinance, TargetComparison } from './finance.js';

export type HealthBand = 'EXCELLENT' | 'HEALTHY' | 'NEEDS_ATTENTION' | 'AT_RISK' | 'CRITICAL' | 'INSUFFICIENT_DATA';

export interface HealthComponent {
  key: string;
  label: string;
  weight: number;
  /** 0–100, or null when the data to judge it does not exist. */
  score: number | null;
  detail: string;
  /**
   * Whether this component judges a measured *outcome* rather than something
   * the agency filled in about itself. Only outcome components count towards
   * coverage — see the note on `MIN_COVERAGE`.
   */
  outcome: boolean;
}

export interface HealthScore {
  score: number | null;
  band: HealthBand;
  /** Share of total weight that could actually be judged, 0–1. */
  coverage: number;
  components: HealthComponent[];
  explanation: string;
}

/**
 * Below this share of judgeable *outcome* weight, no score is published.
 *
 * Coverage counts outcome components only, and that distinction is the whole
 * point. Brief completeness and content counts are always judgeable — they are
 * things the agency typed in — so counting them would let a campaign with a
 * tidy brief, approved content and not one measured result reach a comfortable
 * mid-60s score and disappear off the attention list. What that campaign
 * deserves is "we cannot tell you, go and connect something", which is what an
 * outcome-only coverage test produces.
 */
export const MIN_COVERAGE = 0.4;

export function bandFor(score: number): Exclude<HealthBand, 'INSUFFICIENT_DATA'> {
  if (score >= 85) return 'EXCELLENT';
  if (score >= 70) return 'HEALTHY';
  if (score >= 50) return 'NEEDS_ATTENTION';
  if (score >= 30) return 'AT_RISK';
  return 'CRITICAL';
}

/** Map a signed distance from target onto 0–100, with on-target scoring 75. */
function scoreFromDelta(delta: number): number {
  const clamped = Math.max(-1, Math.min(1, delta));
  return Math.round(Math.max(0, Math.min(100, 75 + clamped * 25)));
}

function targetComponent(
  comparison: TargetComparison | undefined,
  key: string,
  label: string,
  weight: number,
): HealthComponent {
  if (!comparison || comparison.status === 'NO_DATA' || comparison.delta === null) {
    return {
      key,
      label,
      weight,
      score: null,
      outcome: true,
      detail:
        comparison?.target.available === false ? comparison.target.reason : 'No target set or no result recorded',
    };
  }
  const pct = `${comparison.delta >= 0 ? '+' : ''}${Math.round(comparison.delta * 100)}%`;
  return {
    key,
    label,
    weight,
    outcome: true,
    score: scoreFromDelta(comparison.delta),
    detail: `${comparison.status.replace(/_/g, ' ').toLowerCase()} (${pct} vs target)`,
  };
}

/**
 * Score a return on ad spend with no target to compare it against.
 *
 * Most campaigns never get targets set, and refusing to judge them would mean
 * a campaign returning 8x sits under "insufficient data" next to one that has
 * never been measured at all. Return is one of the few marketing figures with a
 * meaningful absolute anchor — below 1.0x the campaign destroys money whatever
 * anyone hoped for — so it is scored against that rather than against nothing.
 *
 * The scale is a judgement, not a law: break-even scores 40, 4x scores 85. It
 * is only used when no target exists; a real target always wins, because the
 * business's own number beats a generic curve.
 */
function absoluteRoasScore(roas: number): number {
  if (roas < 1) return Math.round(Math.max(0, roas * 40));
  if (roas < 4) return Math.round(40 + ((roas - 1) / 3) * 45);
  return Math.round(Math.min(100, 85 + Math.min((roas - 4) / 4, 1) * 15));
}

function roasComponent(comparison: TargetComparison | undefined, finance: CampaignFinance): HealthComponent {
  const withTarget = targetComponent(comparison, 'roas', 'Return on ad spend', 20);
  if (withTarget.score !== null) return withTarget;

  if (finance.roas.available) {
    return {
      key: 'roas',
      label: 'Return on ad spend',
      weight: 20,
      outcome: true,
      score: absoluteRoasScore(finance.roas.value),
      detail: `${finance.roas.value.toFixed(2)}x return, judged against break-even — no target set`,
    };
  }
  return withTarget;
}

export interface HealthInput {
  status: CampaignStatus;
  finance: CampaignFinance;
  /** Completeness of the campaign brief. */
  brief: {
    hasObjective: boolean;
    hasAudience: boolean;
    hasOffer: boolean;
    hasLandingPage: boolean;
    hasCta: boolean;
    hasStrategy: boolean;
  };
  content: { total: number; approved: number };
}

export function campaignHealth(input: HealthInput): HealthScore {
  const { finance } = input;
  const byMetric = (metric: TargetComparison['metric']) => finance.targets.find((t) => t.metric === metric);

  const briefChecks = Object.values(input.brief);
  const briefFilled = briefChecks.filter(Boolean).length;

  const components: HealthComponent[] = [
    {
      key: 'brief',
      label: 'Campaign brief',
      weight: 15,
      outcome: false,
      score: Math.round((briefFilled / briefChecks.length) * 100),
      detail: `${briefFilled} of ${briefChecks.length} brief fields completed`,
    },
    {
      key: 'tracking',
      label: 'Tracking',
      weight: 15,
      outcome: false,
      // Always judgeable: either results are arriving or they are not, and a
      // campaign with no measurement is a real finding rather than a gap.
      score: finance.adSpendSource === 'snapshots' ? 100 : finance.adSpendSource === 'cost-lines' ? 45 : 0,
      detail:
        finance.adSpendSource === 'snapshots'
          ? 'Platform results are being recorded'
          : finance.adSpendSource === 'cost-lines'
            ? 'Spend recorded by hand — no platform results'
            : 'No results recorded from any source',
    },
    {
      key: 'budget',
      label: 'Budget health',
      weight: 15,
      outcome: true,
      score:
        finance.budget.status === 'NO_DATA'
          ? null
          : finance.budget.status === 'ON_TRACK'
            ? 100
            : finance.budget.status === 'UNDER_BUDGET'
              ? 70
              : finance.budget.status === 'AT_RISK'
                ? 45
                : 10,
      detail: finance.budget.explanation,
    },
    roasComponent(byMetric('roas'), finance),
    targetComponent(byMetric('cpa'), 'cpa', 'Cost per acquisition', 15),
    {
      key: 'profitability',
      label: 'Profitability',
      weight: 10,
      outcome: true,
      score: finance.roi.available ? scoreFromDelta(Math.max(-1, Math.min(1, finance.roi.value))) : null,
      detail: finance.roi.available ? `ROI ${(finance.roi.value * 100).toFixed(0)}%` : finance.roi.reason,
    },
    {
      key: 'content',
      label: 'Content readiness',
      weight: 10,
      outcome: false,
      score:
        input.content.total === 0 ? null : Math.round((input.content.approved / input.content.total) * 100),
      detail:
        input.content.total === 0
          ? 'No content attached to this campaign'
          : `${input.content.approved} of ${input.content.total} items approved`,
    },
  ];

  const judged = components.filter((component) => component.score !== null);
  const judgedWeight = judged.reduce((sum, component) => sum + component.weight, 0);

  // Coverage is measured over outcome components only — see MIN_COVERAGE.
  const outcomeWeight = components.filter((c) => c.outcome).reduce((sum, c) => sum + c.weight, 0);
  const judgedOutcomeWeight = judged.filter((c) => c.outcome).reduce((sum, c) => sum + c.weight, 0);
  const coverage = outcomeWeight === 0 ? 0 : judgedOutcomeWeight / outcomeWeight;

  if (coverage < MIN_COVERAGE) {
    return {
      score: null,
      band: 'INSUFFICIENT_DATA',
      coverage,
      components,
      explanation: `Only ${Math.round(coverage * 100)}% of the outcome checks have the data they need. Connect a platform, record spend and revenue, or set targets before reading a score.`,
    };
  }

  const score = Math.round(
    judged.reduce((sum, component) => sum + (component.score ?? 0) * component.weight, 0) / judgedWeight,
  );
  const band = bandFor(score);
  const weakest = [...judged].sort((a, b) => (a.score ?? 0) - (b.score ?? 0))[0];

  return {
    score,
    band,
    coverage,
    components,
    explanation:
      `Scored ${score}/100 with ${Math.round(coverage * 100)}% of outcome checks measurable. ` +
      (weakest ? `Weakest area: ${weakest.label.toLowerCase()} — ${weakest.detail}.` : ''),
  };
}

// ------------------------------------------------------------ recommendation

export type RecommendationAction =
  | 'SCALE'
  | 'KEEP'
  | 'IMPROVE'
  | 'REDUCE'
  | 'PAUSE'
  | 'RETEST'
  | 'INVESTIGATE';

export type Priority = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface Recommendation {
  action: RecommendationAction;
  priority: Priority;
  reason: string;
  /** The specific figures the recommendation rests on. */
  evidence: string[];
  suggestedAction: string;
}

/**
 * One recommendation per campaign, chosen by the first rule that matches.
 *
 * Order is the design, and it runs in three tiers:
 *
 *   1. **Determined facts.** Over budget and below break-even are arithmetic on
 *      figures we hold — budget against spend, revenue against spend. They are
 *      checked first *and before the insufficient-data gate*, because that gate
 *      exists to stop the engine inferring things it cannot see, not to
 *      suppress something it can see perfectly well. A campaign that has blown
 *      its budget needs to hear "reduce" whether or not anyone set a CPA target.
 *
 *   2. **The blind case.** With the determined facts ruled out, too little data
 *      means the honest answer is to go and connect something, not to guess.
 *
 *   3. **Inferences.** Everything from target misses down to "keep going",
 *      which all lean on data whose presence tier 2 has now established.
 */
export function recommend(input: { finance: CampaignFinance; health: HealthScore; status: CampaignStatus }): Recommendation {
  const { finance, health } = input;
  const evidence: string[] = [];

  if (finance.adSpend.available) evidence.push(`Ad spend ${finance.adSpend.value.toFixed(2)} ${finance.currency}`);
  if (finance.roas.available) evidence.push(`ROAS ${finance.roas.value.toFixed(2)}x`);
  if (finance.roi.available) evidence.push(`ROI ${(finance.roi.value * 100).toFixed(0)}%`);
  if (finance.cpa.available) evidence.push(`CPA ${finance.cpa.value.toFixed(2)} ${finance.currency}`);
  evidence.push(finance.budget.explanation);

  // --- tier 1: facts that stand on their own ---------------------------
  if (finance.budget.status === 'OVER_BUDGET') {
    return {
      action: 'REDUCE',
      priority: 'CRITICAL',
      reason: 'The campaign has spent more than its authorised budget.',
      evidence,
      suggestedAction: 'Cap or pause delivery, then either raise the budget deliberately or stop the campaign.',
    };
  }

  if (finance.roas.available && finance.roas.value < 1) {
    return {
      action: 'PAUSE',
      priority: 'CRITICAL',
      reason: 'The campaign is returning less revenue than it spends on media.',
      evidence,
      suggestedAction: 'Pause delivery and review targeting, offer and landing page before spending further.',
    };
  }

  // --- tier 2: too little to judge -------------------------------------
  if (health.band === 'INSUFFICIENT_DATA') {
    return {
      action: 'INVESTIGATE',
      priority: 'HIGH',
      reason: 'There is not enough recorded data to judge this campaign.',
      evidence: [health.explanation],
      suggestedAction: 'Connect the ad platform, or record spend and revenue by hand, before making a decision.',
    };
  }

  // --- tier 3: inference ------------------------------------------------
  const roasTarget = finance.targets.find((target) => target.metric === 'roas');
  const cpaTarget = finance.targets.find((target) => target.metric === 'cpa');

  if (cpaTarget?.status === 'BELOW_TARGET' && (cpaTarget.delta ?? 0) < -0.25) {
    return {
      action: 'IMPROVE',
      priority: 'HIGH',
      reason: 'Cost per acquisition is well above the target set for this campaign.',
      evidence,
      suggestedAction: 'Tighten audience and creative, and check the landing page converts before increasing spend.',
    };
  }

  if (finance.contributionProfit.available && finance.contributionProfit.value < 0) {
    return {
      action: 'INVESTIGATE',
      priority: 'HIGH',
      reason: 'The campaign is making a contribution loss once every cost is counted.',
      evidence,
      suggestedAction: 'Check cost of goods and campaign costs — media may be profitable while the campaign is not.',
    };
  }

  if (health.band === 'EXCELLENT' && roasTarget?.status === 'BEATING_TARGET' && finance.budget.status !== 'AT_RISK') {
    return {
      action: 'SCALE',
      priority: 'MEDIUM',
      reason: 'The campaign is beating its return target with budget headroom.',
      evidence,
      suggestedAction: 'Raise the budget in steps and watch that cost per acquisition holds.',
    };
  }

  if (health.band === 'AT_RISK' || health.band === 'CRITICAL') {
    return {
      action: 'RETEST',
      priority: 'HIGH',
      reason: 'Several health checks are failing at once.',
      evidence: [health.explanation, ...evidence],
      suggestedAction: 'Rebuild the weakest area and rerun a small test before committing more budget.',
    };
  }

  if (health.band === 'NEEDS_ATTENTION') {
    return {
      action: 'IMPROVE',
      priority: 'MEDIUM',
      reason: 'The campaign is working but below where it should be.',
      evidence: [health.explanation, ...evidence],
      suggestedAction: health.components.filter((c) => c.score !== null).sort((a, b) => (a.score ?? 0) - (b.score ?? 0))[0]?.detail ?? 'Review the weakest health component.',
    };
  }

  return {
    action: 'KEEP',
    priority: 'LOW',
    reason: 'The campaign is performing in line with expectations.',
    evidence,
    suggestedAction: 'Leave the campaign running and review again at the next reporting point.',
  };
}

/**
 * Whether there is enough data to say anything at all.
 *
 * This module exists because the most damaging thing an advertising
 * recommendation engine can do is not being wrong — it is being *confidently*
 * wrong from three data points. "Meta has the best CPA" computed from one
 * campaign that ran for a day reads exactly like the same sentence computed
 * from six months, and an operator moves budget on it either way.
 *
 * So every comparison in this engine passes through here first, and the answer
 * is one of three things rather than a number:
 *
 *   SUFFICIENT     enough measured data for the claim being made
 *   INSUFFICIENT   not enough — the claim is not made, and the shortfall is said
 *   UNMEASURED     the metric was never fetched, or the provider has no such
 *                  metric, so no amount of waiting would help
 *
 * The thresholds are the ones the existing creative-performance analyzer
 * already uses, imported rather than restated, so a campaign judged
 * INSUFFICIENT_DATA there cannot be judged comparable here.
 */

import { DEFAULT_THRESHOLDS, type PerformanceThresholds } from '../../analytics/creative-performance.js';
import type { Derived } from '../../analytics.js';

export type Sufficiency = 'SUFFICIENT' | 'INSUFFICIENT' | 'UNMEASURED';

export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface SufficiencyVerdict {
  sufficiency: Sufficiency;
  /** Said to the operator verbatim when not SUFFICIENT. */
  reason: string | null;
  /** How many comparable units the claim rests on. */
  sampleSize: number;
}

/**
 * Comparison groups smaller than this are not compared at all.
 *
 * Two is the minimum that makes "best" a meaningful word, but two is also where
 * a single outlier decides the answer, so a two-way comparison can never be
 * more than MEDIUM confidence — see `confidenceFor`.
 */
export const MIN_COMPARISON_GROUP = 2;

/** Days of history below which a trend is not a trend. */
export const MIN_TREND_DAYS = 7;

export interface Comparable {
  /** What is being compared — a platform, a campaign, a creative, a place. */
  key: string;
  label: string;
  totals: Derived;
  /** Days of measured data behind this entry. */
  days: number;
  /** Snapshot rows behind it. Zero means nothing was ever fetched. */
  sampleSize: number;
}

/**
 * Whether one entry carries enough delivery to be judged on a given metric.
 *
 * A campaign with 40 impressions has a CTR, arithmetically. It does not have a
 * CTR anyone should act on, and ranking it against a campaign with 400,000 is
 * how a rounding error becomes a budget decision.
 */
export function isComparable(
  entry: Comparable,
  metric: 'ctr' | 'cpc' | 'cpa' | 'roas' | 'conversionRate',
  thresholds: PerformanceThresholds = DEFAULT_THRESHOLDS,
): boolean {
  if (entry.sampleSize === 0) return false;

  const { totals } = entry;
  switch (metric) {
    case 'ctr':
      return totals.impressions >= thresholds.minImpressions;
    case 'cpc':
      return totals.clicks >= thresholds.minClicks;
    case 'cpa':
    case 'conversionRate':
      return totals.conversions >= thresholds.minConversions && totals.spend >= thresholds.minSpend;
    case 'roas':
      return totals.spend >= thresholds.minSpend && totals.revenue > 0;
    default:
      return false;
  }
}

/**
 * Can this set be ranked on this metric, and on what evidence.
 *
 * The metric being null on an entry is not a low score — it is the absence of a
 * score, and such an entry is excluded from the ranking rather than sorted to
 * the bottom. Sorting nulls last silently declares them the worst performers.
 */
export function canCompare(
  entries: Comparable[],
  metric: 'ctr' | 'cpc' | 'cpa' | 'roas' | 'conversionRate',
  thresholds: PerformanceThresholds = DEFAULT_THRESHOLDS,
): SufficiencyVerdict {
  const measured = entries.filter((entry) => entry.sampleSize > 0);

  if (measured.length === 0) {
    return {
      sufficiency: 'UNMEASURED',
      reason: 'No performance has been fetched from any provider for this period.',
      sampleSize: 0,
    };
  }

  const comparable = measured.filter(
    (entry) => isComparable(entry, metric, thresholds) && entry.totals[metric] !== null,
  );

  if (comparable.length < MIN_COMPARISON_GROUP) {
    return {
      sufficiency: 'INSUFFICIENT',
      reason: comparable.length === 0
        ? `Nothing in this period delivered enough to judge ${metric.toUpperCase()} on.`
        : `Only one entry delivered enough to judge ${metric.toUpperCase()} on, so there is nothing to compare it against.`,
      sampleSize: comparable.length,
    };
  }

  return { sufficiency: 'SUFFICIENT', reason: null, sampleSize: comparable.length };
}

/**
 * Confidence from the evidence, not from the strength of the conclusion.
 *
 * A large gap between two thin samples is still a thin sample. This keys on how
 * much was measured and how many things were compared, and deliberately caps a
 * two-way comparison at MEDIUM: with two entries, one outlier is the result.
 */
export function confidenceFor(input: {
  groupSize: number;
  days: number;
  /** The winning entry's own delivery, as a share of the threshold. */
  deliveryRatio: number;
}): Confidence {
  if (input.groupSize < MIN_COMPARISON_GROUP) return 'LOW';
  if (input.groupSize === MIN_COMPARISON_GROUP) {
    return input.days >= MIN_TREND_DAYS && input.deliveryRatio >= 3 ? 'MEDIUM' : 'LOW';
  }
  if (input.days < MIN_TREND_DAYS || input.deliveryRatio < 2) return 'LOW';
  return input.groupSize >= 4 && input.days >= 14 && input.deliveryRatio >= 5 ? 'HIGH' : 'MEDIUM';
}

/**
 * Whether a change between two periods is worth calling a change.
 *
 * Small percentage swings on small numbers are noise. This requires both a
 * relative move and an absolute floor, because a CTR that went from 0.4% to
 * 0.6% is a 50% increase and almost certainly nothing.
 */
export function isMaterialChange(input: {
  current: number | null;
  previous: number | null;
  /** Minimum relative move, e.g. 0.2 for 20%. */
  minRelative: number;
  /** Minimum delivery in the current period for the move to count. */
  currentSample: number;
  previousSample: number;
}): boolean {
  const { current, previous } = input;
  if (current === null || previous === null || previous === 0) return false;
  if (input.currentSample === 0 || input.previousSample === 0) return false;

  return Math.abs((current - previous) / previous) >= input.minRelative;
}

export { DEFAULT_THRESHOLDS };
export type { PerformanceThresholds, Derived };

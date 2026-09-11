/**
 * Paid metrics, qualified — the four states applied to advertising figures.
 *
 * The arithmetic is not here. `services/analytics.ts` already sums snapshots
 * and derives every ratio, and it already refuses to compute one it cannot:
 * `derive()` returns null with a reason rather than a flattering zero, which is
 * exactly right and has been for a long time. Nothing below recomputes any of
 * it. This module only answers a question `derive` was never asked: *why* is a
 * figure absent, and what should the operator do about it.
 *
 * That distinction matters more for paid than for organic, because of a trap in
 * the storage. `AnalyticsSnapshot` declares every metric column with
 * `@default(0)`. So a campaign nobody has ever fetched insights for and a
 * campaign that genuinely delivered nothing are, at the column level, identical
 * rows of zeros. Reporting the first as "0 impressions, 0 clicks, £0 spent"
 * states as measured fact something we never asked the provider — on a screen
 * whose entire job is telling someone whether their money is working.
 *
 * So the presence of rows is the signal, not their contents:
 *
 *   no rows at all            NOT_FETCHED   — nobody has asked the provider
 *   no rows, publish errored  PROVIDER_ERROR — we asked and were refused
 *   rows exist                ZERO          — measured; the value stands
 *   platform lacks the metric UNAVAILABLE   — no amount of fetching would help
 *
 * `ZERO` is the state name Phase 14 gives to any *measured* value, not only to
 * the number nought, and Phase 15 reads it that way. It is a slightly odd name
 * inherited from that vocabulary, and it is kept identical here on purpose: two
 * spellings of the same idea would be worse than one imperfect one.
 */

import { Platform } from '@prisma/client';

import { derive, type Derived, type Totals } from '../analytics.js';

export type PaidMetricName =
  | 'spend' | 'budget' | 'impressions' | 'reach' | 'clicks'
  | 'ctr' | 'cpc' | 'cpm' | 'conversions' | 'cpa' | 'roas';

/** Same four states as Phase 14, deliberately spelled the same way. */
export type MetricState = 'ZERO' | 'UNAVAILABLE' | 'NOT_FETCHED' | 'PROVIDER_ERROR';

export interface QualifiedMetric {
  metric: PaidMetricName;
  /** Non-null only when state is ZERO. A renderer cannot print an absence. */
  value: number | null;
  state: MetricState;
  /** Why, when there is something to say. Never invented. */
  note: string | null;
}

/**
 * What each advertising platform actually reports.
 *
 * Decided by the platform and the metric alone — never by the data — which is
 * what makes UNAVAILABLE safe to determine without having fetched anything.
 *
 * The one that catches people out is `reach` on Google Ads: Search has no reach
 * metric at all, because there is no audience to have reached — there are
 * queries. Summing impressions into a "reach" column would invent a number
 * Google never produced.
 */
const SUPPORTED: Record<Platform, ReadonlySet<PaidMetricName>> = {
  /*
   * Empty, and permanently so. Upload-Post is an organic publishing route with
   * no advertising surface at all, so every paid metric for it is UNAVAILABLE —
   * which is the honest answer, and the one this map exists to give.
   */
  [Platform.UPLOAD_POST]: new Set<PaidMetricName>(),
  [Platform.FACEBOOK]: new Set([
    'spend', 'budget', 'impressions', 'reach', 'clicks', 'ctr', 'cpc', 'cpm', 'conversions', 'cpa', 'roas',
  ]),
  [Platform.INSTAGRAM]: new Set([
    'spend', 'budget', 'impressions', 'reach', 'clicks', 'ctr', 'cpc', 'cpm', 'conversions', 'cpa', 'roas',
  ]),
  [Platform.TIKTOK]: new Set([
    'spend', 'budget', 'impressions', 'reach', 'clicks', 'ctr', 'cpc', 'cpm', 'conversions', 'cpa', 'roas',
  ]),
  // No reach: a search impression is a query, not a person reached.
  [Platform.GOOGLE_ADS]: new Set([
    'spend', 'budget', 'impressions', 'clicks', 'ctr', 'cpc', 'cpm', 'conversions', 'cpa', 'roas',
  ]),
  // Platforms with no advertising integration in this repository report
  // nothing, which is a different statement from reporting zero.
  [Platform.LINKEDIN]: new Set<PaidMetricName>([]),
  [Platform.SNAPCHAT]: new Set<PaidMetricName>([]),
  [Platform.YOUTUBE]: new Set<PaidMetricName>([]),
  [Platform.GOOGLE_BUSINESS]: new Set<PaidMetricName>([]),
  [Platform.X]: new Set<PaidMetricName>([]),
};

export function supportsMetric(platform: Platform, metric: PaidMetricName): boolean {
  return SUPPORTED[platform]?.has(metric) ?? false;
}

/** Every metric supported by at least one platform in the selection. */
export function supportedAcross(platforms: Platform[], metric: PaidMetricName): boolean {
  return platforms.some((platform) => supportsMetric(platform, metric));
}

export interface QualifyInput {
  /** The platforms in scope. UNAVAILABLE only when none of them report it. */
  platforms: Platform[];
  /** How many snapshot rows the query actually found. Zero means unfetched. */
  sampleSize: number;
  /** True when a publication in scope failed at the provider. */
  providerErrored: boolean;
  /**
   * Set when performance exists but cannot honestly be attributed to *this*
   * row. A snapshot's grain is campaign + platform + day, so when several
   * advertisements share that grain the figure belongs to all of them jointly
   * and to none of them individually.
   */
  unattributable?: string | null;
  /** The derived figures, from `analytics.ts`. Not recomputed here. */
  derived: Derived;
  /** Daily budget across the selection, which is ours rather than fetched. */
  budget: number | null;
}

/** `derive` already produced these; this only picks the value out. */
function valueOf(derived: Derived, metric: PaidMetricName, budget: number | null): number | null {
  switch (metric) {
    case 'spend': return derived.spend;
    case 'impressions': return derived.impressions;
    case 'reach': return derived.reach;
    case 'clicks': return derived.clicks;
    case 'conversions': return derived.conversions;
    case 'ctr': return derived.ctr;
    case 'cpc': return derived.cpc;
    case 'cpm': return derived.cpm;
    case 'cpa': return derived.cpa;
    case 'roas': return derived.roas;
    case 'budget': return budget;
    default: return null;
  }
}

/** The reason `derive` gave for a null ratio, when it gave one. */
function reasonOf(derived: Derived, metric: PaidMetricName): string | null {
  const reasons = derived.reasons as Record<string, string | undefined>;
  return reasons[metric] ?? null;
}

export function qualify(metric: PaidMetricName, input: QualifyInput): QualifiedMetric {
  if (!supportedAcross(input.platforms, metric)) {
    return {
      metric,
      value: null,
      state: 'UNAVAILABLE',
      note: input.platforms.length === 1
        ? `${input.platforms[0]} does not report this metric.`
        : 'None of the selected platforms report this metric.',
    };
  }

  /*
   * Budget is ours, not the provider's: it is what the operator set when
   * drafting, so it is known even before a single insight has been fetched and
   * must not be suppressed along with the fetched figures.
   */
  if (metric === 'budget') {
    return input.budget === null
      ? { metric, value: null, state: 'NOT_FETCHED', note: 'No budget is recorded for this selection.' }
      : { metric, value: input.budget, state: 'ZERO', note: null };
  }

  /*
   * Attribution before measurement. A figure that exists but belongs to a
   * coarser grain than this row must not be printed against this row: doing so
   * reported a whole campaign's spend against a draft that had never run, and
   * again against each of its siblings.
   */
  if (input.unattributable) {
    return { metric, value: null, state: 'NOT_FETCHED', note: input.unattributable };
  }

  if (input.sampleSize === 0) {
    return input.providerErrored
      ? {
        metric,
        value: null,
        state: 'PROVIDER_ERROR',
        note: 'The provider refused this advertisement, so no performance was recorded.',
      }
      : {
        metric,
        value: null,
        state: 'NOT_FETCHED',
        note: 'No insights have been fetched from the provider for this period.',
      };
  }

  const value = valueOf(input.derived, metric, input.budget);

  /*
   * Rows exist but the ratio is still null — CPA with no conversions, ROAS with
   * no revenue attributed. That is not an absence of measurement, it is a
   * measurement that does not divide, and `derive` already wrote down why.
   */
  if (value === null) {
    return { metric, value: null, state: 'NOT_FETCHED', note: reasonOf(input.derived, metric) };
  }

  return { metric, value, state: 'ZERO', note: null };
}

/** The KPI row, in the order the dashboard shows it. */
export const KPI_ORDER: PaidMetricName[] = [
  'spend', 'budget', 'impressions', 'reach', 'clicks', 'ctr', 'cpc', 'conversions', 'cpa', 'roas',
];

export function qualifyAll(input: QualifyInput, metrics: PaidMetricName[] = KPI_ORDER): QualifiedMetric[] {
  return metrics.map((metric) => qualify(metric, input));
}

export { derive };
export type { Derived, Totals };

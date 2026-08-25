/**
 * The Report Builder: a saved configuration, rendered from Phase 14 analytics.
 *
 * Nothing here computes a metric. `socialOverview` is called exactly as the
 * analytics screen calls it, and this module's whole job is to *narrow* and
 * *qualify* what it returns:
 *
 *   narrow  — to the platforms the report selected
 *   qualify — with the metric states Phase 14 already assigned
 *
 * The second half is the point of the file, and it exists because of a real
 * hazard in the shape of the analytics payload.
 *
 * `SocialOverview.platforms[]` and `.periodTotals` are sums produced with
 * `safeValue()`, which turns a null metric into 0 before adding it. That is
 * correct for a total — you cannot sum an absence — but it means an aggregate
 * cannot, on its own, distinguish "the platform reported zero" from "the
 * platform does not report this metric at all". Printing that 0 in a
 * client-facing report would state, in writing, that a restaurant got zero
 * saves on Facebook, when Facebook has no saves metric to give.
 *
 * The fix does not require recomputing anything, because of a property of
 * Phase 14: UNAVAILABLE is decided by `METRICS_SUPPORTED[platform]` alone. It
 * depends on the platform and the metric, never on the data. So one published
 * post of a platform is enough to read that platform's support for every
 * metric, and `socialOverview` already returns per-post states in `topPosts`.
 * This module reads them there and re-labels the aggregate accordingly:
 *
 *   supported and observed  → the sum, as Phase 14 computed it
 *   UNAVAILABLE             → "Unavailable", never 0
 *   nothing observed        → NOT_FETCHED, never 0
 *
 * Where no post of a platform appears in `topPosts` — it returns the ten
 * best-performing published posts — the state is reported as NOT_FETCHED
 * rather than guessed. An unknown state is said out loud; it is never rounded
 * down to a number.
 */

import { Platform } from '@prisma/client';

import { socialOverview, type MetricState, type PostAnalytics, type SocialOverview } from '../social/analytics.js';

/** The metrics a report may select. Exactly Phase 14's, no more. */
export const REPORT_METRICS = [
  'engagements', 'reach', 'impressions', 'likes', 'comments', 'shares', 'saves', 'clicks',
] as const;

export type ReportMetric = (typeof REPORT_METRICS)[number];

/** The sections a report may contain. */
export const REPORT_SECTIONS = [
  'OVERVIEW', 'PLATFORMS', 'TOP_CONTENT', 'ENGAGEMENT', 'REACH',
] as const;

export type ReportSection = (typeof REPORT_SECTIONS)[number];

/**
 * A saved report configuration.
 *
 * Stored in `Report.payload.builder` and versioned, so a later shape change can
 * be migrated on read rather than breaking every saved report at once.
 */
export interface ReportConfig {
  version: 1;
  description: string | null;
  platforms: Platform[];
  metrics: ReportMetric[];
  sections: ReportSection[];
}

export const DEFAULT_CONFIG: ReportConfig = {
  version: 1,
  description: null,
  platforms: [],
  metrics: ['engagements', 'reach', 'impressions'],
  sections: [...REPORT_SECTIONS],
};

/** A number that is only a number when Phase 14 actually had one. */
export interface QualifiedMetric {
  metric: ReportMetric;
  /** The sum Phase 14 computed, or null when there is nothing to state. */
  value: number | null;
  /** Phase 14's own state vocabulary, preserved exactly. */
  state: MetricState;
  /** Why the value is absent, when it is. Rendered under the figure. */
  note: string | null;
}

export interface PlatformBreakdown {
  platform: Platform;
  label: string;
  publishedCount: number;
  metrics: QualifiedMetric[];
}

export interface ReportData {
  period: { from: Date; to: Date };
  platforms: Platform[];
  /** Totals across the selected platforms, each qualified by its state. */
  totals: QualifiedMetric[];
  breakdown: PlatformBreakdown[];
  /** Phase 14's own ranking, filtered to the selected platforms. Never re-sorted. */
  topPosts: PostAnalytics[];
  totalPosts: number;
  publishedPosts: number;
  /** True when nothing in the period carried a measured value. */
  insufficientData: boolean;
}

/**
 * Extra context beyond the state, or nothing.
 *
 * Deliberately empty for all four states: the renderer already prints a
 * translated sentence for each one, and repeating it here produced "Not
 * fetched — Not yet fetched from the platform" under every empty figure. A note
 * is set only where there is something the state alone does not say, which is
 * why the two cases below fill it in by hand.
 */
const NOTES: Record<MetricState, string | null> = {
  ZERO: null,
  UNAVAILABLE: null,
  NOT_FETCHED: null,
  PROVIDER_ERROR: null,
};

/**
 * The state a platform assigns to a metric, read from the posts Phase 14
 * returned rather than recomputed.
 *
 * Precedence matters. UNAVAILABLE is a property of the platform and wins
 * outright: if any post of this platform reports the metric unavailable, every
 * post of that platform does. Otherwise a single real value makes the metric
 * measured, because a sum of one observation is still an observation. Only when
 * nothing was observed do the remaining states apply, worst-news-first, so a
 * provider failure is never hidden behind a "not fetched".
 */
function stateFor(posts: PostAnalytics[], metric: ReportMetric): MetricState {
  if (posts.length === 0) return 'NOT_FETCHED';

  const states = posts.map((post) => post.metrics[metric].state);
  if (states.includes('UNAVAILABLE')) return 'UNAVAILABLE';

  const measured = posts.some((post) => post.metrics[metric].value !== null);
  if (measured) return 'ZERO';

  if (states.includes('PROVIDER_ERROR')) return 'PROVIDER_ERROR';
  return 'NOT_FETCHED';
}

function qualify(metric: ReportMetric, sum: number, posts: PostAnalytics[]): QualifiedMetric {
  const state = stateFor(posts, metric);
  return {
    metric,
    // The sum is only stated when something was actually measured. This is the
    // line that stops UNAVAILABLE and NOT_FETCHED being printed as 0.
    value: state === 'ZERO' ? sum : null,
    state,
    note: NOTES[state],
  };
}

/** Phase 14's per-platform totals, keyed for lookup. */
function totalsOf(
  overview: SocialOverview,
  platform: Platform,
): { engagements: number; reach: number; impressions: number; publishedCount: number } {
  const row = overview.platforms.find((entry) => entry.platform === platform);
  return {
    engagements: row?.totalEngagements ?? 0,
    reach: row?.totalReach ?? 0,
    impressions: row?.totalImpressions ?? 0,
    publishedCount: row?.publishedCount ?? 0,
  };
}

/**
 * Phase 14 publishes per-platform sums for three metrics only. The remaining
 * five exist in `periodTotals` across all platforms, so a per-platform figure
 * for them is not available without re-aggregating — which this module will not
 * do. They are reported at the total level and, per platform, only as a state.
 */
const PLATFORM_LEVEL: ReadonlySet<ReportMetric> = new Set<ReportMetric>(['engagements', 'reach', 'impressions']);

export async function buildReportData(input: {
  organizationId: string;
  clientId: string;
  from: Date;
  to: Date;
  config: ReportConfig;
}): Promise<ReportData> {
  const { organizationId, clientId, from, to, config } = input;

  // Phase 14, called exactly as the analytics screen calls it.
  const overview = await socialOverview(organizationId, clientId, from, to);

  // An empty selection means "every platform that has data", which is what an
  // operator means by leaving the filter alone.
  const selected = config.platforms.length > 0
    ? config.platforms
    : overview.platforms.map((entry) => entry.platform);

  const inScope = (post: PostAnalytics) => selected.includes(post.platform);
  const scopedPosts = overview.topPosts.filter(inScope);

  /*
   * Totals must reflect the platform selection, and Phase 14 offers two
   * different granularities for that.
   *
   * `platforms[]` carries per-platform sums, but only for engagements, reach
   * and impressions — those three can be scoped exactly by summing the selected
   * rows. `periodTotals` carries all eight metrics but only across every
   * platform at once, so it is exact when nothing is filtered and wrong the
   * moment something is.
   *
   * Rather than re-aggregate the other five per platform — which would be this
   * module computing a metric, the one thing it must not do — a filtered report
   * reports their state without a number. An unscoped figure printed under a
   * "Facebook" heading would be a larger error than an honest blank.
   */
  const everyPlatform = selected.length === overview.platforms.length
    && overview.platforms.every((entry) => selected.includes(entry.platform));

  const totals = config.metrics.map((metric) => {
    if (PLATFORM_LEVEL.has(metric)) {
      const sum = overview.platforms
        .filter((entry) => selected.includes(entry.platform))
        .reduce((running, entry) => running + totalsOf(overview, entry.platform)[metric as 'engagements' | 'reach' | 'impressions'], 0);
      return qualify(metric, sum, scopedPosts);
    }

    if (everyPlatform) return qualify(metric, overview.periodTotals[metric] ?? 0, scopedPosts);

    const state = stateFor(scopedPosts, metric);
    return {
      metric,
      value: null,
      state,
      note: state === 'ZERO'
        ? 'Available across all platforms only; this report is filtered to a subset.'
        : NOTES[state],
    } satisfies QualifiedMetric;
  });

  const breakdown: PlatformBreakdown[] = selected
    .map((platform) => {
      const platformPosts = overview.topPosts.filter((post) => post.platform === platform);
      const sums = totalsOf(overview, platform);
      const row = overview.platforms.find((entry) => entry.platform === platform);

      return {
        platform,
        label: row?.label ?? platform,
        publishedCount: sums.publishedCount,
        metrics: config.metrics.map((metric) => {
          if (!PLATFORM_LEVEL.has(metric)) {
            // Honest about the gap rather than inventing a per-platform figure:
            // the state is knowable, the sum is not.
            const state = stateFor(platformPosts, metric);
            return {
              metric,
              value: null,
              state,
              note: state === 'ZERO'
                ? 'Reported across all platforms rather than per platform.'
                : NOTES[state],
            } satisfies QualifiedMetric;
          }
          return qualify(metric, sums[metric as 'engagements' | 'reach' | 'impressions'], platformPosts);
        }),
      };
    })
    // A platform the client has never posted to is noise in a client report.
    .filter((row) => row.publishedCount > 0 || overview.platforms.some((entry) => entry.platform === row.platform));

  return {
    period: { from, to },
    platforms: selected,
    totals,
    breakdown,
    // Phase 14's ranking, filtered but never re-sorted: a different order would
    // be a second ranking algorithm wearing the first one's name.
    topPosts: scopedPosts,
    totalPosts: overview.totalPosts,
    publishedPosts: overview.publishedPosts,
    insufficientData: totals.every((entry) => entry.value === null),
  };
}

/** Narrow an unknown payload back to a config, filling anything absent. */
export function parseConfig(payload: unknown): ReportConfig {
  const builder = (payload as { builder?: Partial<ReportConfig> } | null)?.builder;
  if (!builder) return { ...DEFAULT_CONFIG };

  const platforms = Array.isArray(builder.platforms)
    ? builder.platforms.filter((entry): entry is Platform =>
      Object.values(Platform).includes(entry as Platform))
    : [];

  const metrics = Array.isArray(builder.metrics)
    ? builder.metrics.filter((entry): entry is ReportMetric =>
      (REPORT_METRICS as readonly string[]).includes(entry as string))
    : DEFAULT_CONFIG.metrics;

  const sections = Array.isArray(builder.sections)
    ? builder.sections.filter((entry): entry is ReportSection =>
      (REPORT_SECTIONS as readonly string[]).includes(entry as string))
    : DEFAULT_CONFIG.sections;

  return {
    version: 1,
    description: typeof builder.description === 'string' ? builder.description : null,
    platforms,
    // An empty metric list would render a report with no figures at all, which
    // is never what a save meant.
    metrics: metrics.length > 0 ? metrics : DEFAULT_CONFIG.metrics,
    sections: sections.length > 0 ? sections : DEFAULT_CONFIG.sections,
  };
}

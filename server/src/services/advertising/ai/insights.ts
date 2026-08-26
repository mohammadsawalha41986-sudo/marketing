/**
 * The AI Advertising Engine — deterministic analysis over measured data.
 *
 * Nothing in this file calls a language model. That is the design, not a
 * shortcut: every claim here is a comparison between numbers a provider
 * actually returned, and a model asked to make the same claim would sometimes
 * make it from numbers that were not there. The model's job in this phase is to
 * *write* — briefs and platform copy, in `brief.ts` — not to decide which
 * campaign is winning.
 *
 * Three rules run through every analyzer below.
 *
 * **Sufficiency before conclusion.** Every comparison passes `canCompare`
 * first, and an insufficient one produces a stated INSUFFICIENT_DATA finding
 * rather than a quiet omission. An operator who sees no "best platform" card
 * cannot tell whether the engine looked and found nothing or never ran.
 *
 * **Absence is not zero.** A metric that was never fetched is excluded from a
 * ranking, never sorted to the bottom — sorting nulls last silently declares
 * them the worst performers. The four states from the advertising layer are
 * carried through untouched.
 *
 * **Every finding names its sources.** `dataSources` lists the services this
 * analyzer actually queried. A recommendation that claims a source it did not
 * read is unfalsifiable, and unfalsifiable advice is the kind that survives
 * being wrong.
 */

import { Platform, RecommendationConfidence, RecommendationType, type PrismaClient } from '@prisma/client';

import { scopeWhere, type Actor } from '../../../lib/scope.js';
import { derive, sumSnapshots, PLATFORM_LABELS, type RawSnapshot } from '../../analytics.js';
import { creativePerformance } from '../../analytics/creative-performance.js';
import { matrixFor } from '../../marketing/capability-matrix.js';
import { adStatusOf, ATTENTION_STATUSES } from '../status.js';
import { supportsMetric, type PaidMetricName } from '../metrics.js';
import {
  MIN_TREND_DAYS, canCompare, confidenceFor, isMaterialChange,
  type Comparable, type Confidence,
} from './sufficiency.js';

export type InsightPriority = 'P0' | 'P1' | 'P2' | 'P3';

/** What the engine actually looked at. Never aspirational. */
export type DataSource =
  | 'AnalyticsSnapshot'
  | 'CreativePerformance'
  | 'AdPublication'
  | 'PlatformPost analytics'
  | 'Integration status'
  | 'Capability matrix';

export interface InsightEvidence {
  /** OBSERVED is a measurement; INFERRED is what we concluded from it. */
  kind: 'OBSERVED' | 'INFERRED';
  metric: string;
  value: string;
  comparison?: string;
  detail: string;
}

export interface Insight {
  key: string;
  type: RecommendationType;
  priority: InsightPriority;
  /** SUFFICIENT findings make a claim; INSUFFICIENT ones explain the absence. */
  state: 'PERFORMING' | 'UNDERPERFORMING' | 'AT_RISK' | 'INSUFFICIENT_DATA';
  title: string;
  /** What was observed. */
  finding: string;
  /** Why it matters. */
  reason: string;
  /** What to do. Null when there is nothing to do but wait for data. */
  recommendedAction: string | null;
  confidence: Confidence;
  dataSources: DataSource[];
  evidence: InsightEvidence[];
  platform: Platform | null;
  campaignId: string | null;
  creativeId: string | null;
  publicationId: string | null;
  location: string | null;
  /** Set only where the engine proposes a concrete, human-approved change. */
  proposedChange: { field: string; from: number | string | null; to: number | string | null } | null;
}

export interface InsightSection {
  key: string;
  insights: Insight[];
}

export interface InsightsReport {
  window: { from: string; to: string; days: number };
  sections: InsightSection[];
  /** What could not be analysed, and why. Shown, never swallowed. */
  limitations: string[];
  /** Every source this run actually queried. */
  dataSources: DataSource[];
}

const CONFIDENCE_ENUM: Record<Confidence, RecommendationConfidence> = {
  HIGH: RecommendationConfidence.HIGH,
  MEDIUM: RecommendationConfidence.MEDIUM,
  LOW: RecommendationConfidence.LOW,
};

export const toConfidenceEnum = (value: Confidence) => CONFIDENCE_ENUM[value];

const money = (value: number, currency: string) => `${value.toFixed(2)} ${currency}`.trim();

/**
 * How to name a metric so the direction cannot be read backwards.
 *
 * "Strongest CPA" is ambiguous — a reader can take a *high* cost per
 * acquisition for a good one — and the whole point of these cards is that they
 * are acted on without being re-derived. So the direction is in the words.
 */
const METRIC_PHRASE: Record<'cpa' | 'ctr', string> = {
  cpa: 'the lowest cost per acquisition',
  ctr: 'the highest click-through rate',
};
const percent = (value: number) => `${(value * 100).toFixed(2)}%`;
const nOf = (value: number) => value.toLocaleString('en-US');

// ---------------------------------------------------------------- loading

interface Loaded {
  snapshots: Array<RawSnapshot & { campaignId: string | null }>;
  publications: Array<{
    id: string;
    name: string;
    platform: Platform;
    status: string;
    providerStatus: string | null;
    campaignId: string | null;
    creativeId: string | null;
    dailyBudget: number;
    currency: string;
    countries: string[];
    linkUrl: string;
    callToAction: string | null;
    startDate: Date;
    endDate: Date;
    errorMessage: string | null;
  }>;
  integrations: Array<{ platform: Platform; status: string; lastError: string | null }>;
  currency: string;
}

async function load(
  prisma: PrismaClient,
  actor: Actor,
  from: Date,
  to: Date,
  clientId?: string,
): Promise<Loaded> {
  const scope = { ...scopeWhere(actor), ...(clientId ? { clientId } : {}) };

  const [snapshots, publications, integrations] = await Promise.all([
    prisma.analyticsSnapshot.findMany({
      where: { ...scope, date: { gte: from, lte: to } },
      select: {
        campaignId: true, platform: true, date: true, spend: true, reach: true,
        impressions: true, clicks: true, conversions: true, revenue: true, engagements: true,
      },
    }),
    prisma.adPublication.findMany({
      where: { ...scope, startDate: { lte: to }, endDate: { gte: from } },
      select: {
        id: true, name: true, platform: true, status: true, providerStatus: true,
        campaignId: true, creativeId: true, dailyBudget: true, currency: true,
        countries: true, linkUrl: true, callToAction: true,
        startDate: true, endDate: true, errorMessage: true,
      },
      take: 500,
    }),
    prisma.integration.findMany({
      where: scope,
      select: { platform: true, status: true, lastError: true },
    }),
  ]);

  return {
    snapshots,
    publications: publications.map((row) => ({ ...row, dailyBudget: Number(row.dailyBudget) })),
    integrations,
    currency: publications[0]?.currency ?? '',
  };
}

/** Group snapshots into comparable units keyed by whatever dimension is asked. */
function group(
  snapshots: Loaded['snapshots'],
  keyOf: (row: Loaded['snapshots'][number]) => string | null,
  labelOf: (key: string) => string,
): Comparable[] {
  const buckets = new Map<string, Loaded['snapshots']>();
  for (const row of snapshots) {
    const key = keyOf(row);
    if (!key) continue;
    const list = buckets.get(key) ?? [];
    list.push(row);
    buckets.set(key, list);
  }

  return [...buckets.entries()].map(([key, rows]) => ({
    key,
    label: labelOf(key),
    totals: derive(sumSnapshots(rows)),
    days: new Set(rows.map((row) => row.date.toISOString().slice(0, 10))).size,
    sampleSize: rows.length,
  }));
}

/** The ranking metric, lower-is-better where that is what the metric means. */
const LOWER_IS_BETTER = new Set(['cpc', 'cpa', 'cpm']);

function rank(entries: Comparable[], metric: 'ctr' | 'cpc' | 'cpa' | 'roas' | 'conversionRate'): Comparable[] {
  return [...entries]
    // Nulls are excluded rather than sorted: an absent score is not a low one.
    .filter((entry) => entry.totals[metric] !== null)
    .sort((a, b) => {
      const left = a.totals[metric]!;
      const right = b.totals[metric]!;
      return LOWER_IS_BETTER.has(metric) ? left - right : right - left;
    });
}

/** A stated non-finding, so an absent card is never ambiguous. */
function insufficient(input: {
  key: string;
  type: RecommendationType;
  title: string;
  reason: string;
  dataSources: DataSource[];
  platform?: Platform | null;
}): Insight {
  return {
    key: input.key,
    type: input.type,
    priority: 'P3',
    state: 'INSUFFICIENT_DATA',
    title: input.title,
    finding: 'Not enough historical data to make this comparison.',
    reason: input.reason,
    recommendedAction: null,
    confidence: 'LOW',
    dataSources: input.dataSources,
    evidence: [],
    platform: input.platform ?? null,
    campaignId: null,
    creativeId: null,
    publicationId: null,
    location: null,
    proposedChange: null,
  };
}

// -------------------------------------------------------------- analyzers

/** §6 — which platform is delivering, when the comparison is meaningful. */
function bestPlatform(loaded: Loaded, days: number): Insight[] {
  const entries = group(
    loaded.snapshots,
    (row) => row.platform,
    (key) => PLATFORM_LABELS[key as Platform] ?? key,
  );

  /*
   * CPA first, because it is the metric a budget decision actually turns on.
   * Where conversions were never measured the comparison falls back to CTR,
   * which answers a different and weaker question — and says so.
   */
  for (const metric of ['cpa', 'ctr'] as const) {
    const verdict = canCompare(entries, metric);
    if (verdict.sufficiency !== 'SUFFICIENT') continue;

    const ranked = rank(entries.filter((entry) => entry.totals[metric] !== null), metric);
    const [winner, runnerUp] = ranked;
    if (!winner || !runnerUp) continue;

    const confidence = confidenceFor({
      groupSize: ranked.length,
      days,
      deliveryRatio: metric === 'cpa'
        ? winner.totals.conversions / 5
        : winner.totals.impressions / 1000,
    });

    const format = metric === 'cpa'
      ? (value: number) => money(value, loaded.currency)
      : percent;

    return [{
      key: 'BEST_PLATFORM',
      type: RecommendationType.BEST_PLATFORM,
      priority: 'P2',
      state: 'PERFORMING',
      title: `${winner.label} is delivering ${METRIC_PHRASE[metric]}`,
      finding: `${winner.label} ${format(winner.totals[metric]!)} against ${runnerUp.label} ${format(runnerUp.totals[metric]!)}.`,
      reason: metric === 'cpa'
        ? 'Cost per acquisition is the figure a budget decision turns on, and both platforms delivered enough conversions to be compared.'
        : 'Conversions were not measured for this period, so platforms are compared on click-through rate instead — a weaker signal about interest rather than outcome.',
      recommendedAction: `Consider weighting new budget toward ${winner.label}. Nothing is changed automatically.`,
      confidence,
      dataSources: ['AnalyticsSnapshot'],
      evidence: [
        {
          kind: 'OBSERVED',
          metric: metric.toUpperCase(),
          value: format(winner.totals[metric]!),
          comparison: `${runnerUp.label}: ${format(runnerUp.totals[metric]!)}`,
          detail: `${winner.label}, ${winner.days} day(s) of measured data.`,
        },
        {
          kind: 'OBSERVED',
          metric: 'Spend',
          value: money(winner.totals.spend, loaded.currency),
          detail: `${winner.label} spend across the window.`,
        },
        {
          kind: 'INFERRED',
          metric: 'Comparison group',
          value: `${ranked.length} platforms`,
          detail: 'Only platforms that delivered enough to be judged are included.',
        },
      ],
      platform: winner.key as Platform,
      campaignId: null,
      creativeId: null,
      publicationId: null,
      location: null,
      proposedChange: null,
    }];
  }

  return [insufficient({
    key: 'BEST_PLATFORM',
    type: RecommendationType.BEST_PLATFORM,
    title: 'Platform comparison',
    reason: canCompare(entries, 'cpa').reason
      ?? 'Insufficient historical data to compare platforms.',
    dataSources: ['AnalyticsSnapshot'],
  })];
}

/** §7 — the campaign carrying the account, on stated metrics. */
function bestCampaign(loaded: Loaded, days: number): Insight[] {
  const names = new Map(loaded.publications.map((row) => [row.campaignId ?? '', row.name]));
  const entries = group(
    loaded.snapshots,
    (row) => row.campaignId,
    (key) => names.get(key) ?? 'Campaign',
  );

  for (const metric of ['cpa', 'ctr'] as const) {
    const verdict = canCompare(entries, metric);
    if (verdict.sufficiency !== 'SUFFICIENT') continue;

    const ranked = rank(entries.filter((entry) => entry.totals[metric] !== null), metric);
    const [winner, runnerUp] = ranked;
    if (!winner || !runnerUp) continue;

    const format = metric === 'cpa' ? (value: number) => money(value, loaded.currency) : percent;

    return [{
      key: 'BEST_CAMPAIGN',
      type: RecommendationType.BEST_CAMPAIGN,
      priority: 'P2',
      state: 'PERFORMING',
      title: `${winner.label} has ${METRIC_PHRASE[metric]}`,
      finding: `${format(winner.totals[metric]!)} against ${format(runnerUp.totals[metric]!)} for ${runnerUp.label}.`,
      reason: `Ranked on ${metric.toUpperCase()} only. Campaigns that did not deliver enough to be judged on it are excluded rather than ranked last.`,
      recommendedAction: 'Review what this campaign is doing differently before reallocating budget. Nothing is changed automatically.',
      confidence: confidenceFor({
        groupSize: ranked.length,
        days,
        deliveryRatio: metric === 'cpa' ? winner.totals.conversions / 5 : winner.totals.impressions / 1000,
      }),
      dataSources: ['AnalyticsSnapshot', 'AdPublication'],
      evidence: [
        {
          kind: 'OBSERVED',
          metric: metric.toUpperCase(),
          value: format(winner.totals[metric]!),
          comparison: `${runnerUp.label}: ${format(runnerUp.totals[metric]!)}`,
          detail: `${winner.days} day(s) of measured data.`,
        },
        {
          kind: 'OBSERVED',
          metric: 'Spend',
          value: money(winner.totals.spend, loaded.currency),
          detail: 'Across the comparison window.',
        },
      ],
      platform: null,
      campaignId: winner.key,
      creativeId: null,
      publicationId: null,
      location: null,
      proposedChange: null,
    }];
  }

  return [insufficient({
    key: 'BEST_CAMPAIGN',
    type: RecommendationType.BEST_CAMPAIGN,
    title: 'Campaign comparison',
    reason: canCompare(entries, 'cpa').reason ?? 'Insufficient historical data to compare campaigns.',
    dataSources: ['AnalyticsSnapshot', 'AdPublication'],
  })];
}

/** §15 — where the money is working, from the countries a campaign recorded. */
function locations(loaded: Loaded, days: number): Insight[] {
  /*
   * Location is what the campaign was *targeted at*, not a provider breakdown:
   * this deployment does not ingest per-region insights. So a location's
   * performance is the performance of the campaigns aimed there, and where a
   * campaign names several countries it cannot be attributed to one of them.
   */
  const singleCountry = loaded.publications.filter((row) => row.countries.length === 1);
  const byCountry = new Map<string, string[]>();
  for (const row of singleCountry) {
    if (!row.campaignId) continue;
    const list = byCountry.get(row.countries[0]!) ?? [];
    list.push(row.campaignId);
    byCountry.set(row.countries[0]!, list);
  }

  if (byCountry.size < 2) {
    return [insufficient({
      key: 'LOCATION',
      type: RecommendationType.LOCATION_OPPORTUNITY,
      title: 'Location comparison',
      reason: byCountry.size === 0
        ? 'No campaign in this period targets a single country, so performance cannot be attributed to a place.'
        : 'Only one location has campaigns targeted at it alone, so there is nothing to compare it against.',
      dataSources: ['AdPublication', 'AnalyticsSnapshot'],
    })];
  }

  const entries: Comparable[] = [...byCountry.entries()].map(([country, campaignIds]) => {
    const rows = loaded.snapshots.filter((row) => row.campaignId && campaignIds.includes(row.campaignId));
    return {
      key: country,
      label: country,
      totals: derive(sumSnapshots(rows)),
      days: new Set(rows.map((row) => row.date.toISOString().slice(0, 10))).size,
      sampleSize: rows.length,
    };
  });

  for (const metric of ['cpa', 'ctr'] as const) {
    if (canCompare(entries, metric).sufficiency !== 'SUFFICIENT') continue;

    const ranked = rank(entries.filter((entry) => entry.totals[metric] !== null), metric);
    const [winner, weakest] = [ranked[0], ranked[ranked.length - 1]];
    if (!winner || !weakest || winner.key === weakest.key) continue;

    const format = metric === 'cpa' ? (value: number) => money(value, loaded.currency) : percent;

    return [{
      key: 'LOCATION',
      type: RecommendationType.LOCATION_OPPORTUNITY,
      priority: 'P2',
      state: 'PERFORMING',
      title: `${winner.label} is outperforming ${weakest.label}`,
      finding: `${winner.label} ${format(winner.totals[metric]!)} against ${weakest.label} ${format(weakest.totals[metric]!)}.`,
      reason: 'Compared from campaigns targeted at a single country each. This is targeting, not a provider region breakdown — those are not fetched.',
      recommendedAction: `Consider weighting budget toward ${winner.label}. Nothing is changed automatically.`,
      confidence: confidenceFor({
        groupSize: ranked.length,
        days,
        deliveryRatio: metric === 'cpa' ? winner.totals.conversions / 5 : winner.totals.impressions / 1000,
      }),
      dataSources: ['AdPublication', 'AnalyticsSnapshot'],
      evidence: [
        {
          kind: 'OBSERVED',
          metric: metric.toUpperCase(),
          value: format(winner.totals[metric]!),
          comparison: `${weakest.label}: ${format(weakest.totals[metric]!)}`,
          detail: `${winner.days} day(s) of measured data.`,
        },
        {
          kind: 'INFERRED',
          metric: 'Attribution',
          value: 'Campaign targeting',
          detail: 'Campaigns naming more than one country are excluded, because their performance cannot be attributed to one place.',
        },
      ],
      platform: null,
      campaignId: null,
      creativeId: null,
      publicationId: null,
      location: winner.key,
      proposedChange: null,
    }];
  }

  return [insufficient({
    key: 'LOCATION',
    type: RecommendationType.LOCATION_OPPORTUNITY,
    title: 'Location comparison',
    reason: canCompare(entries, 'cpa').reason ?? 'Insufficient data to compare locations.',
    dataSources: ['AdPublication', 'AnalyticsSnapshot'],
  })];
}

/** §23 — a change against the immediately preceding period of equal length. */
function anomalies(
  current: Loaded,
  previous: Loaded['snapshots'],
  days: number,
): Insight[] {
  if (previous.length === 0 || current.snapshots.length === 0) {
    return [insufficient({
      key: 'ANOMALY',
      type: RecommendationType.PERFORMANCE_ANOMALY,
      title: 'Change detection',
      reason: previous.length === 0
        ? 'No comparison period exists yet, so no change can be measured against it.'
        : 'No performance was fetched for the current period.',
      dataSources: ['AnalyticsSnapshot'],
    })];
  }

  const now = derive(sumSnapshots(current.snapshots));
  const before = derive(sumSnapshots(previous));
  const found: Insight[] = [];

  const checks: Array<{
    metric: 'ctr' | 'cpc' | 'cpa';
    worseWhen: 'UP' | 'DOWN';
    label: string;
  }> = [
    { metric: 'ctr', worseWhen: 'DOWN', label: 'Click-through rate' },
    { metric: 'cpc', worseWhen: 'UP', label: 'Cost per click' },
    { metric: 'cpa', worseWhen: 'UP', label: 'Cost per acquisition' },
  ];

  for (const check of checks) {
    const currentValue = now[check.metric];
    const previousValue = before[check.metric];

    if (!isMaterialChange({
      current: currentValue,
      previous: previousValue,
      minRelative: 0.2,
      currentSample: current.snapshots.length,
      previousSample: previous.length,
    })) continue;

    const change = (currentValue! - previousValue!) / previousValue!;
    const worse = check.worseWhen === 'UP' ? change > 0 : change < 0;
    if (!worse) continue;

    const format = check.metric === 'ctr' ? percent : (value: number) => money(value, current.currency);

    found.push({
      key: `ANOMALY_${check.metric.toUpperCase()}`,
      type: RecommendationType.PERFORMANCE_ANOMALY,
      priority: 'P1',
      state: 'AT_RISK',
      title: `${check.label} moved ${percent(Math.abs(change))} against the previous ${days} days`,
      finding: `${format(currentValue!)} now, against ${format(previousValue!)} previously.`,
      reason: 'Measured against the immediately preceding period of equal length. Both periods carry fetched data.',
      recommendedAction: 'Review what changed — creative, audience or competition — before adjusting spend.',
      confidence: confidenceFor({
        groupSize: 4,
        days,
        deliveryRatio: now.impressions / 1000,
      }),
      dataSources: ['AnalyticsSnapshot'],
      evidence: [
        {
          kind: 'OBSERVED',
          metric: check.label,
          value: format(currentValue!),
          comparison: `Previous period: ${format(previousValue!)}`,
          detail: `${days} day window against the ${days} days before it.`,
        },
        {
          kind: 'INFERRED',
          metric: 'Change',
          value: percent(Math.abs(change)),
          detail: 'Relative move between the two periods.',
        },
      ],
      platform: null,
      campaignId: null,
      creativeId: null,
      publicationId: null,
      location: null,
      proposedChange: null,
    });
  }

  return found.length > 0 ? found : [{
    key: 'ANOMALY',
    type: RecommendationType.PERFORMANCE_ANOMALY,
    priority: 'P3',
    state: 'PERFORMING',
    title: 'No material change against the previous period',
    finding: 'Click-through rate, cost per click and cost per acquisition all moved less than 20%.',
    reason: 'Small moves on small numbers are noise; only relative changes above 20% are reported.',
    recommendedAction: null,
    confidence: 'MEDIUM',
    dataSources: ['AnalyticsSnapshot'],
    evidence: [],
    platform: null,
    campaignId: null,
    creativeId: null,
    publicationId: null,
    location: null,
    proposedChange: null,
  }];
}

/** §24 — what the provider or the connection is blocking, from existing state. */
function accountAlerts(loaded: Loaded): Insight[] {
  const found: Insight[] = [];

  for (const publication of loaded.publications) {
    const verdict = adStatusOf({
      status: publication.status as never,
      providerStatus: publication.providerStatus,
      endDate: publication.endDate,
      errorMessage: publication.errorMessage,
    });
    if (!ATTENTION_STATUSES.includes(verdict.status)) continue;

    found.push({
      key: `ALERT_${publication.id}`,
      type: verdict.status === 'NEEDS_ATTENTION'
        ? RecommendationType.REAUTHORIZE_ACCOUNT
        : RecommendationType.PAUSE_AD,
      priority: 'P0',
      state: 'AT_RISK',
      title: `${publication.name} — ${verdict.status.toLowerCase().replace('_', ' ')}`,
      finding: publication.errorMessage ?? verdict.detail,
      reason: 'Reported by the provider. This is the provider\'s own message, not an interpretation of it.',
      recommendedAction: verdict.status === 'NEEDS_ATTENTION'
        ? 'Reconnect the account under Integrations.'
        : 'Review the advertisement and resubmit it.',
      confidence: 'HIGH',
      dataSources: ['AdPublication'],
      evidence: [{
        kind: 'OBSERVED',
        metric: 'Provider status',
        value: verdict.providerStatus ?? verdict.status,
        detail: verdict.detail,
      }],
      platform: publication.platform,
      campaignId: publication.campaignId,
      creativeId: publication.creativeId,
      publicationId: publication.id,
      location: publication.countries[0] ?? null,
      proposedChange: null,
    });
  }

  // A missing credential is a data-quality problem, not a campaign problem.
  for (const integration of loaded.integrations) {
    const paid = matrixFor(integration.platform).paid;
    if (paid.state !== 'NOT_CONFIGURED') continue;

    found.push({
      key: `ALERT_CONFIG_${integration.platform}`,
      type: RecommendationType.DATA_QUALITY,
      priority: 'P1',
      state: 'AT_RISK',
      title: `${PLATFORM_LABELS[integration.platform]} advertising is not configured`,
      finding: paid.capabilities.find((capability) => capability.surface === 'CAMPAIGNS')?.detail ?? '',
      reason: 'The integration is built but this deployment holds no credential for it, so nothing can be published or measured.',
      recommendedAction: 'Set the required variables on the server, then reconnect the account.',
      confidence: 'HIGH',
      dataSources: ['Capability matrix', 'Integration status'],
      evidence: [{
        kind: 'OBSERVED',
        metric: 'Configuration',
        value: 'Missing credentials',
        detail: (paid.capabilities.find((capability) => capability.surface === 'CAMPAIGNS')?.requiredEnv ?? []).join(', '),
      }],
      platform: integration.platform,
      campaignId: null,
      creativeId: null,
      publicationId: null,
      location: null,
      proposedChange: null,
    });
  }

  return found.slice(0, 20);
}

/** §16 — audience data this deployment does not have, stated rather than faked. */
function audience(loaded: Loaded): Insight[] {
  /*
   * Meta, TikTok and Google all expose audience breakdowns. None of them are
   * ingested here — `AnalyticsSnapshot` has no demographic dimension and
   * nothing writes one. Inventing segments from campaign targeting would be
   * reporting what was *asked for* as what was *delivered*.
   */
  const platforms = [...new Set(loaded.publications.map((row) => row.platform))];
  return [{
    key: 'AUDIENCE',
    type: RecommendationType.REVIEW_AUDIENCE,
    priority: 'P3',
    state: 'INSUFFICIENT_DATA',
    title: 'Audience data unavailable',
    finding: 'No audience or demographic breakdown is fetched from any provider.',
    reason: 'Performance is stored per campaign, platform and day. There is no demographic dimension to analyse, and deriving segments from campaign targeting would report what was requested as what was delivered.',
    recommendedAction: null,
    confidence: 'LOW',
    dataSources: ['AnalyticsSnapshot'],
    evidence: [{
      kind: 'OBSERVED',
      metric: 'Available dimensions',
      value: 'campaign, platform, day',
      detail: platforms.length > 0
        ? `Checked for ${platforms.map((platform) => PLATFORM_LABELS[platform]).join(', ')}.`
        : 'No advertising platforms are connected.',
    }],
    platform: null,
    campaignId: null,
    creativeId: null,
    publicationId: null,
    location: null,
    proposedChange: null,
  }];
}

/** §11/§12 — budget, proposed only, never applied. */
function budget(loaded: Loaded, days: number): Insight[] {
  const names = new Map(loaded.publications.map((row) => [row.campaignId ?? '', row.name]));
  const entries = group(loaded.snapshots, (row) => row.campaignId, (key) => names.get(key) ?? 'Campaign');

  const verdict = canCompare(entries, 'cpa');
  if (verdict.sufficiency !== 'SUFFICIENT') {
    return [insufficient({
      key: 'BUDGET',
      type: RecommendationType.REALLOCATE_BUDGET,
      title: 'Budget allocation',
      reason: verdict.reason
        ?? 'Not enough conversion data to recommend a budget change. A numeric recommendation is not offered without it.',
      dataSources: ['AnalyticsSnapshot', 'AdPublication'],
    })];
  }

  const ranked = rank(entries.filter((entry) => entry.totals.cpa !== null), 'cpa');
  const best = ranked[0];
  const worst = ranked[ranked.length - 1];
  if (!best || !worst || best.key === worst.key) return [];

  const bestBudget = loaded.publications.find((row) => row.campaignId === best.key)?.dailyBudget ?? null;

  return [{
    key: 'BUDGET_REALLOCATE',
    type: RecommendationType.REALLOCATE_BUDGET,
    priority: 'P1',
    state: 'PERFORMING',
    title: `Consider moving budget from ${worst.label} to ${best.label}`,
    finding: `${best.label} acquires at ${money(best.totals.cpa!, loaded.currency)} against ${money(worst.totals.cpa!, loaded.currency)} for ${worst.label}.`,
    reason: 'Both campaigns delivered enough conversions to be compared on cost per acquisition over the same window.',
    recommendedAction: 'Review and approve before changing any budget. Nothing here changes spend on its own.',
    confidence: confidenceFor({
      groupSize: ranked.length,
      days,
      deliveryRatio: best.totals.conversions / 5,
    }),
    dataSources: ['AnalyticsSnapshot', 'AdPublication'],
    evidence: [
      {
        kind: 'OBSERVED',
        metric: 'CPA',
        value: money(best.totals.cpa!, loaded.currency),
        comparison: `${worst.label}: ${money(worst.totals.cpa!, loaded.currency)}`,
        detail: `${best.days} day(s) of measured data each.`,
      },
      {
        kind: 'OBSERVED',
        metric: 'Conversions',
        value: nOf(best.totals.conversions),
        comparison: `${worst.label}: ${nOf(worst.totals.conversions)}`,
        detail: 'Measured conversions behind each figure.',
      },
      {
        kind: 'INFERRED',
        metric: 'Suggested direction',
        value: 'Shift toward the lower CPA',
        detail: 'No amount is proposed: the right size of a shift depends on headroom this engine cannot measure.',
      },
    ],
    platform: null,
    campaignId: best.key,
    creativeId: null,
    publicationId: null,
    location: null,
    // Named, but never applied — the route has no path that writes a budget.
    proposedChange: bestBudget === null
      ? null
      : { field: 'dailyBudget', from: bestBudget, to: null },
  }];
}

// ------------------------------------------------------------------ entry

export interface InsightsInput {
  prisma: PrismaClient;
  actor: Actor;
  clientId?: string;
  from: Date;
  to: Date;
  platform?: Platform;
  now?: Date;
}

export async function advertisingInsights(input: InsightsInput): Promise<InsightsReport> {
  const days = Math.max(1, Math.round((input.to.getTime() - input.from.getTime()) / 86_400_000));
  const loaded = await load(input.prisma, input.actor, input.from, input.to, input.clientId);

  // The immediately preceding window of equal length, for change detection.
  const previousFrom = new Date(input.from.getTime() - days * 86_400_000);
  const previousSnapshots = await input.prisma.analyticsSnapshot.findMany({
    where: {
      ...scopeWhere(input.actor),
      ...(input.clientId ? { clientId: input.clientId } : {}),
      date: { gte: previousFrom, lt: input.from },
    },
    select: {
      campaignId: true, platform: true, date: true, spend: true, reach: true,
      impressions: true, clicks: true, conversions: true, revenue: true, engagements: true,
    },
  });

  const filtered: Loaded = input.platform
    ? {
      ...loaded,
      snapshots: loaded.snapshots.filter((row) => row.platform === input.platform),
      publications: loaded.publications.filter((row) => row.platform === input.platform),
    }
    : loaded;

  const creatives = await creativePerformance({
    prisma: input.prisma,
    organizationId: (scopeWhere(input.actor) as { organizationId: string }).organizationId,
    clientId: input.clientId,
    from: input.from,
    to: input.to,
  }).catch(() => null);

  const sections: InsightSection[] = [
    { key: 'WARNINGS', insights: accountAlerts(filtered) },
    { key: 'BEST_PLATFORM', insights: bestPlatform(filtered, days) },
    { key: 'BEST_CAMPAIGN', insights: bestCampaign(filtered, days) },
    { key: 'BUDGET', insights: budget(filtered, days) },
    { key: 'CREATIVE', insights: creativeInsights(creatives, filtered) },
    { key: 'LOCATION', insights: locations(filtered, days) },
    { key: 'ANOMALY', insights: anomalies(filtered, previousSnapshots, days) },
    { key: 'AUDIENCE', insights: audience(filtered) },
  ];

  const limitations: string[] = [];
  if (filtered.snapshots.length === 0) {
    limitations.push('No provider insights have been fetched for this period, so every performance comparison is unavailable rather than zero.');
  }
  for (const platform of new Set(filtered.publications.map((row) => row.platform))) {
    if (!supportsMetric(platform, 'reach' as PaidMetricName)) {
      limitations.push(`${PLATFORM_LABELS[platform]} does not report reach, so it is excluded from any reach comparison.`);
    }
  }

  return {
    window: { from: input.from.toISOString(), to: input.to.toISOString(), days },
    sections,
    limitations,
    dataSources: ['AnalyticsSnapshot', 'AdPublication', 'CreativePerformance', 'Integration status', 'Capability matrix'],
  };
}

/** §8/§9/§10 — winners, weak performers and possible fatigue. */
function creativeInsights(
  report: Awaited<ReturnType<typeof creativePerformance>> | null,
  loaded: Loaded,
): Insight[] {
  if (!report || report.rows.length === 0) {
    return [insufficient({
      key: 'CREATIVE',
      type: RecommendationType.WINNING_CREATIVE,
      title: 'Creative comparison',
      reason: 'No creative-level performance has been fetched for this period.',
      dataSources: ['CreativePerformance'],
    })];
  }

  const found: Insight[] = [];
  const nameOf = (creativeId: string) => `Creative ${creativeId.slice(-6)}`;

  /*
   * The verdicts come from the existing analyzer, thresholds and all. Nothing
   * here re-decides what a winner is — a creative it called INSUFFICIENT_DATA
   * cannot become a winner by being looked at again from this file, and its
   * `verdictReason` already carries the numbers behind the call.
   */
  for (const row of report.rows.filter((entry) => entry.verdict === 'WINNER').slice(0, 3)) {
    found.push({
      key: `CREATIVE_WINNER_${row.creativeId}`,
      type: RecommendationType.WINNING_CREATIVE,
      priority: 'P2',
      state: 'PERFORMING',
      title: `${nameOf(row.creativeId)} is outperforming its comparison set`,
      finding: row.verdictReason,
      reason: 'Judged by the existing creative performance analyzer against creatives with comparable delivery in the same period.',
      recommendedAction: 'Consider adapting this creative into organic content, and testing variants of it.',
      confidence: row.days >= MIN_TREND_DAYS ? 'MEDIUM' : 'LOW',
      dataSources: ['CreativePerformance'],
      evidence: [
        {
          kind: 'OBSERVED',
          metric: 'CTR',
          value: row.totals.ctr === null ? 'Not measured' : percent(row.totals.ctr),
          detail: `${nOf(row.totals.impressions)} impressions over ${row.days} day(s).`,
        },
        {
          kind: 'OBSERVED',
          metric: 'Spend',
          value: money(row.totals.spend, row.currency || loaded.currency),
          detail: `First seen ${row.firstSeen ?? 'unknown'}, last seen ${row.lastSeen ?? 'unknown'}.`,
        },
      ],
      platform: row.platform,
      campaignId: row.campaignIds[0] ?? null,
      creativeId: row.creativeId,
      publicationId: null,
      location: null,
      proposedChange: null,
    });
  }

  for (const row of report.rows.filter((entry) => entry.verdict === 'WEAK').slice(0, 3)) {
    found.push({
      key: `CREATIVE_WEAK_${row.creativeId}`,
      type: RecommendationType.PAUSE_CREATIVE,
      priority: 'P1',
      state: 'UNDERPERFORMING',
      title: `${nameOf(row.creativeId)} is underperforming its comparison set`,
      finding: row.verdictReason,
      reason: 'Compared against creatives with comparable delivery in the same period, not against an invented benchmark.',
      recommendedAction: 'Review this creative before it spends more. Nothing is paused automatically.',
      confidence: row.days >= MIN_TREND_DAYS ? 'MEDIUM' : 'LOW',
      dataSources: ['CreativePerformance'],
      evidence: [
        {
          kind: 'OBSERVED',
          metric: 'CTR',
          value: row.totals.ctr === null ? 'Not measured' : percent(row.totals.ctr),
          detail: `${nOf(row.totals.impressions)} impressions over ${row.days} day(s).`,
        },
        {
          kind: 'OBSERVED',
          metric: 'Spend',
          value: money(row.totals.spend, row.currency || loaded.currency),
          detail: 'Spent while underperforming.',
        },
      ],
      platform: row.platform,
      campaignId: row.campaignIds[0] ?? null,
      creativeId: row.creativeId,
      publicationId: null,
      location: null,
      proposedChange: null,
    });
  }

  found.push(...fatigue(report.rows, loaded));

  if (found.length === 0) {
    return [insufficient({
      key: 'CREATIVE',
      type: RecommendationType.WINNING_CREATIVE,
      title: 'Creative comparison',
      reason: 'No creative delivered enough in this period to be called a winner or a weak performer.',
      dataSources: ['CreativePerformance'],
    })];
  }

  return found;
}

/**
 * §10 — possible creative fatigue, from a creative's own trend against itself.
 *
 * Deliberately "possible". Fatigue is one explanation for a declining
 * click-through rate; a seasonal dip, a competitor's campaign or a landing page
 * outage are others, and none of them are distinguishable from this data. The
 * finding states the decline, which is measured, and names fatigue as a
 * candidate rather than a diagnosis.
 *
 * Requires the creative's own history split into two halves of at least
 * MIN_TREND_DAYS each — a single data point cannot decline, and comparing a
 * creative to *other* creatives would be a different claim entirely.
 */
function fatigue(
  rows: Awaited<ReturnType<typeof creativePerformance>>['rows'],
  loaded: Loaded,
): Insight[] {
  const found: Insight[] = [];

  for (const row of rows) {
    if (row.trend.length < MIN_TREND_DAYS * 2) continue;

    const half = Math.floor(row.trend.length / 2);
    const earlier = row.trend.slice(0, half);
    const later = row.trend.slice(half);

    const sum = (points: typeof row.trend, key: 'clicks' | 'spend') =>
      points.reduce((total, point) => total + point[key], 0);

    const earlierClicks = sum(earlier, 'clicks');
    const laterClicks = sum(later, 'clicks');
    const earlierSpend = sum(earlier, 'spend');
    const laterSpend = sum(later, 'spend');

    // Cost per click against itself: the one ratio both halves can produce
    // from the daily trend the analyzer already stores.
    const earlierCpc = earlierClicks > 0 ? earlierSpend / earlierClicks : null;
    const laterCpc = laterClicks > 0 ? laterSpend / laterClicks : null;

    if (!isMaterialChange({
      current: laterCpc,
      previous: earlierCpc,
      minRelative: 0.25,
      currentSample: later.length,
      previousSample: earlier.length,
    })) continue;

    // Only a *rise* in cost per click suggests fatigue; a fall is the opposite.
    if (laterCpc === null || earlierCpc === null || laterCpc <= earlierCpc) continue;

    const change = (laterCpc - earlierCpc) / earlierCpc;

    found.push({
      key: `CREATIVE_FATIGUE_${row.creativeId}`,
      type: RecommendationType.CREATIVE_FATIGUE,
      priority: 'P2',
      state: 'AT_RISK',
      title: `Possible creative fatigue on Creative ${row.creativeId.slice(-6)}`,
      finding: `Cost per click rose ${percent(change)} between the first and second half of this creative's run.`,
      reason: 'Fatigue is one explanation for a rising cost per click; a seasonal dip, a competitor or a landing page problem are others, and this data cannot tell them apart.',
      recommendedAction: 'Consider refreshing the creative, and check whether anything else changed over the same period.',
      confidence: row.trend.length >= MIN_TREND_DAYS * 4 ? 'MEDIUM' : 'LOW',
      dataSources: ['CreativePerformance'],
      evidence: [
        {
          kind: 'OBSERVED',
          metric: 'Cost per click, second half',
          value: money(laterCpc, row.currency || loaded.currency),
          comparison: `First half: ${money(earlierCpc, row.currency || loaded.currency)}`,
          detail: `${earlier.length} day(s) against ${later.length} day(s), from this creative's own history.`,
        },
        {
          kind: 'INFERRED',
          metric: 'Change',
          value: percent(change),
          detail: 'Relative rise between the two halves.',
        },
      ],
      platform: row.platform,
      campaignId: row.campaignIds[0] ?? null,
      creativeId: row.creativeId,
      publicationId: null,
      location: null,
      proposedChange: null,
    });
  }

  return found.slice(0, 3);
}

export { MIN_TREND_DAYS };

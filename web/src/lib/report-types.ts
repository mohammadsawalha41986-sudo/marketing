/**
 * The Report Builder's payloads, mirroring `services/reports/builder.ts`.
 *
 * `MetricState` is Phase 14's vocabulary and is repeated here rather than
 * loosened to `string`, because the whole correctness argument of this feature
 * is that the four states stay distinguishable all the way to the printed page.
 * A widened type here would let a renderer treat them as interchangeable.
 */

import type { Platform } from './api';

export type MetricState = 'ZERO' | 'UNAVAILABLE' | 'NOT_FETCHED' | 'PROVIDER_ERROR';

export const REPORT_METRICS = [
  'engagements', 'reach', 'impressions', 'likes', 'comments', 'shares', 'saves', 'clicks',
] as const;

export type ReportMetric = (typeof REPORT_METRICS)[number];

export const REPORT_SECTIONS = [
  'OVERVIEW', 'PLATFORMS', 'TOP_CONTENT', 'ENGAGEMENT', 'REACH',
] as const;

export type ReportSection = (typeof REPORT_SECTIONS)[number];

export interface ReportConfig {
  version: 1;
  description: string | null;
  platforms: Platform[];
  metrics: ReportMetric[];
  sections: ReportSection[];
}

/**
 * A figure that knows whether it is one.
 *
 * `value` is null for every state except ZERO. The renderer keys off that
 * rather than off `state`, so an absent metric cannot be printed as 0 even by
 * a caller that ignores the state field.
 */
export interface QualifiedMetric {
  metric: ReportMetric;
  value: number | null;
  state: MetricState;
  note: string | null;
}

export interface OrganicMetric {
  value: number | null;
  state: MetricState;
}

export interface ReportPost {
  platformPostId: string;
  platform: Platform;
  platformLabel: string;
  postGroupId: string;
  caption: string | null;
  status: string;
  publishedAt: string | null;
  externalPostId: string | null;
  metrics: Record<
    'likes' | 'comments' | 'shares' | 'saves' | 'reach' | 'impressions' | 'engagements' | 'clicks',
    OrganicMetric
  >;
}

export interface PlatformBreakdown {
  platform: Platform;
  label: string;
  publishedCount: number;
  metrics: QualifiedMetric[];
}

export interface ReportData {
  period: { from: string; to: string };
  platforms: Platform[];
  totals: QualifiedMetric[];
  breakdown: PlatformBreakdown[];
  topPosts: ReportPost[];
  totalPosts: number;
  publishedPosts: number;
  insufficientData: boolean;
}

export interface BuilderReportRow {
  id: string;
  title: string;
  type: string;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
  payload?: { builder?: Partial<ReportConfig> };
  client: { id: string; name: string; businessName?: string; logoUrl: string | null };
}

/** Preset periods, as day counts. `null` is the custom case. */
export const PERIOD_PRESETS: Array<{ key: string; days: number | null }> = [
  { key: '7', days: 7 },
  { key: '14', days: 14 },
  { key: '30', days: 30 },
  { key: '90', days: 90 },
  { key: 'custom', days: null },
];

export const DEFAULT_CONFIG: ReportConfig = {
  version: 1,
  description: null,
  platforms: [],
  metrics: ['engagements', 'reach', 'impressions'],
  sections: [...REPORT_SECTIONS],
};

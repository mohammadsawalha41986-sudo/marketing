/**
 * Analytics over PlatformPost — organic social post performance.
 *
 * Unlike paid ads (AnalyticsSnapshot), organic posts report engagement
 * metrics: likes, comments, shares, saves, reach, impressions. These come
 * from the platform's post insights API and are stored on the PlatformPost
 * itself.
 *
 * The four states a metric can be in, and what each means:
 *   - ZERO:          the metric was fetched and the platform said 0
 *   - UNAVAILABLE:   the platform does not report this metric for this post type
 *   - NOT_FETCHED:   we have not asked the platform for this metric yet
 *   - PROVIDER_ERROR: we asked and the platform refused or failed
 *
 * These are not the same thing, and code that treats them identically will
 * draw the wrong chart. Zero likes is a result; unfetched likes is an
 * absence of a result.
 */

import { Platform, PlatformPostStatus } from '@prisma/client';

import { prisma } from '../../lib/prisma.js';
import { PLATFORM_LABELS } from '../analytics.js';

export type MetricState = 'ZERO' | 'UNAVAILABLE' | 'NOT_FETCHED' | 'PROVIDER_ERROR';

export interface OrganicMetric {
  value: number | null;
  state: MetricState;
}

export interface PostAnalytics {
  platformPostId: string;
  platform: Platform;
  platformLabel: string;
  postGroupId: string;
  caption: string | null;
  status: PlatformPostStatus;
  publishedAt: Date | null;
  externalPostId: string | null;
  metrics: {
    likes: OrganicMetric;
    comments: OrganicMetric;
    shares: OrganicMetric;
    saves: OrganicMetric;
    reach: OrganicMetric;
    impressions: OrganicMetric;
    engagements: OrganicMetric;
    clicks: OrganicMetric;
  };
}

export interface PostGroupAnalytics {
  postGroupId: string;
  name: string;
  posts: PostAnalytics[];
  totals: {
    likes: number;
    comments: number;
    shares: number;
    saves: number;
    reach: number;
    impressions: number;
    engagements: number;
    clicks: number;
  };
  engagementRate: number | null;
  engagementRateReason: string | null;
}

export interface SocialOverview {
  totalPosts: number;
  publishedPosts: number;
  platforms: Array<{
    platform: Platform;
    label: string;
    publishedCount: number;
    totalEngagements: number;
    totalReach: number;
    totalImpressions: number;
  }>;
  topPosts: PostAnalytics[];
  periodTotals: {
    likes: number;
    comments: number;
    shares: number;
    saves: number;
    reach: number;
    impressions: number;
    engagements: number;
    clicks: number;
  };
}

const METRICS_SUPPORTED: Record<Platform, Set<string>> = {
  [Platform.FACEBOOK]: new Set(['likes', 'comments', 'shares', 'reach', 'impressions', 'engagements', 'clicks']),
  [Platform.INSTAGRAM]: new Set(['likes', 'comments', 'shares', 'saves', 'reach', 'impressions', 'engagements']),
  [Platform.TIKTOK]: new Set(['likes', 'comments', 'shares', 'reach', 'impressions', 'engagements']),
  [Platform.YOUTUBE]: new Set(['likes', 'comments', 'shares', 'reach', 'impressions', 'engagements']),
  [Platform.LINKEDIN]: new Set(['likes', 'comments', 'shares', 'impressions', 'engagements', 'clicks']),
  [Platform.GOOGLE_BUSINESS]: new Set(['impressions', 'clicks', 'engagements']),
  [Platform.X]: new Set(['likes', 'comments', 'shares', 'reach', 'impressions', 'engagements']),
  [Platform.SNAPCHAT]: new Set([]),
  [Platform.GOOGLE_ADS]: new Set([]),
};

function metricState(
  platform: Platform,
  metricName: string,
  value: number | null,
  isPublished: boolean,
  hasError: boolean,
): OrganicMetric {
  const supported = METRICS_SUPPORTED[platform];
  if (!supported?.has(metricName)) {
    return { value: null, state: 'UNAVAILABLE' };
  }
  if (!isPublished) {
    return { value: null, state: 'NOT_FETCHED' };
  }
  if (hasError) {
    return { value: null, state: 'PROVIDER_ERROR' };
  }
  if (value === null) {
    return { value: null, state: 'NOT_FETCHED' };
  }
  return { value, state: 'ZERO' };
}

function buildMetrics(
  platform: Platform,
  metrics: Record<string, number | null> | null,
  isPublished: boolean,
  hasError: boolean,
): PostAnalytics['metrics'] {
  const m = metrics ?? {};
  return {
    likes: metricState(platform, 'likes', m.likes ?? null, isPublished, hasError),
    comments: metricState(platform, 'comments', m.comments ?? null, isPublished, hasError),
    shares: metricState(platform, 'shares', m.shares ?? null, isPublished, hasError),
    saves: metricState(platform, 'saves', m.saves ?? null, isPublished, hasError),
    reach: metricState(platform, 'reach', m.reach ?? null, isPublished, hasError),
    impressions: metricState(platform, 'impressions', m.impressions ?? null, isPublished, hasError),
    engagements: metricState(platform, 'engagements', m.engagements ?? null, isPublished, hasError),
    clicks: metricState(platform, 'clicks', m.clicks ?? null, isPublished, hasError),
  };
}

function safeValue(metric: OrganicMetric): number {
  return metric.value ?? 0;
}

export async function postGroupAnalytics(postGroupId: string, organizationId: string): Promise<PostGroupAnalytics | null> {
  const group = await prisma.postGroup.findFirst({
    where: { id: postGroupId, organizationId },
    include: {
      posts: {
        select: {
          id: true, platform: true, caption: true, status: true,
          publishedAt: true, externalPostId: true, config: true,
          errorMessage: true,
        },
      },
    },
  });
  if (!group) return null;

  const posts: PostAnalytics[] = group.posts.map((post) => {
    const isPublished = post.status === PlatformPostStatus.PUBLISHED;
    const hasError = Boolean(post.errorMessage);
    const metrics = (post.config as Record<string, unknown> | null)?.metrics as Record<string, number | null> | null ?? null;

    return {
      platformPostId: post.id,
      platform: post.platform,
      platformLabel: PLATFORM_LABELS[post.platform],
      postGroupId: group.id,
      caption: post.caption,
      status: post.status,
      publishedAt: post.publishedAt,
      externalPostId: post.externalPostId,
      metrics: buildMetrics(post.platform, metrics, isPublished, hasError),
    };
  });

  const totals = {
    likes: posts.reduce((sum, p) => sum + safeValue(p.metrics.likes), 0),
    comments: posts.reduce((sum, p) => sum + safeValue(p.metrics.comments), 0),
    shares: posts.reduce((sum, p) => sum + safeValue(p.metrics.shares), 0),
    saves: posts.reduce((sum, p) => sum + safeValue(p.metrics.saves), 0),
    reach: posts.reduce((sum, p) => sum + safeValue(p.metrics.reach), 0),
    impressions: posts.reduce((sum, p) => sum + safeValue(p.metrics.impressions), 0),
    engagements: posts.reduce((sum, p) => sum + safeValue(p.metrics.engagements), 0),
    clicks: posts.reduce((sum, p) => sum + safeValue(p.metrics.clicks), 0),
  };

  const engagementRate = totals.impressions > 0 ? totals.engagements / totals.impressions : null;
  const engagementRateReason = totals.impressions === 0 ? 'No impressions were served' : null;

  return {
    postGroupId: group.id,
    name: group.name,
    posts,
    totals,
    engagementRate,
    engagementRateReason,
  };
}

export async function socialOverview(
  organizationId: string,
  clientId?: string,
  from?: Date,
  to?: Date,
): Promise<SocialOverview> {
  const where: Record<string, unknown> = { organizationId };
  if (clientId) where.clientId = clientId;

  const postWhere: Record<string, unknown> = {};
  if (from || to) {
    postWhere.publishedAt = {};
    if (from) (postWhere.publishedAt as Record<string, Date>).gte = from;
    if (to) (postWhere.publishedAt as Record<string, Date>).lte = to;
  }

  const groups = await prisma.postGroup.findMany({
    where,
    include: {
      posts: {
        where: postWhere,
        select: {
          id: true, platform: true, caption: true, status: true,
          publishedAt: true, externalPostId: true, config: true,
          errorMessage: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  const allPosts: PostAnalytics[] = [];
  const platformMap = new Map<Platform, { publishedCount: number; totalEngagements: number; totalReach: number; totalImpressions: number }>();

  for (const group of groups) {
    for (const post of group.posts) {
      const isPublished = post.status === PlatformPostStatus.PUBLISHED;
      const hasError = Boolean(post.errorMessage);
      const metrics = (post.config as Record<string, unknown> | null)?.metrics as Record<string, number | null> | null ?? null;

      const pa: PostAnalytics = {
        platformPostId: post.id,
        platform: post.platform,
        platformLabel: PLATFORM_LABELS[post.platform],
        postGroupId: group.id,
        caption: post.caption,
        status: post.status,
        publishedAt: post.publishedAt,
        externalPostId: post.externalPostId,
        metrics: buildMetrics(post.platform, metrics, isPublished, hasError),
      };
      allPosts.push(pa);

      const entry = platformMap.get(post.platform) ?? { publishedCount: 0, totalEngagements: 0, totalReach: 0, totalImpressions: 0 };
      if (isPublished) entry.publishedCount += 1;
      entry.totalEngagements += safeValue(pa.metrics.engagements);
      entry.totalReach += safeValue(pa.metrics.reach);
      entry.totalImpressions += safeValue(pa.metrics.impressions);
      platformMap.set(post.platform, entry);
    }
  }

  const publishedPosts = allPosts.filter((p) => p.status === PlatformPostStatus.PUBLISHED);
  const topPosts = [...publishedPosts]
    .sort((a, b) => safeValue(b.metrics.engagements) - safeValue(a.metrics.engagements))
    .slice(0, 10);

  const periodTotals = {
    likes: allPosts.reduce((sum, p) => sum + safeValue(p.metrics.likes), 0),
    comments: allPosts.reduce((sum, p) => sum + safeValue(p.metrics.comments), 0),
    shares: allPosts.reduce((sum, p) => sum + safeValue(p.metrics.shares), 0),
    saves: allPosts.reduce((sum, p) => sum + safeValue(p.metrics.saves), 0),
    reach: allPosts.reduce((sum, p) => sum + safeValue(p.metrics.reach), 0),
    impressions: allPosts.reduce((sum, p) => sum + safeValue(p.metrics.impressions), 0),
    engagements: allPosts.reduce((sum, p) => sum + safeValue(p.metrics.engagements), 0),
    clicks: allPosts.reduce((sum, p) => sum + safeValue(p.metrics.clicks), 0),
  };

  return {
    totalPosts: allPosts.length,
    publishedPosts: publishedPosts.length,
    platforms: [...platformMap.entries()].map(([platform, data]) => ({
      platform,
      label: PLATFORM_LABELS[platform],
      ...data,
    })),
    topPosts,
    periodTotals,
  };
}

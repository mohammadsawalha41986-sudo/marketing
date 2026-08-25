/**
 * Contextual marketing recommendations for one platform post.
 *
 * The rule this module is built around: a recommendation is either derived from
 * this organisation's own published posts, or it is labelled as coming from
 * business context instead. It is never presented as measured when it was not.
 *
 * That is why every recommendation carries a `basis`:
 *
 *   - HISTORICAL — computed from this client's published posts and the
 *     engagement the platform reported for them.
 *   - CONTEXT    — derived from the brand, the platform's own conventions and
 *     the post's own content. Useful, but not evidence about this audience.
 *
 * and why `insufficientData` is a first-class field rather than a silent
 * fallback. An operator told "post at 7:30pm on Tuesday" deserves to know
 * whether that came from their own numbers or from a sensible default, because
 * the two justify very different amounts of confidence.
 *
 * Nothing here invents a metric. `sampleSize` is the number of published posts
 * the recommendation actually rests on, and when it is below THRESHOLD the
 * recommendation says so rather than dressing up a guess.
 *
 * Read-only with respect to Phase 14: it reads the same `config.metrics` that
 * analytics writes and reads, and changes nothing about it.
 */

import { Platform, PlatformPostStatus, type PrismaClient } from '@prisma/client';

import { capabilityFor } from './capabilities.js';
import { platformRule } from '../ai/context.js';

/** Below this many published posts, history is not worth calling evidence. */
const THRESHOLD = 5;

export type Basis = 'HISTORICAL' | 'CONTEXT';
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface Recommendation {
  /** Stable key so the UI can render each section without string matching. */
  key:
    | 'BEST_TIME' | 'BEST_DAY' | 'LOCATION' | 'AUDIENCE' | 'BEST_PLATFORM'
    | 'FORMAT' | 'HOOK' | 'CTA' | 'CAPTION' | 'HASHTAGS' | 'LANGUAGE' | 'ANGLE';
  /** The recommendation itself, ready to show. */
  value: string;
  /** Why — shown under the value. Always present; never filler. */
  reason: string;
  basis: Basis;
  confidence: Confidence;
  /** Published posts this rests on. 0 for a pure-context recommendation. */
  sampleSize: number;
}

export interface RecommendationReport {
  platformPostId: string;
  platform: Platform;
  /** True when history was too thin to compute anything from measurement. */
  insufficientData: boolean;
  /** Published posts available for this client and platform. */
  sampleSize: number;
  /** Present only when insufficientData — the sentence the UI shows. */
  insufficientDataMessage: string | null;
  recommendations: Recommendation[];
  /** 0–100. Derived from the post's own completeness, never from performance. */
  qualityScore: number;
  qualityFindings: string[];
}

interface HistoryRow {
  publishedAt: Date;
  engagements: number;
}

/** Published posts for this client and platform, with what the platform reported. */
async function loadHistory(
  prisma: PrismaClient,
  organizationId: string,
  clientId: string,
  platform: Platform,
): Promise<HistoryRow[]> {
  const posts = await prisma.platformPost.findMany({
    where: {
      platform,
      status: PlatformPostStatus.PUBLISHED,
      publishedAt: { not: null },
      postGroup: { organizationId, clientId },
    },
    select: { publishedAt: true, config: true },
    orderBy: { publishedAt: 'desc' },
    take: 200,
  });

  const rows: HistoryRow[] = [];
  for (const post of posts) {
    if (!post.publishedAt) continue;
    const metrics = (post.config as Record<string, unknown> | null)?.metrics as
      | Record<string, number | null>
      | undefined;
    const engagements = metrics?.engagements;
    // A post whose engagement was never fetched is not a zero-engagement post.
    // Including it as 0 would drag every average toward whichever hour we
    // happened to publish at and never measured.
    if (typeof engagements !== 'number' || !Number.isFinite(engagements)) continue;
    rows.push({ publishedAt: post.publishedAt, engagements });
  }
  return rows;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The bucket with the highest mean engagement, or null when nothing qualifies. */
function bestBucket<T extends string | number>(
  rows: HistoryRow[],
  keyOf: (row: HistoryRow) => T,
): { key: T; mean: number; count: number } | null {
  const buckets = new Map<T, { total: number; count: number }>();
  for (const row of rows) {
    const key = keyOf(row);
    const bucket = buckets.get(key) ?? { total: 0, count: 0 };
    bucket.total += row.engagements;
    bucket.count += 1;
    buckets.set(key, bucket);
  }

  let best: { key: T; mean: number; count: number } | null = null;
  for (const [key, bucket] of buckets) {
    const mean = bucket.total / bucket.count;
    if (!best || mean > best.mean) best = { key, mean, count: bucket.count };
  }
  return best;
}

function formatHour(hour: number): string {
  const suffix = hour < 12 ? 'AM' : 'PM';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:00 ${suffix}`;
}

/**
 * Completeness of the post itself, 0–100.
 *
 * Deliberately not a performance prediction. It scores what is present against
 * what this platform needs — text, media, a call to action, hashtags where they
 * matter — because that is knowable from the row in front of us. Calling a
 * prediction a "score" is how an operator ends up trusting a number nobody
 * measured.
 */
function scoreQuality(
  post: { caption: string | null; headline: string | null; hashtags: string[]; ctaLabel: string | null; linkUrl: string | null; mediaCount: number },
  platform: Platform,
): { score: number; findings: string[] } {
  const capability = capabilityFor(platform);
  const rule = platformRule(platform);
  const findings: string[] = [];
  let score = 0;

  const text = (post.caption ?? '').trim();
  if (text.length === 0) {
    findings.push('The post has no caption.');
  } else {
    score += 30;
    if (text.length > rule.captionMax) {
      findings.push(`The caption is ${text.length} characters; ${rule.note}`);
      score -= 10;
    }
  }

  if (post.mediaCount > 0) score += 30;
  else findings.push('No media attached. Posts with an image or video reach further on every platform here.');

  if (capability.hasHeadline) {
    if (post.headline?.trim()) score += 10;
    else findings.push(`${platform} shows a title separately from the body, and this post has none.`);
  } else {
    score += 10;
  }

  if (post.hashtags.length > 0) {
    score += 15;
    if (post.hashtags.length > rule.hashtags) {
      findings.push(`${post.hashtags.length} hashtags; this platform rewards about ${rule.hashtags}.`);
      score -= 5;
    }
  } else if (rule.hashtags > 0) {
    findings.push('No hashtags. This platform uses them for discovery.');
  } else {
    score += 15;
  }

  if (post.ctaLabel?.trim() || post.linkUrl?.trim()) score += 15;
  else findings.push('No call to action or link — nothing tells the reader what to do next.');

  return { score: Math.max(0, Math.min(100, score)), findings };
}

/** Confidence from how much evidence a recommendation actually has. */
function confidenceFor(sampleSize: number): Confidence {
  if (sampleSize >= 20) return 'HIGH';
  if (sampleSize >= THRESHOLD) return 'MEDIUM';
  return 'LOW';
}

export async function recommendForPost(input: {
  prisma: PrismaClient;
  organizationId: string;
  platformPostId: string;
}): Promise<RecommendationReport | null> {
  const { prisma, organizationId, platformPostId } = input;

  const post = await prisma.platformPost.findFirst({
    where: { id: platformPostId, postGroup: { organizationId } },
    select: {
      id: true, platform: true, caption: true, headline: true, hashtags: true,
      ctaLabel: true, linkUrl: true,
      media: { select: { id: true } },
      postGroup: {
        select: {
          clientId: true,
          client: {
            select: {
              businessName: true,
              location: true,
              // Audience and preferred language live on Brand DNA, which is the
              // bounded context the AI service already reads everywhere else.
              brand: { select: { targetAudience: true, location: true, preferredLanguage: true } },
            },
          },
        },
      },
    },
  });
  if (!post) return null;

  const platform = post.platform;
  const capability = capabilityFor(platform);
  const rule = platformRule(platform);
  const client = post.postGroup.client;
  // Brand DNA is optional; a client without it still gets context recommendations,
  // they are just thinner. Falling back to the client's own location keeps the
  // geo suggestion useful when only the profile is filled in.
  const audience = client.brand?.targetAudience?.trim() ?? '';
  const place = (client.brand?.location ?? client.location ?? '').trim();
  const language = client.brand?.preferredLanguage ?? 'EN';

  const history = await loadHistory(prisma, organizationId, post.postGroup.clientId, platform);
  const sampleSize = history.length;
  const enough = sampleSize >= THRESHOLD;

  const recommendations: Recommendation[] = [];

  // ---- timing ---------------------------------------------------------
  // Computed from real publish times and reported engagement when there is
  // enough of both; otherwise stated as a convention, and labelled as one.
  const hourBucket = enough ? bestBucket(history, (row) => row.publishedAt.getUTCHours()) : null;
  if (hourBucket) {
    recommendations.push({
      key: 'BEST_TIME',
      value: formatHour(hourBucket.key),
      reason: `Highest average engagement across ${hourBucket.count} published ${platform.toLowerCase()} post${hourBucket.count === 1 ? '' : 's'} at this hour.`,
      basis: 'HISTORICAL',
      // Confidence follows the winning bucket, not the overall sample. Twenty
      // posts spread over twenty hours is one post per hour, and calling that
      // MEDIUM would overstate a recommendation resting on a single result.
      confidence: confidenceFor(hourBucket.count),
      sampleSize: hourBucket.count,
    });
  } else {
    recommendations.push({
      key: 'BEST_TIME',
      value: '7:00 PM',
      reason: 'No measured posting history for this platform yet — this is the common evening peak for this market, not a measurement of your audience.',
      basis: 'CONTEXT',
      confidence: 'LOW',
      sampleSize: 0,
    });
  }

  const dayBucket = enough ? bestBucket(history, (row) => row.publishedAt.getUTCDay()) : null;
  if (dayBucket) {
    recommendations.push({
      key: 'BEST_DAY',
      value: DAYS[dayBucket.key] ?? 'Tuesday',
      reason: `Best average engagement of any weekday, across ${dayBucket.count} published post${dayBucket.count === 1 ? '' : 's'}.`,
      basis: 'HISTORICAL',
      confidence: confidenceFor(dayBucket.count),
      sampleSize: dayBucket.count,
    });
  } else {
    recommendations.push({
      key: 'BEST_DAY',
      value: 'Tuesday',
      reason: 'Based on general weekday engagement patterns. Publish a few posts and this will be computed from your own results.',
      basis: 'CONTEXT',
      confidence: 'LOW',
      sampleSize: 0,
    });
  }

  // ---- place and people ----------------------------------------------
  // Geo is only recommended where the platform actually carries it. Offering a
  // location for a platform whose organic API drops it is a promise the
  // publish call cannot keep.
  if (capability.geo.organic.length > 0) {
    recommendations.push({
      key: 'LOCATION',
      value: place || 'Set a location on the restaurant profile',
      reason: place
        ? `${platform} attaches a location to organic posts, and this is the location on ${client.businessName}'s profile.`
        : `${platform} can attach a location to this post, but none is set on the restaurant profile yet.`,
      basis: 'CONTEXT',
      confidence: place ? 'MEDIUM' : 'LOW',
      sampleSize: 0,
    });
  }

  recommendations.push({
    key: 'AUDIENCE',
    value: audience || 'No target audience recorded',
    reason: audience
      ? `From ${client.businessName}'s Brand DNA. Organic posts cannot be targeted — this describes who the writing should speak to.`
      : 'Add a target audience to Brand DNA and this will guide the caption and hook suggestions.',
    basis: 'CONTEXT',
    confidence: audience ? 'MEDIUM' : 'LOW',
    sampleSize: 0,
  });

  // ---- craft ----------------------------------------------------------
  recommendations.push({
    key: 'FORMAT',
    value: capability.formats[0] ?? 'IMAGE',
    reason: `${capability.formats.slice(0, 3).join(', ')} are what this platform surfaces best, in that order.`,
    basis: 'CONTEXT',
    confidence: 'MEDIUM',
    sampleSize: 0,
  });

  recommendations.push({
    key: 'HOOK',
    value: `Open with the single most specific thing about ${client.businessName} — a dish, a price, a time.`,
    reason: `${platform} truncates after roughly ${Math.min(rule.captionMax, 125)} characters in the feed, so the first line is the whole pitch.`,
    basis: 'CONTEXT',
    confidence: 'MEDIUM',
    sampleSize: 0,
  });

  recommendations.push({
    key: 'CTA',
    value: capability.formats.includes('LINK') ? 'Order now' : 'Visit us today',
    reason: capability.formats.includes('LINK')
      ? 'This platform carries a link on organic posts, so send the reader somewhere.'
      : 'This platform does not carry a clickable link on organic posts, so the call to action has to be in the words.',
    basis: 'CONTEXT',
    confidence: 'MEDIUM',
    sampleSize: 0,
  });

  recommendations.push({
    key: 'CAPTION',
    value: `Keep it under ${rule.captionMax} characters. ${rule.note}`,
    reason: 'The platform\'s own limit and conventions for this surface.',
    basis: 'CONTEXT',
    confidence: 'HIGH',
    sampleSize: 0,
  });

  recommendations.push({
    key: 'HASHTAGS',
    value: rule.hashtags > 0 ? `About ${rule.hashtags} hashtags` : 'Hashtags are not used on this platform',
    reason: rule.hashtags > 0
      ? 'Enough to be found, few enough not to read as spam.'
      : 'This platform does not surface posts by hashtag, so they only add clutter.',
    basis: 'CONTEXT',
    confidence: 'HIGH',
    sampleSize: 0,
  });

  recommendations.push({
    key: 'LANGUAGE',
    value: language === 'AR' ? 'Arabic' : 'English',
    reason: `${client.businessName}'s preferred content language in Brand DNA.`,
    basis: 'CONTEXT',
    confidence: 'MEDIUM',
    sampleSize: 0,
  });

  recommendations.push({
    key: 'ANGLE',
    value: audience ? `Speak to ${audience} directly.` : 'Lead with the offer, not the brand.',
    reason: 'An angle the reader recognises themselves in outperforms one about the business.',
    basis: 'CONTEXT',
    confidence: 'LOW',
    sampleSize: 0,
  });

  const quality = scoreQuality(
    {
      caption: post.caption,
      headline: post.headline,
      hashtags: post.hashtags,
      ctaLabel: post.ctaLabel,
      linkUrl: post.linkUrl,
      mediaCount: post.media.length,
    },
    platform,
  );

  return {
    platformPostId: post.id,
    platform,
    insufficientData: !enough,
    sampleSize,
    insufficientDataMessage: enough
      ? null
      : `Insufficient historical data — ${sampleSize} published ${platform.toLowerCase()} post${sampleSize === 1 ? '' : 's'} with reported engagement. Timing advice below comes from market context, not from your audience.`,
    recommendations,
    qualityScore: quality.score,
    qualityFindings: quality.findings,
  };
}

/**
 * The bridge between organic and paid — in both directions.
 *
 * Two recommendations live here, and both are suggestions to a person rather
 * than actions. §20 and §21 of the brief are explicit that neither may create
 * or launch anything, and the shape of this module enforces that: it returns
 * findings. There is no code path from here to a provider, a budget or a
 * publish call.
 *
 * The honest difficulty is that organic and paid metrics are not the same
 * measurements. An organic "engagement" is a like, comment, share or save; a
 * paid "click" is somebody leaving for a website. Comparing them directly would
 * be the kind of cross-metric nonsense §38 warns about, so neither direction
 * compares the two. Each looks *within* its own channel for something that
 * stands out against its own baseline, and then says so.
 *
 * Phase 14 is read through `socialOverview` exactly as the analytics screen
 * reads it, and its four metric states arrive intact: a post whose engagement
 * was never fetched is excluded rather than treated as a zero-engagement post,
 * which would otherwise make every unmeasured post look like a failure.
 */

import { Platform, RecommendationType, type PrismaClient } from '@prisma/client';

import { orgId, scopeWhere, type Actor } from '../../../lib/scope.js';
import { socialOverview } from '../../social/analytics.js';
import { creativePerformance } from '../../analytics/creative-performance.js';
import { PLATFORM_LABELS } from '../../analytics.js';
import { matrixFor } from '../../marketing/capability-matrix.js';
import type { Insight } from './insights.js';

/** A post must beat its own channel's median by this much to stand out. */
const STANDOUT_MULTIPLE = 2;

/** Below this many measured posts there is no baseline to stand out from. */
const MIN_BASELINE_POSTS = 5;

const nOf = (value: number) => value.toLocaleString('en-US');
const percent = (value: number) => `${(value * 100).toFixed(2)}%`;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

/**
 * §20 — an organic post worth putting money behind.
 *
 * Only a post that outperformed *its own channel's* median engagement, and only
 * where that channel can actually be advertised on: recommending that somebody
 * promote a LinkedIn post is useless when this deployment has no LinkedIn ads
 * integration, and the capability matrix is what settles that.
 */
export async function organicToPaid(input: {
  actor: Actor;
  clientId?: string;
  from: Date;
  to: Date;
}): Promise<Insight[]> {
  const overview = await socialOverview(orgId(input.actor), input.clientId, input.from, input.to);

  /*
   * Only posts whose engagement was actually measured. A post reading
   * NOT_FETCHED is not a post with zero engagement, and including it would drag
   * the median down and make genuinely ordinary posts look exceptional.
   */
  const measured = overview.topPosts.filter(
    (post) => post.metrics.engagements.state === 'ZERO' && post.metrics.engagements.value !== null,
  );

  if (measured.length < MIN_BASELINE_POSTS) {
    return [{
      key: 'ORGANIC_TO_PAID',
      type: RecommendationType.ORGANIC_TO_PAID,
      priority: 'P3',
      state: 'INSUFFICIENT_DATA',
      title: 'Organic posts worth promoting',
      finding: 'Not enough measured organic posts to establish a baseline.',
      reason: `${measured.length} post(s) have fetched engagement figures; at least ${MIN_BASELINE_POSTS} are needed before one can be called a standout.`,
      recommendedAction: null,
      confidence: 'LOW',
      dataSources: ['PlatformPost analytics'],
      evidence: [{
        kind: 'OBSERVED',
        metric: 'Measured posts',
        value: nOf(measured.length),
        detail: 'Posts whose engagement was fetched from the platform. Unfetched posts are excluded rather than counted as zero.',
      }],
      platform: null,
      campaignId: null,
      creativeId: null,
      publicationId: null,
      location: null,
      proposedChange: null,
    }];
  }

  const baseline = median(measured.map((post) => post.metrics.engagements.value!));
  if (baseline === null || baseline === 0) return [];

  const standouts = measured
    .filter((post) => post.metrics.engagements.value! >= baseline * STANDOUT_MULTIPLE)
    // Only where money can actually be spent on that platform.
    .filter((post) => {
      const paid = matrixFor(post.platform).paid;
      return paid.state !== 'NOT_IMPLEMENTED' && paid.state !== 'NOT_SUPPORTED';
    })
    .slice(0, 3);

  return standouts.map((post) => ({
    key: `ORGANIC_TO_PAID_${post.platformPostId}`,
    type: RecommendationType.ORGANIC_TO_PAID,
    priority: 'P2',
    state: 'PERFORMING' as const,
    title: `An organic ${PLATFORM_LABELS[post.platform]} post is outperforming its channel`,
    finding: `${nOf(post.metrics.engagements.value!)} engagements against a median of ${nOf(Math.round(baseline))} across ${measured.length} measured posts.`,
    reason: 'Compared only against this client\'s own organic posts on measured engagement. No paid metric is involved — an engagement and a click are not the same measurement.',
    recommendedAction: 'Consider promoting this content as a paid campaign. Nothing is created or launched automatically.',
    confidence: measured.length >= 12 ? 'MEDIUM' as const : 'LOW' as const,
    dataSources: ['PlatformPost analytics' as const],
    evidence: [
      {
        kind: 'OBSERVED' as const,
        metric: 'Engagements',
        value: nOf(post.metrics.engagements.value!),
        comparison: `Median: ${nOf(Math.round(baseline))}`,
        detail: `Across ${measured.length} posts with fetched engagement in this period.`,
      },
      {
        kind: 'INFERRED' as const,
        metric: 'Threshold',
        value: `${STANDOUT_MULTIPLE}× median`,
        detail: 'Posts whose engagement was never fetched are excluded from the baseline rather than counted as zero.',
      },
    ],
    platform: post.platform,
    campaignId: null,
    creativeId: null,
    publicationId: null,
    location: null,
    proposedChange: null,
  }));
}

/**
 * §21 — a paid creative worth reusing organically.
 *
 * The verdict comes from the existing creative analyzer rather than a second
 * opinion computed here, and the recommendation is only offered where the same
 * platform can also publish organically — otherwise there is nowhere to put it.
 */
export async function paidToOrganic(input: {
  prisma: PrismaClient;
  actor: Actor;
  clientId?: string;
  from: Date;
  to: Date;
}): Promise<Insight[]> {
  const report = await creativePerformance({
    prisma: input.prisma,
    organizationId: orgId(input.actor),
    clientId: input.clientId,
    from: input.from,
    to: input.to,
  }).catch(() => null);

  if (!report || report.rows.length === 0) {
    return [{
      key: 'PAID_TO_ORGANIC',
      type: RecommendationType.PAID_TO_ORGANIC,
      priority: 'P3',
      state: 'INSUFFICIENT_DATA',
      title: 'Paid creatives worth reusing organically',
      finding: 'No creative-level performance has been fetched for this period.',
      reason: 'A creative can only be called a winner from measured delivery, and none is available.',
      recommendedAction: null,
      confidence: 'LOW',
      dataSources: ['CreativePerformance'],
      evidence: [],
      platform: null,
      campaignId: null,
      creativeId: null,
      publicationId: null,
      location: null,
      proposedChange: null,
    }];
  }

  const winners = report.rows
    .filter((row) => row.verdict === 'WINNER')
    // Only where the platform can publish organically at all.
    .filter((row) => {
      if (!row.platform) return false;
      const organic = matrixFor(row.platform).organic;
      return organic.state !== 'NOT_IMPLEMENTED' && organic.state !== 'NOT_SUPPORTED';
    })
    .slice(0, 3);

  return winners.map((row) => ({
    key: `PAID_TO_ORGANIC_${row.creativeId}`,
    type: RecommendationType.PAID_TO_ORGANIC,
    priority: 'P2',
    state: 'PERFORMING' as const,
    title: `A winning ${PLATFORM_LABELS[row.platform as Platform]} creative could run organically`,
    finding: row.verdictReason,
    reason: 'Judged a winner by the existing creative performance analyzer. Paid delivery does not predict organic reach — this is a suggestion to reuse the artwork and message, not a performance forecast.',
    recommendedAction: 'Consider adapting this creative into organic content. Nothing is published automatically.',
    confidence: 'LOW' as const,
    dataSources: ['CreativePerformance' as const],
    evidence: [
      {
        kind: 'OBSERVED' as const,
        metric: 'CTR',
        value: row.totals.ctr === null ? 'Not measured' : percent(row.totals.ctr),
        detail: `${nOf(row.totals.impressions)} paid impressions over ${row.days} day(s).`,
      },
      {
        kind: 'INFERRED' as const,
        metric: 'Transferability',
        value: 'Unknown',
        detail: 'No measurement here predicts how the same creative performs organically; the two channels reach different audiences.',
      },
    ],
    platform: row.platform,
    campaignId: row.campaignIds[0] ?? null,
    creativeId: row.creativeId,
    publicationId: null,
    location: null,
    proposedChange: null,
  }));
}

export { scopeWhere };

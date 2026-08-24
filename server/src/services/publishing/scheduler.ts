/**
 * The thing that was missing entirely: something that acts when a post is due.
 *
 * Before this, `SCHEDULED` was a label nothing read. Content sat at its
 * scheduled time forever, the calendar showed it as scheduled, and no process
 * anywhere looked for it — which is why a post could be approved, scheduled,
 * and simply never go out with no error to explain it.
 *
 * Two passes, deliberately separate:
 *
 *   sweep   SCHEDULED and due            → QUEUED (creates the job)
 *   drain   QUEUED and not backing off   → PUBLISHING → PUBLISHED / retry
 *
 * Splitting them means a post that cannot be queued (no Page attached, media
 * missing) fails at the sweep with a readiness problem, rather than burning
 * publish attempts to discover the same thing three times.
 *
 * This runs in the web process on an interval. That is a real constraint worth
 * stating plainly: it is single-instance, so running two containers would have
 * both sweeping. The claim-by-status-update in `runJob` makes a double publish
 * unlikely, and the job's unique key on (content, platform) makes a double
 * *post* impossible, but a queue with real leases is what this should become
 * once there is more than one publisher process.
 */

import { ContentStatus, PlatformPostStatus, PublishingJobStatus, type PrismaClient } from '@prisma/client';

import type { FetchLike } from './contract.js';
import { enqueue, runJob } from './service.js';
import { publishPlatformPost, refreshGroupStatus } from '../social/post-groups.js';

/** How many due posts one pass will take on. Keeps a backlog from stalling the tick. */
const BATCH = 10;

export interface SweepReport {
  queued: string[];
  /** Content that was due but could not be queued, with the reason. */
  refused: Array<{ contentId: string; problems: string[] }>;
}

/**
 * Move due content into the queue.
 *
 * Note what this does *not* do: it never sets PUBLISHED. The arrival of a
 * scheduled time is not evidence that anything was published, and treating it
 * as such is the single most tempting shortcut in this whole subsystem.
 */
export async function sweepDue(input: {
  prisma: PrismaClient;
  now?: Date;
  limit?: number;
}): Promise<SweepReport> {
  const { prisma } = input;
  const now = input.now ?? new Date();

  const due = await prisma.content.findMany({
    where: { status: ContentStatus.SCHEDULED, scheduledAt: { lte: now } },
    orderBy: { scheduledAt: 'asc' },
    take: input.limit ?? BATCH,
    select: { id: true, organizationId: true },
  });

  const report: SweepReport = { queued: [], refused: [] };

  for (const content of due) {
    const result = await enqueue({
      prisma,
      contentId: content.id,
      organizationId: content.organizationId,
    });

    if ('jobId' in result) {
      report.queued.push(content.id);
      continue;
    }

    /*
     * Refused, and the content is told why rather than left looking scheduled.
     * It stays SCHEDULED so a fixed account or restored media lets the next
     * sweep pick it up without anyone re-scheduling it.
     */
    const problems = result.refused.problems.map((row) => row.message);
    await prisma.content.update({
      where: { id: content.id },
      data: { failureReason: problems.join(' ') || 'This content is not ready to publish.' },
    });
    report.refused.push({ contentId: content.id, problems });
  }

  return report;
}

export interface DrainReport {
  published: string[];
  failed: string[];
  retrying: string[];
}

/** Run the jobs that are ready to run. */
export async function drainQueue(input: {
  prisma: PrismaClient;
  fetchImpl: FetchLike;
  now?: Date;
  limit?: number;
}): Promise<DrainReport> {
  const { prisma, fetchImpl } = input;
  const now = input.now ?? new Date();

  const jobs = await prisma.publishingJob.findMany({
    where: {
      status: PublishingJobStatus.QUEUED,
      // Either never attempted, or past its backoff. A job waiting out a rate
      // limit must not be picked up on the next tick.
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: { createdAt: 'asc' },
    take: input.limit ?? BATCH,
    select: { id: true },
  });

  const report: DrainReport = { published: [], failed: [], retrying: [] };

  for (const job of jobs) {
    const outcome = await runJob({ prisma, jobId: job.id, fetchImpl, now });

    if (outcome.status === PublishingJobStatus.PUBLISHED) report.published.push(job.id);
    else if (outcome.error?.retryable) report.retrying.push(job.id);
    else report.failed.push(job.id);
  }

  return report;
}

/**
 * One tick: sweep, then drain.
 *
 * Sweeping first means a post scheduled for exactly now is published on this
 * tick rather than the next one, which matters when the interval is minutes and
 * the operator picked the time deliberately.
 */
export async function publishingTick(input: {
  prisma: PrismaClient;
  fetchImpl: FetchLike;
  now?: Date;
}): Promise<{ sweep: SweepReport; drain: DrainReport; social: SocialTickReport }> {
  const sweep = await sweepDue({ prisma: input.prisma, now: input.now });
  const drain = await drainQueue({ prisma: input.prisma, fetchImpl: input.fetchImpl, now: input.now });
  const social = await socialTick(input);
  return { sweep, drain, social };
}

export interface SocialTickReport {
  queued: string[];
  published: string[];
  failed: string[];
}

/**
 * The same two passes over the multi-platform path.
 *
 * Separate from the Content sweep rather than merged with it, because the two
 * models have different tables and different status enums, and a single query
 * that tried to cover both would be a union that reads worse than two clear
 * loops. They share the tick, not the code.
 */
export async function socialTick(input: {
  prisma: PrismaClient;
  fetchImpl: FetchLike;
  now?: Date;
  limit?: number;
}): Promise<SocialTickReport> {
  const { prisma, fetchImpl } = input;
  const now = input.now ?? new Date();
  const take = input.limit ?? BATCH;

  const report: SocialTickReport = { queued: [], published: [], failed: [] };

  // Due and scheduled → queued. The arrival of a time is not a publication.
  const due = await prisma.platformPost.findMany({
    where: { status: PlatformPostStatus.SCHEDULED, scheduledAt: { lte: now } },
    orderBy: { scheduledAt: 'asc' },
    take,
    select: { id: true, postGroupId: true },
  });

  for (const post of due) {
    await prisma.platformPost.update({
      where: { id: post.id },
      data: { status: PlatformPostStatus.QUEUED },
    });
    await refreshGroupStatus(prisma, post.postGroupId);
    report.queued.push(post.id);
  }

  // Queued and not backing off → publish.
  const ready = await prisma.platformPost.findMany({
    where: {
      status: PlatformPostStatus.QUEUED,
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
    },
    orderBy: { createdAt: 'asc' },
    take,
    select: { id: true },
  });

  for (const post of ready) {
    const result = await publishPlatformPost({ prisma, platformPostId: post.id, fetchImpl, now });
    if (result.published) report.published.push(post.id);
    else report.failed.push(post.id);
  }

  return report;
}

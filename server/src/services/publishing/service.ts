/**
 * The organic publishing workflow: everything durable about getting one post out.
 *
 *   APPROVED → SCHEDULED → QUEUED → PUBLISHING → PUBLISHED
 *                                        ↓
 *                                  PUBLISH_FAILED → (retry) → QUEUED
 *
 * The rule the whole file exists to hold: **content becomes PUBLISHED only after
 * a provider returns an id for it.** Not when the scheduled time arrives, not
 * when the request is sent, not when the HTTP call returns 200 without an id.
 * Every other guarantee here — idempotency, bounded retries, attempt records —
 * is in service of never lying about that one fact.
 *
 * Nothing in here knows what Facebook is. Platform specifics live behind
 * `PlatformPublisher`, which is what makes adding Instagram a new file rather
 * than a new branch through this logic.
 */

import { AccountTokenStatus, ContentStatus, MediaType, Platform, PrismaClient, PublishingAttemptResult, PublishingJobStatus } from '@prisma/client';

import { decryptSecret } from '../../lib/crypto.js';
import { readObject } from '../storage/objects.js';
import { isRetryable, type FetchLike, type PublishMedia } from './contract.js';
import { publisherFor } from './registry.js';
import { noTargetMessage, resolvePublishingTarget } from './target.js';

/**
 * How many times a retryable failure is tried before it becomes a person's
 * problem. Three total attempts: enough to ride out a rate limit or a Meta
 * blip, few enough that a misclassified permanent failure does not hammer the
 * provider for hours.
 */
export const MAX_ATTEMPTS = 3;

/** Backoff before each retry, indexed by the attempt just completed. */
const RETRY_DELAYS_MS = [60_000, 300_000];

export interface PublishOutcome {
  jobId: string;
  status: PublishingJobStatus;
  externalPostId: string | null;
  permalink: string | null;
  /** Present on failure. Already written for an operator to read. */
  error: { code: string | null; message: string; retryable: boolean } | null;
  /** True when the job was already published and nothing was sent. */
  deduplicated: boolean;
}

/**
 * Why a piece of content cannot be published, checked before anything is sent.
 *
 * These are refusals, not failures: no attempt is recorded and nothing reaches
 * the provider, because the answer would be the same every time. Scheduling
 * calls the same checks so the operator hears about it at the point of
 * scheduling rather than silently at 7pm on a Saturday.
 */
export type ReadinessProblem =
  | 'NO_PLATFORM_SUPPORT'
  | 'NO_ACCOUNT_SELECTED'
  | 'ACCOUNT_NEEDS_REAUTH'
  | 'NO_CAPTION'
  | 'MEDIA_UNREADABLE'
  | 'UNSUPPORTED_MEDIA_COUNT';

export interface Readiness {
  ready: boolean;
  problems: Array<{ problem: ReadinessProblem; message: string }>;
}

const READINESS_MESSAGE: Record<ReadinessProblem, string> = {
  NO_PLATFORM_SUPPORT: 'Publishing to this platform is not implemented yet.',
  NO_ACCOUNT_SELECTED:
    'No account is attached for this platform. Connect it and choose one under Integrations.',
  ACCOUNT_NEEDS_REAUTH:
    'The connected account has no usable publishing token. Reconnect it under Integrations.',
  NO_CAPTION: 'The post has no text. Add a caption before scheduling.',
  MEDIA_UNREADABLE: 'The attached media could not be read from storage.',
  UNSUPPORTED_MEDIA_COUNT:
    'Only a single image is supported per post today. Remove the extra media.',
};

/** The account this content will publish to, if there is one. */
/**
 * The account this content will publish to, if there is one.
 *
 * The decision itself lives in `target.ts`, because the test-publish route asks
 * the same question and the two answering it separately is exactly how one of
 * them came to hard-code a Facebook Page.
 */
async function resolveAccount(input: {
  prisma: PrismaClient;
  organizationId: string;
  clientId: string;
  platform: Platform;
}) {
  return resolvePublishingTarget(input);
}

/**
 * Everything that must be true before a publish is worth attempting.
 *
 * Deliberately checks storage too: a Media row whose object has gone is
 * indistinguishable from a healthy one until something tries to read it, and
 * finding out during the publish costs an attempt and a confusing provider
 * error.
 */
export async function checkReadiness(input: {
  prisma: PrismaClient;
  contentId: string;
  organizationId: string;
}): Promise<Readiness> {
  const { prisma, contentId, organizationId } = input;
  const problems: ReadinessProblem[] = [];

  const content = await prisma.content.findFirst({
    where: { id: contentId, organizationId },
    select: {
      clientId: true,
      platform: true,
      caption: true,
      headline: true,
      mediaLinks: {
        orderBy: { position: 'asc' },
        select: { media: { select: { id: true, type: true, filename: true } } },
      },
    },
  });

  if (!content) return { ready: false, problems: [] };

  const publisher = publisherFor(content.platform);
  if (!publisher?.canPublish) problems.push('NO_PLATFORM_SUPPORT');

  const account = await resolveAccount({
    prisma,
    organizationId,
    clientId: content.clientId,
    platform: content.platform,
  });

  if (!account) problems.push('NO_ACCOUNT_SELECTED');
  else if (!account.accessTokenEnc || account.tokenStatus === AccountTokenStatus.REAUTH_REQUIRED) {
    problems.push('ACCOUNT_NEEDS_REAUTH');
  }

  if (!composeCaption(content.caption, content.headline)) problems.push('NO_CAPTION');

  const images = content.mediaLinks.filter((link) => link.media.type === MediaType.IMAGE);
  if (images.length > 1) problems.push('UNSUPPORTED_MEDIA_COUNT');

  // Read the bytes, not just the row. This is the check that catches a creative
  // that exists in the database and not in the bucket.
  for (const link of images.slice(0, 1)) {
    if (!link.media.filename) {
      problems.push('MEDIA_UNREADABLE');
      break;
    }
    try {
      await readObject(link.media.filename);
    } catch {
      problems.push('MEDIA_UNREADABLE');
      break;
    }
  }

  return {
    ready: problems.length === 0,
    problems: problems.map((problem) => ({
      problem,
      // The missing target is named for what the platform actually publishes
      // to: "No Instagram account is attached", never "No Page".
      message: problem === 'NO_ACCOUNT_SELECTED'
        ? noTargetMessage(content.platform)
        : READINESS_MESSAGE[problem],
    })),
  };
}

/** The text of the post. A headline with no caption is still something to say. */
function composeCaption(caption: string | null, headline: string | null): string {
  return [headline?.trim(), caption?.trim()].filter(Boolean).join('\n\n').trim();
}

/**
 * Put a piece of content in the queue.
 *
 * Idempotent by construction: the job is unique per (content, platform), so
 * enqueueing twice returns the same row rather than creating a second one that
 * would publish a second post.
 */
export async function enqueue(input: {
  prisma: PrismaClient;
  contentId: string;
  organizationId: string;
}): Promise<{ jobId: string } | { refused: Readiness }> {
  const { prisma, contentId, organizationId } = input;

  const content = await prisma.content.findFirstOrThrow({
    where: { id: contentId, organizationId },
    select: { id: true, clientId: true, platform: true, scheduledAt: true },
  });

  const readiness = await checkReadiness({ prisma, contentId, organizationId });
  if (!readiness.ready) return { refused: readiness };

  const account = await resolveAccount({
    prisma,
    organizationId,
    clientId: content.clientId,
    platform: content.platform,
  });

  const job = await prisma.publishingJob.upsert({
    where: { contentId_platform: { contentId: content.id, platform: content.platform } },
    create: {
      organizationId,
      clientId: content.clientId,
      contentId: content.id,
      accountId: account?.id ?? null,
      platform: content.platform,
      status: PublishingJobStatus.QUEUED,
      scheduledAt: content.scheduledAt,
    },
    // A retry re-queues the existing job. Attempts are never reset: the count is
    // the history of this post, not of the current try.
    update: {
      status: PublishingJobStatus.QUEUED,
      accountId: account?.id ?? null,
      nextAttemptAt: null,
      errorCode: null,
      errorMessage: null,
      failedAt: null,
    },
    select: { id: true },
  });

  await prisma.content.update({
    where: { id: content.id },
    data: { status: ContentStatus.QUEUED, failureReason: null },
  });

  return { jobId: job.id };
}

/**
 * Publish a one-off message straight to a connected account.
 *
 * The escape hatch for the one question no test can answer: does this
 * deployment, with these credentials and this Page, actually publish? It
 * deliberately touches no Content and creates no job — it cannot mark anything
 * PUBLISHED — but it does put a real post on a real Page, so its caller is
 * responsible for authorisation.
 *
 * `fetchImpl` is a parameter rather than a global so this is testable at all.
 * The route passes the real fetch; tests pass a fake with Meta's response shape.
 */
export async function testPublish(input: {
  prisma: PrismaClient;
  accountId: string;
  message: string;
  platform: Platform;
  fetchImpl: FetchLike;
}): Promise<
  | { published: true; externalPostId: string; permalink: string | null; publishedAt: Date }
  | { published: false; code: string; message: string; providerCode: string | null }
> {
  const { prisma, accountId } = input;

  const publisher = publisherFor(input.platform);
  if (!publisher?.canPublish) {
    return {
      published: false,
      code: 'NOT_CONFIGURED',
      message: `Publishing to ${input.platform} is not implemented yet.`,
      providerCode: null,
    };
  }

  const account = await prisma.integrationAccount.findUniqueOrThrow({
    where: { id: accountId },
    select: { id: true, externalId: true, name: true, accessTokenEnc: true, metadata: true },
  });

  if (!account.accessTokenEnc) {
    return {
      published: false,
      code: 'ACCOUNT_NEEDS_REAUTH',
      message: READINESS_MESSAGE.ACCOUNT_NEEDS_REAUTH,
      providerCode: null,
    };
  }

  const result = await publisher.publish({
    caption: input.message,
    media: [],
    account: {
      externalId: account.externalId,
      name: account.name,
      // Decrypted here, used once, never returned to the caller.
      accessToken: decryptSecret(account.accessTokenEnc),
      metadata: (account.metadata ?? {}) as Record<string, unknown>,
    },
    fetchImpl: input.fetchImpl,
  });

  if (!result.success) {
    return {
      published: false,
      code: result.error.kind,
      message: result.error.message,
      providerCode: result.error.code,
    };
  }

  // A successful call is the only real proof the credential works.
  await prisma.integrationAccount.update({
    where: { id: account.id },
    data: { tokenStatus: AccountTokenStatus.TOKEN_VALID, tokenCheckedAt: new Date() },
  });

  return {
    published: true,
    externalPostId: result.externalPostId,
    permalink: result.permalink,
    publishedAt: result.publishedAt,
  };
}

/**
 * Attempt one job.
 *
 * The order here is the safety property. Idempotency is checked first, against
 * the database rather than against anything held in memory, so a worker that
 * crashed after publishing but before writing cannot publish again. Then the
 * job is claimed by moving it to PUBLISHING, which is what stops two workers
 * running the same job concurrently.
 */
export async function runJob(input: {
  prisma: PrismaClient;
  jobId: string;
  fetchImpl: FetchLike;
  now?: Date;
}): Promise<PublishOutcome> {
  const { prisma, jobId, fetchImpl } = input;
  const now = input.now ?? new Date();

  const job = await prisma.publishingJob.findUniqueOrThrow({
    where: { id: jobId },
    select: {
      id: true, contentId: true, platform: true, status: true, attempts: true,
      externalPostId: true, permalink: true, organizationId: true, accountId: true,
    },
  });

  /*
   * Idempotency, checked three ways before anything leaves this process. A
   * retry that republishes is worse than a retry that fails: the operator sees
   * one post, the customer's followers see two, and nothing in our records says
   * it happened.
   */
  if (job.status === PublishingJobStatus.PUBLISHED || job.externalPostId) {
    return {
      jobId: job.id,
      status: PublishingJobStatus.PUBLISHED,
      externalPostId: job.externalPostId,
      permalink: job.permalink,
      error: null,
      deduplicated: true,
    };
  }

  const succeeded = await prisma.publishingAttempt.findFirst({
    where: { jobId: job.id, result: PublishingAttemptResult.SUCCESS },
    select: { externalPostId: true },
  });
  if (succeeded) {
    // The provider accepted it and the job row never learned. Repair rather
    // than republish.
    return finishPublished({
      prisma,
      job,
      externalPostId: succeeded.externalPostId ?? 'unknown',
      permalink: null,
      publishedAt: now,
      deduplicated: true,
    });
  }

  const publisher = publisherFor(job.platform);
  if (!publisher?.canPublish) {
    return finishFailed({
      prisma, job, now, retryable: false,
      code: 'NOT_CONFIGURED',
      message: `Publishing to ${job.platform} is not implemented yet.`,
      httpStatus: null,
    });
  }

  const content = await prisma.content.findUniqueOrThrow({
    where: { id: job.contentId },
    select: {
      caption: true, headline: true, clientId: true,
      mediaLinks: {
        orderBy: { position: 'asc' },
        select: { media: { select: { type: true, mimeType: true, filename: true, originalName: true } } },
      },
    },
  });

  const account = job.accountId
    ? await prisma.integrationAccount.findUnique({
        where: { id: job.accountId },
        select: { externalId: true, name: true, accessTokenEnc: true, metadata: true },
      })
    : null;

  if (!account?.accessTokenEnc) {
    return finishFailed({
      prisma, job, now, retryable: false,
      code: 'ACCOUNT_NEEDS_REAUTH',
      message: READINESS_MESSAGE.ACCOUNT_NEEDS_REAUTH,
      httpStatus: null,
    });
  }

  /*
   * Claim the job — conditionally.
   *
   * This used to be a plain `update` by id, which is a read-then-write: two
   * workers that both selected this job as QUEUED would both pass the checks
   * above and both write PUBLISHING, and then both call the provider. The
   * comment claimed the transition stopped that; the query did not, because
   * nothing in it asserted what the status was *at the moment of the write*.
   *
   * `updateMany` with the status in the WHERE clause makes it a real
   * compare-and-swap: exactly one caller can move the row out of QUEUED, and
   * `count` tells the loser it lost. That is the property the whole subsystem
   * was assumed to have, and it costs one clause.
   *
   * It matters on a single instance too. The tick is on `setInterval`, so a
   * pass that outruns its own interval overlaps the next one — a video upload
   * is enough — and then the two "workers" are two ticks in this same process.
   */
  const claimed = await prisma.publishingJob.updateMany({
    where: { id: job.id, status: PublishingJobStatus.QUEUED },
    data: { status: PublishingJobStatus.PUBLISHING, lastAttemptAt: now, attempts: { increment: 1 } },
  });

  if (claimed.count === 0) {
    // Someone else has it. Report the job's current state rather than inventing
    // an error: nothing failed here, this worker simply has no work to do.
    const current = await prisma.publishingJob.findUniqueOrThrow({
      where: { id: job.id },
      select: { status: true, externalPostId: true, permalink: true },
    });
    return {
      jobId: job.id,
      status: current.status,
      externalPostId: current.externalPostId,
      permalink: current.permalink,
      error: null,
      // Nothing was sent, and the reason is the same one dedup exists for.
      deduplicated: true,
    };
  }

  await prisma.content.update({
    where: { id: job.contentId },
    data: { status: ContentStatus.PUBLISHING },
  });

  const attempt = await prisma.publishingAttempt.create({
    data: { jobId: job.id, platform: job.platform, result: PublishingAttemptResult.RETRYABLE_FAILURE, startedAt: now },
    select: { id: true },
  });

  let media: PublishMedia[] = [];
  try {
    media = await loadMedia(content.mediaLinks);
  } catch {
    return finishFailed({
      prisma, job, now, attemptId: attempt.id, retryable: false,
      code: 'MEDIA_UNREADABLE',
      message: READINESS_MESSAGE.MEDIA_UNREADABLE,
      httpStatus: null,
    });
  }

  const result = await publisher.publish({
    caption: composeCaption(content.caption, content.headline),
    media,
    account: {
      externalId: account.externalId,
      name: account.name,
      // Decrypted here and nowhere else, immediately before the call.
      accessToken: decryptSecret(account.accessTokenEnc),
      metadata: (account.metadata ?? {}) as Record<string, unknown>,
    },
    fetchImpl,
  });

  if (result.success) {
    await prisma.publishingAttempt.update({
      where: { id: attempt.id },
      data: {
        result: PublishingAttemptResult.SUCCESS,
        completedAt: new Date(),
        externalPostId: result.externalPostId,
      },
    });
    return finishPublished({
      prisma, job,
      externalPostId: result.externalPostId,
      permalink: result.permalink,
      publishedAt: result.publishedAt,
      deduplicated: false,
    });
  }

  return finishFailed({
    prisma, job, now, attemptId: attempt.id,
    retryable: isRetryable(result.error.kind),
    code: result.error.code ?? result.error.kind,
    message: result.error.message,
    httpStatus: result.error.httpStatus,
    attemptsSoFar: job.attempts + 1,
  });
}

/** Read each image out of storage. Only images, and only the first, today. */
async function loadMedia(
  links: Array<{ media: { type: MediaType; mimeType: string; filename: string; originalName: string } }>,
): Promise<PublishMedia[]> {
  const image = links.find((link) => link.media.type === MediaType.IMAGE);
  if (!image?.media.filename) return [];

  return [
    {
      kind: 'IMAGE',
      data: await readObject(image.media.filename),
      mimeType: image.media.mimeType,
      filename: image.media.originalName,
    },
  ];
}

async function finishPublished(input: {
  prisma: PrismaClient;
  job: { id: string; contentId: string };
  externalPostId: string;
  permalink: string | null;
  publishedAt: Date;
  deduplicated: boolean;
}): Promise<PublishOutcome> {
  const { prisma, job } = input;

  await prisma.$transaction([
    prisma.publishingJob.update({
      where: { id: job.id },
      data: {
        status: PublishingJobStatus.PUBLISHED,
        externalPostId: input.externalPostId,
        permalink: input.permalink,
        publishedAt: input.publishedAt,
        nextAttemptAt: null,
        errorCode: null,
        errorMessage: null,
        failedAt: null,
      },
    }),
    // The only place content becomes PUBLISHED, and it is downstream of an id
    // the provider gave us.
    prisma.content.update({
      where: { id: job.contentId },
      data: { status: ContentStatus.PUBLISHED, publishedAt: input.publishedAt, failureReason: null },
    }),
  ]);

  return {
    jobId: job.id,
    status: PublishingJobStatus.PUBLISHED,
    externalPostId: input.externalPostId,
    permalink: input.permalink,
    error: null,
    deduplicated: input.deduplicated,
  };
}

async function finishFailed(input: {
  prisma: PrismaClient;
  job: { id: string; contentId: string };
  now: Date;
  retryable: boolean;
  code: string;
  message: string;
  httpStatus: number | null;
  attemptId?: string;
  attemptsSoFar?: number;
}): Promise<PublishOutcome> {
  const { prisma, job, now } = input;
  const attempts = input.attemptsSoFar ?? MAX_ATTEMPTS;

  // Retryable only while there are tries left. The last retryable failure is
  // still a failure, and an operator has to be told rather than left waiting.
  const willRetry = input.retryable && attempts < MAX_ATTEMPTS;
  const nextAttemptAt = willRetry
    ? new Date(now.getTime() + (RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS.at(-1) ?? 300_000))
    : null;

  if (input.attemptId) {
    await prisma.publishingAttempt.update({
      where: { id: input.attemptId },
      data: {
        result: input.retryable
          ? PublishingAttemptResult.RETRYABLE_FAILURE
          : PublishingAttemptResult.PERMANENT_FAILURE,
        completedAt: new Date(),
        errorCode: input.code,
        errorMessage: input.message,
        httpStatus: input.httpStatus,
      },
    });
  }

  await prisma.$transaction([
    prisma.publishingJob.update({
      where: { id: job.id },
      data: {
        status: willRetry ? PublishingJobStatus.QUEUED : PublishingJobStatus.FAILED,
        errorCode: input.code,
        errorMessage: input.message,
        failedAt: now,
        nextAttemptAt,
      },
    }),
    prisma.content.update({
      where: { id: job.contentId },
      data: {
        // Still queued while a retry is pending — the post has not failed yet,
        // it is waiting. PUBLISH_FAILED is reserved for the end of the road.
        status: willRetry ? ContentStatus.QUEUED : ContentStatus.PUBLISH_FAILED,
        failureReason: input.message,
      },
    }),
  ]);

  return {
    jobId: job.id,
    status: willRetry ? PublishingJobStatus.QUEUED : PublishingJobStatus.FAILED,
    externalPostId: null,
    permalink: null,
    error: { code: input.code, message: input.message, retryable: willRetry },
    deduplicated: false,
  };
}

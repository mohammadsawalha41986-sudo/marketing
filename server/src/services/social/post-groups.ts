/**
 * One idea, several platforms, each with its own words.
 *
 * This is the service behind the new composer. Its job is to make the
 * multi-platform case first-class without disturbing the single-platform
 * `Content` path that is already in production and already carries a
 * real-world-verified Facebook publication.
 *
 * The design rule running through it: creating a group for three platforms
 * creates three *editable* versions, seeded from a shared draft but never
 * chained to it. The moment an operator changes the Instagram caption, the
 * Facebook one must not follow — a system that copies one caption everywhere is
 * exactly what an agency is paying not to do.
 *
 * Publishing reuses the existing `PlatformPublisher` registry, so Facebook goes
 * through the same verified adapter as before. Nothing here re-implements a
 * provider.
 */

import {
  MediaType, PlatformPostStatus, Platform, PostGroupStatus, type PrismaClient,
} from '@prisma/client';

import { decryptSecret } from '../../lib/crypto.js';
import { readObject } from '../storage/objects.js';
import type { FetchLike, PublishMedia } from '../publishing/contract.js';
import { isRetryable } from '../publishing/contract.js';
import { publisherFor } from '../publishing/registry.js';
import { canTransition, deriveGroupStatus, transitionError } from './state.js';

/** Three tries, matching the single-platform pipeline rather than inventing a second policy. */
export const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [60_000, 300_000];

export class SocialError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'SocialError';
    this.code = code;
    this.status = status;
  }
}

export interface PlatformDraft {
  platform: Platform;
  caption?: string | null;
  headline?: string | null;
  hashtags?: string[];
  linkUrl?: string | null;
  ctaLabel?: string | null;
  config?: Record<string, unknown>;
  mediaIds?: string[];
  integrationAccountId?: string | null;
  scheduledAt?: Date | null;
}

/**
 * Create a group and one post per selected platform.
 *
 * The shared draft seeds each version; it is not a template they stay bound to.
 * Per-platform overrides win where given, which is what lets the caller send
 * "the same idea" and still get a different Instagram caption in the same call.
 */
export async function createGroup(input: {
  prisma: PrismaClient;
  organizationId: string;
  clientId: string;
  createdById: string;
  name: string;
  description?: string | null;
  campaignId?: string | null;
  /** Copy applied to every platform that does not override it. */
  shared?: { caption?: string | null; hashtags?: string[]; mediaIds?: string[] };
  platforms: PlatformDraft[];
}): Promise<{ id: string }> {
  const { prisma, organizationId, clientId } = input;

  if (input.platforms.length === 0) {
    throw new SocialError('NO_PLATFORMS', 'Choose at least one platform to post to.');
  }

  const seen = new Set<Platform>();
  for (const draft of input.platforms) {
    if (seen.has(draft.platform)) {
      throw new SocialError(
        'DUPLICATE_PLATFORM',
        `${draft.platform} appears twice. One version per platform per post.`,
      );
    }
    seen.add(draft.platform);
  }

  await assertClient(prisma, organizationId, clientId);
  if (input.campaignId) await assertCampaign(prisma, organizationId, clientId, input.campaignId);

  // Every media id, from the shared draft and every override, checked once
  // against the tenant. An id in a payload is a claim, not a permission.
  const allMediaIds = [
    ...(input.shared?.mediaIds ?? []),
    ...input.platforms.flatMap((draft) => draft.mediaIds ?? []),
  ];
  await assertMedia(prisma, organizationId, clientId, allMediaIds);

  const accountIds = input.platforms
    .map((draft) => draft.integrationAccountId)
    .filter((id): id is string => Boolean(id));
  await assertAccounts(prisma, organizationId, clientId, accountIds);

  const group = await prisma.postGroup.create({
    data: {
      organizationId,
      clientId,
      campaignId: input.campaignId ?? null,
      name: input.name,
      description: input.description ?? null,
      createdById: input.createdById,
      status: PostGroupStatus.DRAFT,
      posts: {
        create: input.platforms.map((draft) => {
          const mediaIds = draft.mediaIds ?? input.shared?.mediaIds ?? [];
          return {
            platform: draft.platform,
            integrationAccountId: draft.integrationAccountId ?? null,
            caption: draft.caption ?? input.shared?.caption ?? null,
            headline: draft.headline ?? null,
            hashtags: draft.hashtags ?? input.shared?.hashtags ?? [],
            linkUrl: draft.linkUrl ?? null,
            ctaLabel: draft.ctaLabel ?? null,
            config: (draft.config ?? {}) as object,
            scheduledAt: draft.scheduledAt ?? null,
            media: { create: mediaIds.map((mediaId, position) => ({ mediaId, position })) },
          };
        }),
      },
    },
    select: { id: true },
  });

  return group;
}

/** Edit one platform's version. Never touches its siblings. */
export async function updatePlatformPost(input: {
  prisma: PrismaClient;
  organizationId: string;
  platformPostId: string;
  patch: Omit<PlatformDraft, 'platform'>;
}): Promise<void> {
  const { prisma, organizationId, platformPostId, patch } = input;

  const post = await loadPost(prisma, organizationId, platformPostId);

  /*
   * Editing is for work that is still the author's. Once approved, the content
   * is part of what was approved, and changing it silently would make the
   * approval a record of something that no longer exists.
   */
  if (!EDITABLE.has(post.status)) {
    throw new SocialError(
      'NOT_EDITABLE',
      `This ${post.platform} post is ${post.status.toLowerCase().replace('_', ' ')} and can no longer be edited. Request changes to reopen it.`,
    );
  }

  if (patch.mediaIds) {
    await assertMedia(prisma, organizationId, post.postGroup.clientId, patch.mediaIds);
  }
  if (patch.integrationAccountId) {
    await assertAccounts(prisma, organizationId, post.postGroup.clientId, [patch.integrationAccountId]);
  }

  await prisma.platformPost.update({
    where: { id: post.id },
    data: {
      ...(patch.caption !== undefined ? { caption: patch.caption } : {}),
      ...(patch.headline !== undefined ? { headline: patch.headline } : {}),
      ...(patch.hashtags !== undefined ? { hashtags: patch.hashtags } : {}),
      ...(patch.linkUrl !== undefined ? { linkUrl: patch.linkUrl } : {}),
      ...(patch.ctaLabel !== undefined ? { ctaLabel: patch.ctaLabel } : {}),
      ...(patch.config !== undefined ? { config: patch.config as object } : {}),
      ...(patch.scheduledAt !== undefined ? { scheduledAt: patch.scheduledAt } : {}),
      ...(patch.integrationAccountId !== undefined
        ? { integrationAccountId: patch.integrationAccountId }
        : {}),
      // Replaces the set rather than merging, so "remove the last image" is
      // expressible at all.
      ...(patch.mediaIds
        ? {
            media: {
              deleteMany: {},
              create: patch.mediaIds.map((mediaId, position) => ({ mediaId, position })),
            },
          }
        : {}),
    },
  });

  await refreshGroupStatus(prisma, post.postGroupId);
}

const EDITABLE = new Set<PlatformPostStatus>([
  PlatformPostStatus.DRAFT,
  PlatformPostStatus.CHANGES_REQUESTED,
  PlatformPostStatus.FAILED,
  PlatformPostStatus.CANCELLED,
]);

/**
 * Move one platform post to a new state.
 *
 * Every transition in the product goes through here, so the legality table in
 * `state.ts` is the only definition of the workflow. Routes decide who may ask;
 * this decides whether the move is possible at all.
 */
export async function transition(input: {
  prisma: PrismaClient;
  organizationId: string;
  platformPostId: string;
  to: PlatformPostStatus;
  scheduledAt?: Date | null;
}): Promise<void> {
  const { prisma, organizationId, platformPostId, to } = input;
  const post = await loadPost(prisma, organizationId, platformPostId);

  if (!canTransition(post.status, to)) {
    throw new SocialError('INVALID_TRANSITION', transitionError(post.status, to), 409);
  }

  if (to === PlatformPostStatus.SCHEDULED && !input.scheduledAt && !post.scheduledAt) {
    throw new SocialError('NO_SCHEDULE', 'Scheduling needs a date and time.');
  }

  await prisma.platformPost.update({
    where: { id: post.id },
    data: {
      status: to,
      ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt } : {}),
      // Re-queuing after a failure clears the last reason so a stale message
      // cannot outlive the problem it described.
      ...(to === PlatformPostStatus.QUEUED ? { errorCode: null, errorMessage: null } : {}),
    },
  });

  await refreshGroupStatus(prisma, post.postGroupId);
}

/** Apply a transition to every post in a group that can legally take it. */
export async function transitionGroup(input: {
  prisma: PrismaClient;
  organizationId: string;
  groupId: string;
  to: PlatformPostStatus;
}): Promise<{ moved: number; skipped: number }> {
  const { prisma, organizationId, groupId, to } = input;

  const group = await prisma.postGroup.findFirst({
    where: { id: groupId, organizationId },
    select: { id: true, posts: { select: { id: true, status: true } } },
  });
  if (!group) throw new SocialError('NOT_FOUND', 'Post not found', 404);

  let moved = 0;
  let skipped = 0;

  for (const post of group.posts) {
    // A group action is a convenience, not an override: a post that cannot
    // legally take the transition is left alone rather than forced.
    if (!canTransition(post.status, to)) {
      skipped += 1;
      continue;
    }
    await prisma.platformPost.update({ where: { id: post.id }, data: { status: to } });
    moved += 1;
  }

  await refreshGroupStatus(prisma, group.id);
  return { moved, skipped };
}

/**
 * Publish one platform post, through the provider's own adapter.
 *
 * Facebook reaches its verified publisher from here unchanged. The idempotency
 * check is first and reads the database rather than memory, so a worker that
 * crashed after publishing but before writing cannot publish twice.
 */
/**
 * The statuses a post may be published *from*.
 *
 * Exported because two places need to agree on it exactly: the route, which
 * rejects an unpublishable post with a readable message before any work starts,
 * and the conditional claim below, which is what actually makes the transition
 * safe under concurrency. Two copies of this set would be a race waiting to be
 * reintroduced by whichever one somebody forgot to update.
 */
export const PUBLISHABLE_FROM: ReadonlySet<PlatformPostStatus> = new Set([
  PlatformPostStatus.APPROVED,
  PlatformPostStatus.SCHEDULED,
  PlatformPostStatus.QUEUED,
  PlatformPostStatus.FAILED,
]);

export async function publishPlatformPost(input: {
  prisma: PrismaClient;
  platformPostId: string;
  fetchImpl: FetchLike;
  now?: Date;
}): Promise<{ published: boolean; externalPostId: string | null; error: string | null }> {
  const { prisma, platformPostId, fetchImpl } = input;
  const now = input.now ?? new Date();

  const post = await prisma.platformPost.findUniqueOrThrow({
    where: { id: platformPostId },
    select: {
      id: true, postGroupId: true, platform: true, status: true, caption: true, headline: true,
      hashtags: true, attemptCount: true, externalPostId: true, config: true,
      integrationAccount: { select: { externalId: true, name: true, accessTokenEnc: true } },
      media: {
        orderBy: { position: 'asc' },
        select: { media: { select: { type: true, mimeType: true, filename: true, originalName: true } } },
      },
    },
  });

  // Already out in the world. Republishing would show the customer's followers
  // the same post twice with nothing in our records to say why.
  if (post.externalPostId || post.status === PlatformPostStatus.PUBLISHED) {
    return { published: true, externalPostId: post.externalPostId, error: null };
  }

  const publisher = publisherFor(post.platform);
  if (!publisher?.canPublish) {
    return fail(prisma, post, now, false, 'NOT_CONFIGURED',
      `Publishing to ${post.platform} is not implemented yet.`);
  }

  if (!post.integrationAccount?.accessTokenEnc) {
    return fail(prisma, post, now, false, 'ACCOUNT_NEEDS_REAUTH',
      `No connected ${post.platform} account with a usable publishing token. Reconnect it under Integrations.`);
  }

  /*
   * Claim the post before calling the provider.
   *
   * The `externalPostId` check above is an idempotency check, not a lock: two
   * callers racing on the same post both read it as unpublished, both pass, and
   * both publish — and the customer's followers see the post twice with nothing
   * in our records to explain it. The unique-key protection that guards the
   * `Content` path does not exist here, because a PlatformPost *is* the row.
   *
   * So the transition out of the pre-publish state is done conditionally, with
   * the acceptable prior states named in the WHERE clause. Exactly one caller
   * can perform it; `count === 0` means somebody else already has this post,
   * and this caller must return without touching the provider.
   *
   * The accepted set is `PUBLISHABLE_FROM` — the same set the route checks
   * before calling in, so an operator publishing an approved post and the
   * scheduler draining a queued one both still work, and a retry from FAILED
   * still works. Sharing the constant is the point: a set that drifted from the
   * route's would either reject legitimate publishes or re-open the race.
   */
  const claimed = await prisma.platformPost.updateMany({
    where: {
      id: post.id,
      status: { in: [...PUBLISHABLE_FROM] },
    },
    data: { status: PlatformPostStatus.PUBLISHING, lastAttemptAt: now, attemptCount: { increment: 1 } },
  });

  if (claimed.count === 0) {
    const current = await prisma.platformPost.findUniqueOrThrow({
      where: { id: post.id },
      select: { status: true, externalPostId: true },
    });
    return {
      // Only a genuinely published post counts as published. A post another
      // worker is mid-publish on is neither published nor failed yet, and
      // claiming either would be a lie the group status then inherits.
      published: current.status === PlatformPostStatus.PUBLISHED,
      externalPostId: current.externalPostId,
      error: current.status === PlatformPostStatus.PUBLISHED
        ? null
        : 'This post is already being published by another worker.',
    };
  }

  await refreshGroupStatus(prisma, post.postGroupId);

  let media: PublishMedia[] = [];
  try {
    media = await loadMedia(post.media);
  } catch {
    return fail(prisma, post, now, false, 'MEDIA_UNREADABLE',
      'The attached media could not be read from storage.');
  }

  const caption = [post.headline?.trim(), post.caption?.trim(), post.hashtags.map((tag) => `#${tag}`).join(' ')]
    .filter((part) => part && part.length > 0)
    .join('\n\n');

  const result = await publisher.publish({
    caption,
    media,
    account: {
      externalId: post.integrationAccount.externalId,
      name: post.integrationAccount.name,
      // Decrypted immediately before the call and never held longer.
      accessToken: decryptSecret(post.integrationAccount.accessTokenEnc),
    },
    fetchImpl,
    // Provider-specific settings the operator chose, e.g. TikTok's privacy
    // level or YouTube's visibility. Never credentials.
    config: (post.config ?? {}) as Record<string, unknown>,
  });

  if (!result.success) {
    return fail(prisma, post, now, isRetryable(result.error.kind),
      result.error.code ?? result.error.kind, result.error.message);
  }

  await prisma.platformPost.update({
    where: { id: post.id },
    data: {
      status: PlatformPostStatus.PUBLISHED,
      externalPostId: result.externalPostId,
      externalUrl: result.permalink,
      publishedAt: result.publishedAt,
      errorCode: null,
      errorMessage: null,
      nextRetryAt: null,
    },
  });
  await refreshGroupStatus(prisma, post.postGroupId);

  return { published: true, externalPostId: result.externalPostId, error: null };
}

async function fail(
  prisma: PrismaClient,
  post: { id: string; postGroupId: string; attemptCount: number },
  now: Date,
  retryable: boolean,
  code: string,
  message: string,
): Promise<{ published: false; externalPostId: null; error: string }> {
  const attempts = post.attemptCount + 1;
  const willRetry = retryable && attempts < MAX_ATTEMPTS;

  await prisma.platformPost.update({
    where: { id: post.id },
    data: {
      // Still queued while a retry is pending: the post has not failed yet, it
      // is waiting, and an operator has nothing to do about it.
      status: willRetry ? PlatformPostStatus.QUEUED : PlatformPostStatus.FAILED,
      errorCode: code,
      errorMessage: message,
      nextRetryAt: willRetry
        ? new Date(now.getTime() + (RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS.at(-1) ?? 300_000))
        : null,
    },
  });
  await refreshGroupStatus(prisma, post.postGroupId);

  return { published: false, externalPostId: null, error: message };
}

/** The group's status follows its children, always. */
export async function refreshGroupStatus(prisma: PrismaClient, groupId: string): Promise<void> {
  const posts = await prisma.platformPost.findMany({
    where: { postGroupId: groupId },
    select: { status: true },
  });

  await prisma.postGroup.update({
    where: { id: groupId },
    data: { status: deriveGroupStatus(posts) },
  });
}

async function loadMedia(
  links: Array<{ media: { type: MediaType; mimeType: string; filename: string; originalName: string } }>,
): Promise<PublishMedia[]> {
  const image = links.find((link) => link.media.type === MediaType.IMAGE);
  if (!image) return [];

  return [{
    kind: 'IMAGE',
    data: await readObject(image.media.filename),
    mimeType: image.media.mimeType,
    filename: image.media.originalName,
  }];
}

async function loadPost(prisma: PrismaClient, organizationId: string, id: string) {
  const post = await prisma.platformPost.findFirst({
    where: { id, postGroup: { organizationId } },
    select: {
      id: true, postGroupId: true, platform: true, status: true, scheduledAt: true,
      postGroup: { select: { clientId: true } },
    },
  });
  if (!post) throw new SocialError('NOT_FOUND', 'Post not found', 404);
  return post;
}

// -------------------------------------------------------------- tenant guards

async function assertClient(prisma: PrismaClient, organizationId: string, clientId: string) {
  const client = await prisma.client.findFirst({
    where: { id: clientId, organizationId },
    select: { id: true },
  });
  if (!client) throw new SocialError('NOT_FOUND', 'Client not found', 404);
}

async function assertCampaign(
  prisma: PrismaClient, organizationId: string, clientId: string, campaignId: string,
) {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, organizationId, clientId },
    select: { id: true },
  });
  if (!campaign) throw new SocialError('NOT_FOUND', 'Campaign not found', 404);
}

async function assertMedia(
  prisma: PrismaClient, organizationId: string, clientId: string, mediaIds: string[],
) {
  if (mediaIds.length === 0) return;
  const unique = [...new Set(mediaIds)];

  const found = await prisma.media.findMany({
    where: { id: { in: unique }, organizationId, OR: [{ clientId }, { clientId: null }] },
    select: { id: true },
  });
  // 404, not 403: the caller has no business learning that the id exists.
  if (found.length !== unique.length) throw new SocialError('NOT_FOUND', 'Media not found', 404);
}

async function assertAccounts(
  prisma: PrismaClient, organizationId: string, clientId: string, accountIds: string[],
) {
  if (accountIds.length === 0) return;
  const unique = [...new Set(accountIds)];

  const found = await prisma.integrationAccount.findMany({
    where: { id: { in: unique }, clientId, integration: { organizationId } },
    select: { id: true },
  });
  if (found.length !== unique.length) {
    throw new SocialError('NOT_FOUND', 'Social account not found', 404);
  }
}

/**
 * /api/social — multi-platform posts.
 *
 * Sits alongside `/api/content` rather than replacing it. The single-platform
 * path is in production and carries a verified Facebook publication; both run
 * until the new one has earned the traffic.
 *
 * Authorisation is the routes' job and the state machine is the service's.
 * Keeping that line means the workflow rules cannot drift between endpoints —
 * a route can decide you are not allowed to ask, but it cannot invent a
 * transition the machine forbids.
 */

import { Router } from 'express';
import { PlatformPostStatus, Platform } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest, conflict, notFound } from '../lib/errors.js';
import { actorOf, requireAgency, requireAuth } from '../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { idParam, pageResult, paginate, paginationQuery } from '../lib/http.js';
import { assertWritable, orgId, resolveClientId, scopeWhere } from '../lib/scope.js';
import { recordAudit } from '../services/audit.js';
import {
  SocialError, createGroup, publishPlatformPost, transition, transitionGroup, updatePlatformPost,
} from '../services/social/post-groups.js';
import { overall, validateMediaForPlatform } from '../services/social/media-rules.js';
import { postGroupAnalytics, socialOverview } from '../services/social/analytics.js';

export const socialRouter: Router = Router();
socialRouter.use(requireAuth);

/** Turns the service's own errors into HTTP without flattening them into 500s. */
function rethrow(error: unknown): never {
  if (error instanceof SocialError) {
    if (error.status === 404) throw notFound(error.message);
    if (error.status === 409) throw conflict(error.message);
    throw badRequest(error.message);
  }
  throw error;
}

const platformDraft = z.object({
  platform: z.nativeEnum(Platform),
  caption: z.string().trim().max(5000).nullish(),
  headline: z.string().trim().max(300).nullish(),
  hashtags: z.array(z.string().trim().max(80)).max(40).optional(),
  linkUrl: z.string().url().max(2000).nullish(),
  ctaLabel: z.string().trim().max(80).nullish(),
  // Provider-specific settings. Never credentials — those live encrypted on the
  // integration account and are not addressable from a request body.
  config: z.record(z.unknown()).optional(),
  mediaIds: z.array(z.string().max(40)).max(10).optional(),
  integrationAccountId: z.string().max(40).nullish(),
  scheduledAt: z.coerce.date().nullish(),
});

const createSchema = z.object({
  clientId: z.string().min(1).max(40),
  campaignId: z.string().max(40).nullish(),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullish(),
  shared: z.object({
    caption: z.string().trim().max(5000).nullish(),
    hashtags: z.array(z.string().trim().max(80)).max(40).optional(),
    mediaIds: z.array(z.string().max(40)).max(10).optional(),
  }).optional(),
  platforms: z.array(platformDraft).min(1).max(8),
});

/** Everything a caller may see about a group. No credentials anywhere in it. */
const groupInclude = {
  client: { select: { id: true, name: true, businessName: true, logoUrl: true } },
  campaign: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  posts: {
    orderBy: { platform: 'asc' },
    select: {
      id: true, platform: true, caption: true, headline: true, hashtags: true,
      linkUrl: true, ctaLabel: true, config: true, status: true, scheduledAt: true,
      timezone: true, externalPostId: true, externalUrl: true, publishedAt: true,
      attemptCount: true, lastAttemptAt: true, nextRetryAt: true,
      errorCode: true, errorMessage: true,
      // The account's name and id are safe; its token is not selected, and the
      // projection is an allowlist so it cannot become selected by accident.
      integrationAccount: { select: { id: true, name: true, externalId: true, tokenStatus: true } },
      media: {
        orderBy: { position: 'asc' },
        select: {
          position: true, role: true,
          media: { select: { id: true, url: true, thumbnailUrl: true, type: true, mimeType: true } },
        },
      },
    },
  },
} as const;

socialRouter.post(
  '/post-groups',
  requireAgency,
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);
    const body = req.body as z.infer<typeof createSchema>;

    try {
      const group = await createGroup({
        prisma,
        organizationId: orgId(actor),
        clientId: body.clientId,
        createdById: actor.id,
        name: body.name,
        description: body.description,
        campaignId: body.campaignId,
        shared: body.shared,
        platforms: body.platforms,
      });

      await recordAudit({
        actor, action: 'social.group.create', entity: 'PostGroup', entityId: group.id, ip: req.ip,
      });

      const created = await prisma.postGroup.findUniqueOrThrow({
        where: { id: group.id },
        include: groupInclude,
      });
      res.status(201).json({ group: created });
    } catch (error) {
      rethrow(error);
    }
  }),
);

socialRouter.get(
  '/post-groups',
  validateQuery(paginationQuery.extend({
    clientId: z.string().max(40).optional(),
    campaignId: z.string().max(40).optional(),
    platform: z.nativeEnum(Platform).optional(),
  })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const query = req.query as unknown as z.infer<typeof paginationQuery> & {
      clientId?: string; campaignId?: string; platform?: Platform;
    };
    const clientId = resolveClientId(actor, query.clientId);

    const where = {
      ...scopeWhere(actor),
      ...(clientId ? { clientId } : {}),
      ...(query.campaignId ? { campaignId: query.campaignId } : {}),
      ...(query.platform ? { posts: { some: { platform: query.platform } } } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.postGroup.findMany({
        where, ...paginate(query), orderBy: { updatedAt: 'desc' }, include: groupInclude,
      }),
      prisma.postGroup.count({ where }),
    ]);

    res.json(pageResult(items, total, query));
  }),
);

socialRouter.get(
  '/post-groups/:id',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const group = await prisma.postGroup.findFirst({
      where: { id: req.params.id, ...scopeWhere(actor) },
      include: groupInclude,
    });
    if (!group) throw notFound('Post');
    res.json({ group });
  }),
);

/**
 * Every platform post in a window, for the calendar.
 *
 * Returns platform posts rather than groups: the calendar's unit is "a thing
 * going out at a time", and a group whose Facebook version publishes Monday and
 * whose Instagram version publishes Friday is two entries, not one.
 */
socialRouter.get(
  '/calendar',
  validateQuery(z.object({
    from: z.coerce.date(),
    to: z.coerce.date(),
    clientId: z.string().max(40).optional(),
    platform: z.nativeEnum(Platform).optional(),
    status: z.nativeEnum(PlatformPostStatus).optional(),
    campaignId: z.string().max(40).optional(),
  })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const query = req.query as unknown as {
      from: Date; to: Date; clientId?: string; platform?: Platform;
      status?: PlatformPostStatus; campaignId?: string;
    };
    const clientId = resolveClientId(actor, query.clientId);

    const items = await prisma.platformPost.findMany({
      where: {
        scheduledAt: { gte: query.from, lte: query.to },
        ...(query.platform ? { platform: query.platform } : {}),
        ...(query.status ? { status: query.status } : {}),
        postGroup: {
          ...scopeWhere(actor),
          ...(clientId ? { clientId } : {}),
          ...(query.campaignId ? { campaignId: query.campaignId } : {}),
        },
      },
      orderBy: { scheduledAt: 'asc' },
      select: {
        id: true, platform: true, status: true, scheduledAt: true, timezone: true,
        caption: true, headline: true, externalUrl: true, errorMessage: true,
        postGroup: {
          select: {
            id: true, name: true,
            client: { select: { id: true, name: true, businessName: true } },
            campaign: { select: { id: true, name: true } },
          },
        },
        media: {
          take: 1,
          orderBy: { position: 'asc' },
          select: { media: { select: { url: true, thumbnailUrl: true, type: true } } },
        },
      },
    });

    res.json({ items });
  }),
);

/**
 * Move one platform post to a new time — what a drag on the calendar does.
 *
 * Rescheduling something already published is refused: the post exists on the
 * platform at the time it went out, and changing our record would only make the
 * two disagree.
 */
socialRouter.post(
  '/platform-posts/:id/reschedule',
  requireAgency,
  validateParams(idParam),
  validateBody(z.object({ scheduledAt: z.coerce.date() })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);

    const post = await prisma.platformPost.findFirst({
      where: { id: req.params.id, postGroup: { organizationId: orgId(actor) } },
      select: { id: true, status: true, externalPostId: true, postGroupId: true },
    });
    if (!post) throw notFound('Post');

    if (post.externalPostId || post.status === PlatformPostStatus.PUBLISHED) {
      throw conflict('This post has already been published and cannot be rescheduled.');
    }
    if (post.status === PlatformPostStatus.PUBLISHING) {
      throw conflict('This post is being published right now.');
    }

    const updated = await prisma.platformPost.update({
      where: { id: post.id },
      data: { scheduledAt: (req.body as { scheduledAt: Date }).scheduledAt },
      select: { id: true, scheduledAt: true, status: true },
    });

    await recordAudit({
      actor, action: 'social.post.reschedule', entity: 'PlatformPost', entityId: post.id, ip: req.ip,
    });

    res.json({ post: updated });
  }),
);

/** Edit one platform's version. Its siblings are untouched. */
socialRouter.patch(
  '/platform-posts/:id',
  requireAgency,
  validateParams(idParam),
  validateBody(platformDraft.omit({ platform: true }).partial()),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);

    try {
      await updatePlatformPost({
        prisma,
        organizationId: orgId(actor),
        platformPostId: (req.params as { id: string }).id,
        patch: req.body as Parameters<typeof updatePlatformPost>[0]['patch'],
      });
    } catch (error) {
      rethrow(error);
    }

    const post = await prisma.platformPost.findFirstOrThrow({
      where: { id: req.params.id },
      select: { postGroupId: true },
    });
    const group = await prisma.postGroup.findUniqueOrThrow({
      where: { id: post.postGroupId },
      include: groupInclude,
    });
    res.json({ group });
  }),
);

/**
 * Publish one platform post immediately, through its provider's adapter.
 *
 * Separate from the `publish` verb above, which only queues. This is the path
 * that actually talks to the provider, and it is here rather than inline in the
 * queue so an operator can push a single platform out without waiting a minute
 * for the worker.
 */
socialRouter.post(
  '/platform-posts/:id/publish-now',
  requireAgency,
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);

    const post = await prisma.platformPost.findFirst({
      where: { id: req.params.id, postGroup: { organizationId: orgId(actor) } },
      select: { id: true, status: true, postGroupId: true },
    });
    if (!post) throw notFound('Post');

    // Approval is not optional, and this endpoint is not a way around it.
    if (!PUBLISHABLE_FROM.has(post.status)) {
      throw badRequest(
        `A post that is ${post.status.toLowerCase().replace('_', ' ')} cannot be published. It must be approved first.`,
      );
    }

    const result = await publishPlatformPost({
      prisma, platformPostId: post.id, fetchImpl: fetch as never,
    });

    await recordAudit({
      actor, action: 'social.post.publish-now', entity: 'PlatformPost', entityId: post.id,
      meta: { published: result.published, externalPostId: result.externalPostId }, ip: req.ip,
    });

    res.status(result.published ? 200 : 502).json({
      ...result,
      group: await prisma.postGroup.findUniqueOrThrow({
        where: { id: post.postGroupId }, include: groupInclude,
      }),
    });
  }),
);

const PUBLISHABLE_FROM = new Set<PlatformPostStatus>([
  PlatformPostStatus.APPROVED,
  PlatformPostStatus.SCHEDULED,
  PlatformPostStatus.QUEUED,
  PlatformPostStatus.FAILED,
]);

/**
 * Whether this platform's version could publish, and what is stopping it.
 *
 * Asked by the composer before it offers the button, so a Reel with a landscape
 * video is caught while someone is looking at it rather than at 7pm on a
 * Saturday when the platform refuses it.
 */
socialRouter.get(
  '/platform-posts/:id/readiness',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);

    const post = await prisma.platformPost.findFirst({
      where: { id: req.params.id, postGroup: { organizationId: orgId(actor) } },
      select: {
        platform: true, caption: true, headline: true, config: true,
        integrationAccount: { select: { name: true, tokenStatus: true, accessTokenEnc: true } },
        media: {
          orderBy: { position: 'asc' },
          select: {
            media: {
              select: {
                id: true, originalName: true, type: true, mimeType: true,
                sizeBytes: true, width: true, height: true, durationSeconds: true,
              },
            },
          },
        },
      },
    });
    if (!post) throw notFound('Post');

    const problems: Array<{ level: string; message: string }> = [];

    if (!post.integrationAccount) {
      problems.push({
        level: 'INCOMPATIBLE',
        message: `No ${post.platform} account is attached. Connect one under Integrations.`,
      });
    } else if (!post.integrationAccount.accessTokenEnc) {
      problems.push({
        level: 'INCOMPATIBLE',
        message: `${post.integrationAccount.name} has no usable publishing token. Reconnect it.`,
      });
    }

    if (!post.caption?.trim() && !post.headline?.trim()) {
      problems.push({ level: 'INCOMPATIBLE', message: 'The post has no text.' });
    }

    const surface = typeof (post.config as Record<string, unknown>)?.mediaType === 'string'
      ? String((post.config as Record<string, unknown>).mediaType)
      : undefined;

    const media = post.media.map((link) => ({
      mediaId: link.media.id,
      filename: link.media.originalName,
      findings: validateMediaForPlatform(link.media, post.platform, surface),
    }));

    for (const row of media) problems.push(...row.findings);

    res.json({
      ready: !problems.some((problem) => problem.level === 'INCOMPATIBLE'),
      compatibility: overall(problems as Array<{ level: 'OK' | 'WARNING' | 'INCOMPATIBLE'; message: string }>),
      problems,
      media,
    });
  }),
);

/**
 * The workflow verbs.
 *
 * Each names a destination and lets the state machine decide whether the move
 * is legal from where the post currently is. That is why there is no
 * "force" parameter: an illegal transition is a bug in the caller, not an
 * inconvenience to be overridden.
 */
type SocialAction =
  | 'submit' | 'approve' | 'request-changes' | 'schedule' | 'publish' | 'cancel';

const TRANSITIONS: Record<SocialAction, PlatformPostStatus> = {
  submit: PlatformPostStatus.IN_REVIEW,
  approve: PlatformPostStatus.APPROVED,
  'request-changes': PlatformPostStatus.CHANGES_REQUESTED,
  schedule: PlatformPostStatus.SCHEDULED,
  publish: PlatformPostStatus.QUEUED,
  cancel: PlatformPostStatus.CANCELLED,
};

socialRouter.post(
  '/platform-posts/:id/:action',
  requireAgency,
  validateParams(idParam.extend({ action: z.enum(Object.keys(TRANSITIONS) as [SocialAction, ...SocialAction[]]) })),
  validateBody(z.object({ scheduledAt: z.coerce.date().nullish() }).partial()),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);
    const { action } = req.params as unknown as { action: SocialAction };

    try {
      await transition({
        prisma,
        organizationId: orgId(actor),
        platformPostId: (req.params as { id: string }).id,
        to: TRANSITIONS[action],
        scheduledAt: (req.body as { scheduledAt?: Date | null }).scheduledAt,
      });
    } catch (error) {
      rethrow(error);
    }

    await recordAudit({
      actor, action: `social.post.${action}`, entity: 'PlatformPost', entityId: req.params.id, ip: req.ip,
    });

    const post = await prisma.platformPost.findFirstOrThrow({
      where: { id: req.params.id },
      select: { postGroupId: true },
    });
    res.json({
      group: await prisma.postGroup.findUniqueOrThrow({
        where: { id: post.postGroupId }, include: groupInclude,
      }),
    });
  }),
);

/** The same verbs across every platform in a group, skipping what cannot move. */
socialRouter.post(
  '/post-groups/:id/:action',
  requireAgency,
  validateParams(idParam.extend({ action: z.enum(Object.keys(TRANSITIONS) as [SocialAction, ...SocialAction[]]) })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);
    const { action } = req.params as unknown as { action: SocialAction };

    let result: { moved: number; skipped: number };
    try {
      result = await transitionGroup({
        prisma,
        organizationId: orgId(actor),
        groupId: (req.params as { id: string }).id,
        to: TRANSITIONS[action],
      });
    } catch (error) {
      rethrow(error);
    }

    await recordAudit({
      actor, action: `social.group.${action}`, entity: 'PostGroup', entityId: req.params.id, ip: req.ip,
    });

    res.json({
      ...result,
      group: await prisma.postGroup.findUniqueOrThrow({
        where: { id: req.params.id }, include: groupInclude,
      }),
    });
  }),
);


socialRouter.delete(
  '/post-groups/:id',
  requireAgency,
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);

    const group = await prisma.postGroup.findFirst({
      where: { id: req.params.id, organizationId: orgId(actor) },
      select: { id: true, posts: { select: { externalPostId: true } } },
    });
    if (!group) throw notFound('Post');

    /*
     * A published post exists on a platform and deleting our record would not
     * remove it — it would only lose the link between the two, leaving a post
     * nobody can trace back to the campaign that made it.
     */
    if (group.posts.some((post) => post.externalPostId)) {
      throw conflict(
        'This post has already been published to at least one platform. Delete it on the platform first.',
      );
    }

    await prisma.postGroup.delete({ where: { id: group.id } });
    await recordAudit({
      actor, action: 'social.group.delete', entity: 'PostGroup', entityId: group.id, ip: req.ip,
    });

    res.json({ ok: true });
  }),
);

socialRouter.get(
  '/analytics/overview',
  validateQuery(z.object({
    clientId: z.string().max(40).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const query = req.query as unknown as { clientId?: string; from?: Date; to?: Date };
    const clientId = resolveClientId(actor, query.clientId);

    const overview = await socialOverview(orgId(actor), clientId ?? undefined, query.from, query.to);
    res.json(overview);
  }),
);

socialRouter.get(
  '/post-groups/:id/analytics',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const analytics = await postGroupAnalytics((req.params as { id: string }).id, orgId(actor));
    if (!analytics) throw notFound('Post group');
    res.json(analytics);
  }),
);

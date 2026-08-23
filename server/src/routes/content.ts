/** /api/content — the content studio: CRUD, AI generation, scheduling, submission. */

import { Router } from 'express';
import {
  ApprovalStatus, ContentStatus, ContentType, Language, NotificationType, Platform, Prisma,
} from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest, conflict, notFound } from '../lib/errors.js';
import { actorOf, requireAgency, requireAuth } from '../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { idParam, pageResult, paginate, paginationQuery } from '../lib/http.js';
import { assertWritable, orgId, resolveClientId, scopeWhere } from '../lib/scope.js';
import { brandContext, generateCopy, generateHashtags, platformRule } from '../services/ai/index.js';
import { recordAiUsage, recordAudit } from '../services/audit.js';
import { notify } from '../services/notify.js';
import { contentTimeline } from '../services/content/timeline.js';

export const contentRouter: Router = Router();
contentRouter.use(requireAuth);

/**
 * The statuses a piece of content may be submitted for approval from.
 *
 * Everything else is either already with a reviewer, already decided, or out
 * in the world — none of which is a thing you send for review.
 */
const SUBMITTABLE = new Set<ContentStatus>([
  ContentStatus.DRAFT,
  ContentStatus.CHANGES_REQUESTED,
  ContentStatus.REJECTED,
]);

const copyFields = {
  headline: z.string().trim().max(300).nullish(),
  caption: z.string().trim().max(5000).nullish(),
  primaryText: z.string().trim().max(6000).nullish(),
  shortText: z.string().trim().max(1000).nullish(),
  longText: z.string().trim().max(20000).nullish(),
  slogan: z.string().trim().max(300).nullish(),
  cta: z.string().trim().max(200).nullish(),
};

const createSchema = z.object({
  clientId: z.string().min(1).max(40),
  campaignId: z.string().max(40).nullish(),
  name: z.string().trim().min(2).max(200),
  type: z.nativeEnum(ContentType).default(ContentType.POST),
  platform: z.nativeEnum(Platform),
  language: z.nativeEnum(Language).default(Language.EN),
  tone: z.string().trim().max(120).nullish(),
  productService: z.string().trim().max(300).nullish(),
  offer: z.string().trim().max(300).nullish(),
  audience: z.string().trim().max(500).nullish(),
  scheduledAt: z.coerce.date().nullish(),
  timezone: z.string().trim().max(60).default('UTC'),
  mediaIds: z.array(z.string().max(40)).max(10).default([]),
  hashtags: z.array(z.string().trim().min(2).max(60)).max(30).default([]),
  ...copyFields,
});

const updateSchema = createSchema.partial().extend({
  status: z.nativeEnum(ContentStatus).optional(),
});

/** Confirms both the client and (optional) campaign belong to this tenant. */
async function assertRefs(organizationId: string, clientId: string, campaignId?: string | null) {
  const client = await prisma.client.findFirst({ where: { id: clientId, organizationId }, select: { id: true } });
  if (!client) throw notFound('Client');

  if (campaignId) {
    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId, organizationId, clientId },
      select: { id: true },
    });
    if (!campaign) throw notFound('Campaign');
  }
}

/**
 * Every attached media row must belong to this tenant.
 *
 * `mediaIds` arrives from a request body, and until this existed it was written
 * straight into ContentMedia unchecked — so quoting another organisation's media
 * id was enough to attach their file, have it rendered in this tenant's preview,
 * and eventually publish it. An id in a payload is a claim, not a permission.
 *
 * Media may be attached to the client that owns it, or be unassigned
 * organisation-level stock; anything else is refused.
 */
async function assertMedia(organizationId: string, clientId: string, mediaIds: string[]) {
  if (mediaIds.length === 0) return;

  const unique = [...new Set(mediaIds)];
  const found = await prisma.media.findMany({
    where: { id: { in: unique }, organizationId, OR: [{ clientId }, { clientId: null }] },
    select: { id: true },
  });

  if (found.length !== unique.length) throw notFound('Media');
}

const contentInclude = {
  client: { select: { id: true, name: true, businessName: true, logoUrl: true } },
  campaign: { select: { id: true, name: true } },
  author: { select: { id: true, name: true } },
  hashtags: { select: { id: true, tag: true, source: true } },
  mediaLinks: { include: { media: true }, orderBy: { position: 'asc' } },
  approvals: { orderBy: { createdAt: 'desc' }, take: 5, include: { decidedBy: { select: { id: true, name: true } } } },
  comments: { orderBy: { createdAt: 'desc' }, take: 20, include: { author: { select: { id: true, name: true } } } },
} satisfies Prisma.ContentInclude;

contentRouter.get(
  '/',
  validateQuery(
    paginationQuery.extend({
      clientId: z.string().max(40).optional(),
      campaignId: z.string().max(40).optional(),
      status: z.nativeEnum(ContentStatus).optional(),
      platform: z.nativeEnum(Platform).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const query = req.query as unknown as z.infer<typeof paginationQuery> & {
      clientId?: string; campaignId?: string; status?: ContentStatus; platform?: Platform;
    };
    const clientId = resolveClientId(actor, query.clientId);

    const where: Prisma.ContentWhereInput = {
      organizationId: orgId(actor),
      ...(clientId ? { clientId } : {}),
      ...(query.campaignId ? { campaignId: query.campaignId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.platform ? { platform: query.platform } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { headline: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.content.findMany({
        where,
        ...paginate(query),
        orderBy: { updatedAt: 'desc' },
        include: {
          client: { select: { id: true, name: true } },
          campaign: { select: { id: true, name: true } },
          hashtags: { select: { tag: true } },
          mediaLinks: { include: { media: { select: { id: true, url: true, thumbnailUrl: true, type: true } } }, take: 1 },
        },
      }),
      prisma.content.count({ where }),
    ]);

    res.json(pageResult(items, total, query));
  }),
);

contentRouter.post(
  '/',
  requireAgency,
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);
    const body = req.body as z.infer<typeof createSchema>;
    await assertRefs(orgId(actor), body.clientId, body.campaignId);
    await assertMedia(orgId(actor), body.clientId, body.mediaIds);

    const { mediaIds, hashtags, ...data } = body;

    const content = await prisma.content.create({
      data: {
        ...data,
        organizationId: orgId(actor),
        authorId: actor.id,
        status: data.scheduledAt ? ContentStatus.DRAFT : ContentStatus.DRAFT,
        hashtags: { create: hashtags.map((tag) => ({ tag, source: 'manual' })) },
        mediaLinks: { create: mediaIds.map((mediaId, position) => ({ mediaId, position })) },
      },
      include: contentInclude,
    });

    await recordAudit({ actor, action: 'content.create', entity: 'Content', entityId: content.id, ip: req.ip });
    res.status(201).json({ content });
  }),
);

contentRouter.get(
  '/:id',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const content = await prisma.content.findFirst({
      where: { id: req.params.id, ...scopeWhere(actor) },
      include: contentInclude,
    });
    if (!content) throw notFound('Content');
    res.json({ content });
  }),
);

/**
 * What happened to this content, in order.
 *
 * Readable by anyone who can read the content itself — a client reviewer needs
 * the history of their own approvals more than anyone.
 */
contentRouter.get(
  '/:id/timeline',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);

    const content = await prisma.content.findFirst({
      where: { id: req.params.id, ...scopeWhere(actor) },
      select: { id: true },
    });
    if (!content) throw notFound('Content');

    const events = await contentTimeline({
      prisma,
      contentId: content.id,
      organizationId: orgId(actor),
    });

    res.json({ events });
  }),
);

contentRouter.patch(
  '/:id',
  requireAgency,
  validateParams(idParam),
  validateBody(updateSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);

    const existing = await prisma.content.findFirst({
      where: { id: req.params.id, ...scopeWhere(actor) },
      select: { id: true, clientId: true },
    });
    if (!existing) throw notFound('Content');

    const body = req.body as z.infer<typeof updateSchema>;
    if (body.campaignId) await assertRefs(orgId(actor), existing.clientId, body.campaignId);
    if (body.mediaIds) await assertMedia(orgId(actor), existing.clientId, body.mediaIds);

    const { mediaIds, hashtags, clientId: _pinned, ...data } = body;

    const content = await prisma.content.update({
      where: { id: existing.id },
      data: {
        ...data,
        ...(hashtags ? { hashtags: { deleteMany: {}, create: hashtags.map((tag) => ({ tag, source: 'manual' })) } } : {}),
        ...(mediaIds
          ? { mediaLinks: { deleteMany: {}, create: mediaIds.map((mediaId, position) => ({ mediaId, position })) } }
          : {}),
      },
      include: contentInclude,
    });

    // The calendar row mirrors the schedule, so it is kept in step here.
    if (data.scheduledAt !== undefined) await syncCalendar(content.id);

    await recordAudit({ actor, action: 'content.update', entity: 'Content', entityId: content.id, ip: req.ip });
    res.json({ content });
  }),
);

contentRouter.delete(
  '/:id',
  requireAgency,
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);

    const existing = await prisma.content.findFirst({
      where: { id: req.params.id, ...scopeWhere(actor) },
      select: { id: true, name: true },
    });
    if (!existing) throw notFound('Content');

    await prisma.content.delete({ where: { id: existing.id } });
    await recordAudit({
      actor, action: 'content.delete', entity: 'Content', entityId: existing.id,
      meta: { name: existing.name }, ip: req.ip,
    });
    res.json({ ok: true });
  }),
);

// ------------------------------------------------------------------ scheduling

const scheduleSchema = z.object({
  scheduledAt: z.coerce.date(),
  timezone: z.string().trim().max(60).default('UTC'),
});

contentRouter.post(
  '/:id/schedule',
  requireAgency,
  validateParams(idParam),
  validateBody(scheduleSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);
    const { scheduledAt, timezone } = req.body as z.infer<typeof scheduleSchema>;

    const existing = await prisma.content.findFirst({
      where: { id: req.params.id, ...scopeWhere(actor) },
      select: { id: true, status: true },
    });
    if (!existing) throw notFound('Content');

    // Scheduling unapproved work is the mistake this guard exists to prevent.
    if (existing.status !== ContentStatus.APPROVED && existing.status !== ContentStatus.SCHEDULED) {
      throw badRequest('Content must be approved before it can be scheduled');
    }

    const content = await prisma.content.update({
      where: { id: existing.id },
      data: { scheduledAt, timezone, status: ContentStatus.SCHEDULED },
      include: contentInclude,
    });
    await syncCalendar(content.id);

    await recordAudit({ actor, action: 'content.schedule', entity: 'Content', entityId: content.id, ip: req.ip });
    res.json({ content });
  }),
);

/** Keeps CalendarEvent in step with the content's schedule. */
async function syncCalendar(contentId: string): Promise<void> {
  const content = await prisma.content.findUnique({
    where: { id: contentId },
    select: {
      id: true, name: true, platform: true, scheduledAt: true, timezone: true,
      organizationId: true, clientId: true,
    },
  });
  if (!content) return;

  if (!content.scheduledAt) {
    await prisma.calendarEvent.deleteMany({ where: { contentId } });
    return;
  }

  await prisma.calendarEvent.upsert({
    where: { contentId },
    create: {
      contentId,
      organizationId: content.organizationId,
      clientId: content.clientId,
      title: content.name,
      platform: content.platform,
      startAt: content.scheduledAt,
      timezone: content.timezone,
    },
    update: {
      title: content.name,
      platform: content.platform,
      startAt: content.scheduledAt,
      timezone: content.timezone,
    },
  });
}

// ------------------------------------------------------------------ approval flow

contentRouter.post(
  '/:id/submit',
  requireAgency,
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);

    const existing = await prisma.content.findFirst({
      where: { id: req.params.id, ...scopeWhere(actor) },
      include: { client: { select: { id: true, name: true } } },
    });
    if (!existing) throw notFound('Content');

    /*
     * Only work that is actually the author's to send may be sent.
     *
     * Without this, submitting was accepted from any status at all: approved
     * content could be pushed back into review, published content could be
     * "submitted" again, and each call stacked another PENDING approval on the
     * same piece. A reviewer then saw the same post several times and the
     * history could no longer say which decision belonged to which submission.
     */
    if (!SUBMITTABLE.has(existing.status)) {
      throw badRequest(
        `Content in ${existing.status} cannot be submitted for approval. Only a draft, or one sent back for changes, can be.`,
      );
    }

    // Belt and braces: a pending approval means it is already with a reviewer,
    // even if the content status somehow disagrees.
    const pending = await prisma.approval.count({
      where: { contentId: existing.id, status: ApprovalStatus.PENDING },
    });
    if (pending > 0) throw conflict('This content is already waiting for a decision');

    const content = await prisma.content.update({
      where: { id: existing.id },
      data: {
        status: ContentStatus.SUBMITTED,
        approvals: {
          create: { organizationId: existing.organizationId, clientId: existing.clientId, status: 'PENDING' },
        },
      },
      include: contentInclude,
    });

    await notify({
      organizationId: existing.organizationId,
      clientId: existing.clientId,
      type: NotificationType.APPROVAL_REQUESTED,
      title: `Approval needed: ${content.name}`,
      body: `${existing.client.name} has content waiting for review.`,
      link: `/client/approvals`,
      audience: 'both',
    });

    res.json({ content });
  }),
);

// ------------------------------------------------------------------ AI studio

const generateSchema = z.object({
  clientId: z.string().min(1).max(40),
  platform: z.nativeEnum(Platform),
  contentType: z.nativeEnum(ContentType).default(ContentType.POST),
  language: z.nativeEnum(Language).default(Language.EN),
  tone: z.string().trim().max(120).nullish(),
  productService: z.string().trim().max(300).nullish(),
  offer: z.string().trim().max(300).nullish(),
  audience: z.string().trim().max(500).nullish(),
  adName: z.string().trim().max(200).nullish(),
});

/**
 * Generate copy. Nothing is written to the database here — the result goes back
 * to the studio for the user to edit and then save through the normal endpoints.
 */
contentRouter.post(
  '/generate',
  requireAgency,
  validateBody(generateSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);
    const body = req.body as z.infer<typeof generateSchema>;

    const brand = await prisma.brand.findFirst({
      where: { clientId: body.clientId, organizationId: orgId(actor) },
    });
    if (!brand) throw notFound('Brand');

    const result = await generateCopy(brandContext(brand), {
      platform: body.platform,
      contentType: body.contentType,
      language: body.language,
      tone: body.tone,
      productService: body.productService,
      offer: body.offer,
      audience: body.audience,
      adName: body.adName,
    });

    await recordAiUsage({
      organizationId: orgId(actor),
      clientId: body.clientId,
      userId: actor.id,
      kind: 'CONTENT',
      model: result.model,
      provider: result.provider,
      latencyMs: result.latencyMs,
    });

    res.json({
      generated: result.data,
      meta: { provider: result.provider, model: result.model, isFallback: result.isFallback, notice: result.notice },
    });
  }),
);

contentRouter.post(
  '/hashtags',
  requireAgency,
  validateBody(generateSchema.extend({ limit: z.coerce.number().int().min(1).max(30).optional() })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);
    const body = req.body as z.infer<typeof generateSchema> & { limit?: number };

    const brand = await prisma.brand.findFirst({
      where: { clientId: body.clientId, organizationId: orgId(actor) },
    });
    if (!brand) throw notFound('Brand');

    const result = await generateHashtags(
      brandContext(brand),
      {
        platform: body.platform,
        contentType: body.contentType,
        language: body.language,
        tone: body.tone,
        productService: body.productService,
        offer: body.offer,
        audience: body.audience,
      },
      body.limit,
    );

    await recordAiUsage({
      organizationId: orgId(actor),
      clientId: body.clientId,
      userId: actor.id,
      kind: 'HASHTAGS',
      model: result.model,
      provider: result.provider,
      latencyMs: result.latencyMs,
    });

    res.json({
      hashtags: result.data,
      limit: platformRule(body.platform).hashtags,
      meta: { provider: result.provider, model: result.model, isFallback: result.isFallback, notice: result.notice },
    });
  }),
);

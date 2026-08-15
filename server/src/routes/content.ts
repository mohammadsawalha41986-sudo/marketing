/** /api/content — the content studio: CRUD, AI generation, scheduling. */

import { Router } from 'express';
import { ContentStatus, ContentType, Language, NotificationType, Platform, Prisma } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest, notFound } from '../lib/errors.js';
import { actorOf, requireAuth } from '../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { idParam, pageResult, paginate, paginationQuery } from '../lib/http.js';
import { brandContext, generateCopy, generateHashtags, platformRule } from '../services/ai/index.js';
import { recordAiUsage, recordAudit } from '../services/audit.js';
import { notify } from '../services/notify.js';

export const contentRouter: Router = Router();
contentRouter.use(requireAuth);

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
  restaurantId: z.string().min(1).max(40),
  campaignId: z.string().max(40).nullish(),
  name: z.string().trim().min(2).max(200),
  type: z.nativeEnum(ContentType).default(ContentType.POST),
  status: z.nativeEnum(ContentStatus).default(ContentStatus.IDEA),
  platform: z.nativeEnum(Platform),
  language: z.nativeEnum(Language).default(Language.EN),
  tone: z.string().trim().max(120).nullish(),
  productService: z.string().trim().max(300).nullish(),
  offer: z.string().trim().max(300).nullish(),
  audience: z.string().trim().max(500).nullish(),
  brief: z.string().trim().max(4000).nullish(),
  notes: z.string().trim().max(4000).nullish(),
  scheduledAt: z.coerce.date().nullish(),
  timezone: z.string().trim().max(60).default('Asia/Riyadh'),
  mediaIds: z.array(z.string().max(40)).max(10).default([]),
  hashtags: z.array(z.string().trim().min(2).max(60)).max(30).default([]),
  ...copyFields,
});

const updateSchema = createSchema.partial();

/**
 * Confirms the restaurant exists and that the campaign, if given, belongs to
 * that same restaurant. This is what keeps one restaurant's content from ever
 * being filed under another's campaign.
 */
async function assertRefs(restaurantId: string, campaignId?: string | null) {
  const restaurant = await prisma.restaurant.findUnique({ where: { id: restaurantId }, select: { id: true } });
  if (!restaurant) throw notFound('Restaurant');

  if (campaignId) {
    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId, restaurantId },
      select: { id: true },
    });
    if (!campaign) throw notFound('Campaign');
  }
}

const contentInclude = {
  restaurant: { select: { id: true, name: true, businessName: true, logoUrl: true } },
  campaign: { select: { id: true, name: true } },
  author: { select: { id: true, name: true } },
  hashtags: { select: { id: true, tag: true, source: true } },
  mediaLinks: { include: { media: true }, orderBy: { position: 'asc' } },
} satisfies Prisma.ContentInclude;

contentRouter.get(
  '/',
  validateQuery(
    paginationQuery.extend({
      restaurantId: z.string().max(40).optional(),
      campaignId: z.string().max(40).optional(),
      status: z.nativeEnum(ContentStatus).optional(),
      type: z.nativeEnum(ContentType).optional(),
      platform: z.nativeEnum(Platform).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof paginationQuery> & {
      restaurantId?: string; campaignId?: string; status?: ContentStatus;
      type?: ContentType; platform?: Platform;
    };

    const where: Prisma.ContentWhereInput = {
      ...(query.restaurantId ? { restaurantId: query.restaurantId } : {}),
      ...(query.campaignId ? { campaignId: query.campaignId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.platform ? { platform: query.platform } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { headline: { contains: query.search, mode: 'insensitive' } },
              { caption: { contains: query.search, mode: 'insensitive' } },
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
          restaurant: { select: { id: true, name: true, logoUrl: true } },
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
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const body = req.body as z.infer<typeof createSchema>;
    await assertRefs(body.restaurantId, body.campaignId);

    const { mediaIds, hashtags, ...data } = body;

    const content = await prisma.content.create({
      data: {
        ...data,
        authorId: actor.id,
        hashtags: { create: hashtags.map((tag) => ({ tag, source: 'manual' })) },
        mediaLinks: { create: mediaIds.map((mediaId, position) => ({ mediaId, position })) },
      },
      include: contentInclude,
    });

    if (content.scheduledAt) await syncCalendar(content.id);

    await recordAudit({ actor, action: 'content.create', entity: 'Content', entityId: content.id, ip: req.ip });
    res.status(201).json({ content });
  }),
);

contentRouter.get(
  '/:id',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const content = await prisma.content.findUnique({
      where: { id: req.params.id },
      include: contentInclude,
    });
    if (!content) throw notFound('Content');
    res.json({ content });
  }),
);

contentRouter.patch(
  '/:id',
  validateParams(idParam),
  validateBody(updateSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);

    const existing = await prisma.content.findUnique({
      where: { id: req.params.id },
      select: { id: true, restaurantId: true },
    });
    if (!existing) throw notFound('Content');

    const body = req.body as z.infer<typeof updateSchema>;
    if (body.campaignId) await assertRefs(existing.restaurantId, body.campaignId);

    // The restaurant is fixed at creation, for the same reason a campaign's is.
    const { mediaIds, hashtags, restaurantId: _pinned, ...data } = body;

    const content = await prisma.content.update({
      where: { id: existing.id },
      data: {
        ...data,
        // Publishing stamps the date the dashboards count from.
        ...(data.status === ContentStatus.PUBLISHED ? { publishedAt: new Date() } : {}),
        ...(hashtags ? { hashtags: { deleteMany: {}, create: hashtags.map((tag) => ({ tag, source: 'manual' })) } } : {}),
        ...(mediaIds
          ? { mediaLinks: { deleteMany: {}, create: mediaIds.map((mediaId, position) => ({ mediaId, position })) } }
          : {}),
      },
      include: contentInclude,
    });

    // The calendar row mirrors the schedule, so it is kept in step here.
    if (data.scheduledAt !== undefined || data.name !== undefined || data.platform !== undefined) {
      await syncCalendar(content.id);
    }

    await recordAudit({ actor, action: 'content.update', entity: 'Content', entityId: content.id, ip: req.ip });
    res.json({ content });
  }),
);

contentRouter.delete(
  '/:id',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);

    const existing = await prisma.content.findUnique({
      where: { id: req.params.id },
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
  timezone: z.string().trim().max(60).default('Asia/Riyadh'),
});

contentRouter.post(
  '/:id/schedule',
  validateParams(idParam),
  validateBody(scheduleSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const { scheduledAt, timezone } = req.body as z.infer<typeof scheduleSchema>;

    const existing = await prisma.content.findUnique({
      where: { id: req.params.id },
      select: { id: true, status: true, restaurantId: true, name: true },
    });
    if (!existing) throw notFound('Content');

    // Already-published work is history. Re-dating it would silently rewrite
    // what the analytics and reports say went out, and when.
    if (existing.status === ContentStatus.PUBLISHED) {
      throw badRequest('This content has already been published and cannot be rescheduled');
    }

    const content = await prisma.content.update({
      where: { id: existing.id },
      data: { scheduledAt, timezone, status: ContentStatus.SCHEDULED },
      include: contentInclude,
    });
    await syncCalendar(content.id);

    await notify({
      restaurantId: existing.restaurantId,
      type: NotificationType.CONTENT_SCHEDULED,
      title: `Scheduled: ${content.name}`,
      body: `${content.restaurant.name} · ${scheduledAt.toISOString().slice(0, 16).replace('T', ' ')}`,
      link: `/content/${content.id}`,
    });
    await recordAudit({ actor, action: 'content.schedule', entity: 'Content', entityId: content.id, ip: req.ip });
    res.json({ content });
  }),
);

contentRouter.post(
  '/:id/publish',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);

    const existing = await prisma.content.findUnique({
      where: { id: req.params.id },
      select: { id: true, status: true, restaurantId: true },
    });
    if (!existing) throw notFound('Content');
    if (existing.status === ContentStatus.PUBLISHED) throw badRequest('This content is already published');

    /*
     * This records that the operator published the post; it does not post to
     * any network. No publishing integration exists — the ad-platform adapters
     * are architecture only — and marking it "published" here is a statement
     * about what the operator did, not a claim that the app did it.
     */
    const content = await prisma.content.update({
      where: { id: existing.id },
      data: { status: ContentStatus.PUBLISHED, publishedAt: new Date() },
      include: contentInclude,
    });

    await notify({
      restaurantId: existing.restaurantId,
      type: NotificationType.CONTENT_PUBLISHED,
      title: `Published: ${content.name}`,
      link: `/content/${content.id}`,
    });
    await recordAudit({ actor, action: 'content.publish', entity: 'Content', entityId: content.id, ip: req.ip });
    res.json({ content });
  }),
);

/** Keeps CalendarEvent in step with the content's schedule. */
async function syncCalendar(contentId: string): Promise<void> {
  const content = await prisma.content.findUnique({
    where: { id: contentId },
    select: { id: true, name: true, platform: true, scheduledAt: true, timezone: true, restaurantId: true },
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
      restaurantId: content.restaurantId,
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

// ------------------------------------------------------------------ AI studio

const generateSchema = z.object({
  restaurantId: z.string().min(1).max(40),
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
 * Generate copy for one restaurant.
 *
 * The brand context is loaded from the named restaurant and nothing else is
 * passed in, so a generation for one restaurant cannot pick up another's tone,
 * offers or forbidden words. Nothing is written to the database here — the
 * result goes back to the studio for the operator to edit and then save through
 * the normal endpoints.
 */
contentRouter.post(
  '/generate',
  validateBody(generateSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof generateSchema>;

    const brand = await prisma.brand.findUnique({ where: { restaurantId: body.restaurantId } });
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
      restaurantId: body.restaurantId,
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
  validateBody(generateSchema.extend({ limit: z.coerce.number().int().min(1).max(30).optional() })),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof generateSchema> & { limit?: number };

    const brand = await prisma.brand.findUnique({ where: { restaurantId: body.restaurantId } });
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
      restaurantId: body.restaurantId,
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

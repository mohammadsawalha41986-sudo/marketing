/** /api/restaurants — the restaurant clients the operator markets for. */

import { Router } from 'express';
import { Language, Prisma, RestaurantStatus } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { asyncHandler, conflict, notFound } from '../lib/errors.js';
import { actorOf, requireAuth } from '../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { idParam, pageResult, paginate, paginationQuery } from '../lib/http.js';
import { recordAudit } from '../services/audit.js';
import { derive, sumSnapshots } from '../services/analytics.js';

export const restaurantsRouter: Router = Router();
restaurantsRouter.use(requireAuth);

const upsertSchema = z.object({
  name: z.string().trim().min(2).max(160),
  businessName: z.string().trim().min(2).max(160),
  email: z.string().trim().toLowerCase().email().max(255).optional().or(z.literal('')),
  phone: z.string().trim().max(40).optional().or(z.literal('')),
  cuisine: z.string().trim().max(120).optional().or(z.literal('')),
  description: z.string().trim().max(2000).optional().or(z.literal('')),
  website: z.string().trim().url().max(255).optional().or(z.literal('')),
  location: z.string().trim().max(200).optional().or(z.literal('')),
  address: z.string().trim().max(400).optional().or(z.literal('')),
  branches: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  marketingObjectives: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
  notes: z.string().trim().max(4000).optional().or(z.literal('')),
  status: z.nativeEnum(RestaurantStatus).default(RestaurantStatus.ACTIVE),
  socialLinks: z.record(z.string().max(300)).default({}),
  googleBusiness: z.record(z.string().max(300)).default({}),
  preferredLanguage: z.nativeEnum(Language).default(Language.EN),
});

const blankToNull = <T extends Record<string, unknown>>(input: T): T => {
  const output = { ...input };
  for (const [key, value] of Object.entries(output)) {
    if (value === '') (output as Record<string, unknown>)[key] = null;
  }
  return output;
};

restaurantsRouter.get(
  '/',
  validateQuery(paginationQuery.extend({ status: z.nativeEnum(RestaurantStatus).optional() })),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof paginationQuery> & { status?: RestaurantStatus };

    const where: Prisma.RestaurantWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { businessName: { contains: query.search, mode: 'insensitive' } },
              { cuisine: { contains: query.search, mode: 'insensitive' } },
              { location: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.restaurant.findMany({
        where,
        ...paginate(query),
        orderBy: { createdAt: 'desc' },
        include: {
          brand: { select: { primaryColor: true, secondaryColor: true, accentColor: true, logoUrl: true } },
          _count: { select: { campaigns: true, contents: true, ads: true, media: true } },
        },
      }),
      prisma.restaurant.count({ where }),
    ]);

    res.json(pageResult(items, total, query));
  }),
);

restaurantsRouter.post(
  '/',
  validateBody(upsertSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const body = blankToNull(req.body as z.infer<typeof upsertSchema>);
    const { preferredLanguage, socialLinks, googleBusiness, ...restaurantData } = body;

    const taken = await prisma.restaurant.findUnique({ where: { name: restaurantData.name }, select: { id: true } });
    if (taken) throw conflict('A restaurant with that name already exists');

    // Every restaurant gets a Brand row immediately: the AI layer requires one.
    const restaurant = await prisma.restaurant.create({
      data: {
        ...restaurantData,
        socialLinks: socialLinks as Prisma.InputJsonValue,
        googleBusiness: googleBusiness as Prisma.InputJsonValue,
        brand: {
          create: {
            businessName: restaurantData.businessName,
            cuisine: restaurantData.cuisine ?? null,
            description: restaurantData.description ?? null,
            location: restaurantData.location ?? null,
            preferredLanguage,
          },
        },
      },
      include: { brand: true },
    });

    await recordAudit({ actor, action: 'restaurant.create', entity: 'Restaurant', entityId: restaurant.id, ip: req.ip });
    res.status(201).json({ restaurant });
  }),
);

restaurantsRouter.get(
  '/:id',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: req.params.id },
      include: {
        brand: { include: { assets: true } },
        integrations: { select: { id: true, platform: true, status: true, accountName: true, lastSyncAt: true } },
        _count: { select: { campaigns: true, contents: true, ads: true, media: true, reports: true, tasks: true } },
      },
    });
    if (!restaurant) throw notFound('Restaurant');
    res.json({ restaurant });
  }),
);

/**
 * Headline numbers for the restaurant workspace overview.
 *
 * Spend, reach and the rest come from AnalyticsSnapshot; ad figures come from
 * the Ad table, which the operator fills in by hand. They are reported
 * separately rather than summed, because adding a hand-entered ad total to a
 * snapshot total would double-count the same money.
 */
restaurantsRouter.get(
  '/:id/overview',
  validateParams(idParam),
  validateQuery(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) })),
  asyncHandler(async (req, res) => {
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    });
    if (!restaurant) throw notFound('Restaurant');

    const { days } = req.query as unknown as { days: number };
    const since = new Date(Date.now() - (days - 1) * 86400000);
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));

    const [snapshots, campaigns, scheduled, publishedThisMonth, ads, upcoming, recentContent, openTasks] =
      await Promise.all([
        prisma.analyticsSnapshot.findMany({
          where: { restaurantId: restaurant.id, date: { gte: since } },
          select: {
            platform: true, date: true, spend: true, reach: true, impressions: true,
            clicks: true, leads: true, conversions: true, revenue: true, engagements: true,
          },
        }),
        prisma.campaign.groupBy({ by: ['status'], where: { restaurantId: restaurant.id }, _count: { _all: true } }),
        prisma.content.count({ where: { restaurantId: restaurant.id, status: 'SCHEDULED' } }),
        prisma.content.count({
          where: { restaurantId: restaurant.id, status: 'PUBLISHED', publishedAt: { gte: monthStart } },
        }),
        prisma.ad.aggregate({
          where: { restaurantId: restaurant.id, status: { in: ['ACTIVE', 'COMPLETED'] } },
          _sum: { spend: true, impressions: true, reach: true, clicks: true, leads: true, conversions: true, revenue: true },
          _count: { _all: true },
        }),
        prisma.content.findMany({
          where: { restaurantId: restaurant.id, status: 'SCHEDULED', scheduledAt: { gte: new Date() } },
          orderBy: { scheduledAt: 'asc' },
          take: 6,
          select: { id: true, name: true, type: true, platform: true, scheduledAt: true },
        }),
        prisma.content.findMany({
          where: { restaurantId: restaurant.id },
          orderBy: { updatedAt: 'desc' },
          take: 6,
          select: { id: true, name: true, status: true, type: true, platform: true, scheduledAt: true, updatedAt: true },
        }),
        prisma.task.count({ where: { restaurantId: restaurant.id, status: { not: 'DONE' } } }),
      ]);

    res.json({
      metrics: derive(sumSnapshots(snapshots)),
      campaignsByStatus: Object.fromEntries(campaigns.map((row) => [row.status, row._count._all])),
      ads: {
        count: ads._count._all,
        spend: Number(ads._sum.spend ?? 0),
        impressions: ads._sum.impressions ?? 0,
        reach: ads._sum.reach ?? 0,
        clicks: ads._sum.clicks ?? 0,
        leads: ads._sum.leads ?? 0,
        conversions: ads._sum.conversions ?? 0,
        revenue: Number(ads._sum.revenue ?? 0),
      },
      scheduled,
      publishedThisMonth,
      openTasks,
      upcoming,
      recentContent,
      window: { from: since.toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10), days },
    });
  }),
);

restaurantsRouter.patch(
  '/:id',
  validateParams(idParam),
  validateBody(upsertSchema.partial()),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);

    const existing = await prisma.restaurant.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true },
    });
    if (!existing) throw notFound('Restaurant');

    const body = blankToNull(req.body as Partial<z.infer<typeof upsertSchema>>);
    const { preferredLanguage, socialLinks, googleBusiness, ...rest } = body;

    if (rest.name && rest.name !== existing.name) {
      const taken = await prisma.restaurant.findUnique({ where: { name: rest.name }, select: { id: true } });
      if (taken) throw conflict('A restaurant with that name already exists');
    }

    const restaurant = await prisma.restaurant.update({
      where: { id: existing.id },
      data: {
        ...rest,
        ...(socialLinks ? { socialLinks: socialLinks as Prisma.InputJsonValue } : {}),
        ...(googleBusiness ? { googleBusiness: googleBusiness as Prisma.InputJsonValue } : {}),
        ...(preferredLanguage ? { brand: { update: { preferredLanguage } } } : {}),
      },
      include: { brand: true },
    });

    await recordAudit({ actor, action: 'restaurant.update', entity: 'Restaurant', entityId: restaurant.id, ip: req.ip });
    res.json({ restaurant });
  }),
);

/**
 * Archive rather than delete.
 *
 * A restaurant carries every campaign, content item and analytics row the
 * operator has produced for it, and the reporting history is the record of work
 * that was actually billed. Archiving keeps that history reachable and out of
 * the way; `DELETE` is the explicit, separate action below.
 */
restaurantsRouter.post(
  '/:id/archive',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const existing = await prisma.restaurant.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!existing) throw notFound('Restaurant');

    const restaurant = await prisma.restaurant.update({
      where: { id: existing.id },
      data: { status: RestaurantStatus.ARCHIVED },
    });

    await recordAudit({ actor, action: 'restaurant.archive', entity: 'Restaurant', entityId: restaurant.id, ip: req.ip });
    res.json({ restaurant });
  }),
);

restaurantsRouter.delete(
  '/:id',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);

    const existing = await prisma.restaurant.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true },
    });
    if (!existing) throw notFound('Restaurant');

    await prisma.restaurant.delete({ where: { id: existing.id } });
    await recordAudit({
      actor, action: 'restaurant.delete', entity: 'Restaurant', entityId: existing.id,
      meta: { name: existing.name }, ip: req.ip,
    });
    res.json({ ok: true });
  }),
);

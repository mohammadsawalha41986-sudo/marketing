/** /api/campaigns — campaign CRUD, platform mix, and per-campaign analytics. */

import { Router } from 'express';
import { CampaignObjective, CampaignStatus, NotificationType, Platform, Prisma } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest, notFound } from '../lib/errors.js';
import { actorOf, requireAgency, requireAuth } from '../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { dateRangeQuery, decimalToNumber, idParam, pageResult, paginate, paginationQuery, resolveRange } from '../lib/http.js';
import { assertWritable, orgId, resolveClientId, scopeWhere } from '../lib/scope.js';
import { byDay, byPlatform, derive, previousWindow, sumSnapshots } from '../services/analytics.js';
import { recordAudit } from '../services/audit.js';
import { notify } from '../services/notify.js';

export const campaignsRouter: Router = Router();
campaignsRouter.use(requireAuth);

const campaignSchema = z
  .object({
    clientId: z.string().min(1).max(40),
    name: z.string().trim().min(2).max(200),
    objective: z.nativeEnum(CampaignObjective).default(CampaignObjective.AWARENESS),
    status: z.nativeEnum(CampaignStatus).default(CampaignStatus.DRAFT),
    budget: z.coerce.number().nonnegative().max(1_000_000_000),
    currency: z.string().trim().length(3).default('USD'),
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
    targetAudience: z.string().trim().max(2000).nullish(),
    locations: z.array(z.string().trim().min(1).max(120)).max(40).default([]),
    kpi: z.string().trim().max(300).nullish(),
    notes: z.string().trim().max(4000).nullish(),
    platforms: z
      .array(z.object({ platform: z.nativeEnum(Platform), budget: z.coerce.number().nonnegative().default(0) }))
      .min(1, 'Pick at least one platform')
      .max(8),
  })
  .refine((value) => value.endDate >= value.startDate, {
    message: 'End date must fall on or after the start date',
    path: ['endDate'],
  });

const serialise = <T extends { budget: unknown; spend: unknown }>(campaign: T) =>
  decimalToNumber(campaign as never, ['budget', 'spend']);

campaignsRouter.get(
  '/',
  validateQuery(
    paginationQuery.extend({
      clientId: z.string().max(40).optional(),
      status: z.nativeEnum(CampaignStatus).optional(),
      platform: z.nativeEnum(Platform).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const query = req.query as unknown as z.infer<typeof paginationQuery> & {
      clientId?: string; status?: CampaignStatus; platform?: Platform;
    };
    const clientId = resolveClientId(actor, query.clientId);

    const where: Prisma.CampaignWhereInput = {
      organizationId: orgId(actor),
      ...(clientId ? { clientId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.platform ? { platforms: { some: { platform: query.platform } } } : {}),
      ...(query.search ? { name: { contains: query.search, mode: 'insensitive' } } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.campaign.findMany({
        where,
        ...paginate(query),
        orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
        include: {
          client: { select: { id: true, name: true, businessName: true, logoUrl: true } },
          platforms: true,
          _count: { select: { contents: true } },
        },
      }),
      prisma.campaign.count({ where }),
    ]);

    res.json(pageResult(items.map(serialise), total, query));
  }),
);

campaignsRouter.post(
  '/',
  requireAgency,
  validateBody(campaignSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);
    const body = req.body as z.infer<typeof campaignSchema>;

    const client = await prisma.client.findFirst({
      where: { id: body.clientId, organizationId: orgId(actor) },
      select: { id: true, name: true },
    });
    if (!client) throw notFound('Client');

    const { platforms, ...data } = body;
    const campaign = await prisma.campaign.create({
      data: {
        ...data,
        organizationId: orgId(actor),
        budget: new Prisma.Decimal(data.budget),
        platforms: { create: platforms.map((p) => ({ platform: p.platform, budget: new Prisma.Decimal(p.budget) })) },
      },
      include: { platforms: true, client: { select: { id: true, name: true } } },
    });

    await notify({
      organizationId: orgId(actor),
      clientId: client.id,
      type: NotificationType.CAMPAIGN_CREATED,
      title: `New campaign: ${campaign.name}`,
      body: `Created for ${client.name}.`,
      link: `/app/campaigns/${campaign.id}`,
      audience: 'both',
    });
    await recordAudit({ actor, action: 'campaign.create', entity: 'Campaign', entityId: campaign.id, ip: req.ip });

    res.status(201).json({ campaign: serialise(campaign) });
  }),
);

campaignsRouter.get(
  '/:id',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, ...scopeWhere(actor) },
      include: {
        client: { select: { id: true, name: true, businessName: true, logoUrl: true } },
        platforms: true,
        contents: {
          orderBy: { scheduledAt: 'asc' },
          select: {
            id: true, name: true, status: true, platform: true, type: true,
            scheduledAt: true, headline: true, updatedAt: true,
          },
        },
        _count: { select: { contents: true, media: true } },
      },
    });
    if (!campaign) throw notFound('Campaign');
    res.json({ campaign: serialise(campaign) });
  }),
);

campaignsRouter.get(
  '/:id/analytics',
  validateParams(idParam),
  validateQuery(dateRangeQuery),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, ...scopeWhere(actor) },
      select: { id: true, budget: true, startDate: true, endDate: true },
    });
    if (!campaign) throw notFound('Campaign');

    const range = resolveRange(req.query as { from?: Date; to?: Date });
    const prior = previousWindow(range.from, range.to);

    const select = {
      platform: true, date: true, spend: true, reach: true, impressions: true,
      clicks: true, conversions: true, revenue: true, engagements: true,
    } as const;

    const [current, previous] = await Promise.all([
      prisma.analyticsSnapshot.findMany({
        where: { campaignId: campaign.id, date: { gte: range.from, lte: range.to } },
        select,
        orderBy: { date: 'asc' },
      }),
      prisma.analyticsSnapshot.findMany({
        where: { campaignId: campaign.id, date: { gte: prior.from, lte: prior.to } },
        select,
      }),
    ]);

    const budget = Number(campaign.budget.toString());
    const totals = derive(sumSnapshots(current));

    res.json({
      range: { from: range.from.toISOString().slice(0, 10), to: range.to.toISOString().slice(0, 10) },
      totals,
      previous: derive(sumSnapshots(previous)),
      series: byDay(current, range.from, range.to),
      platforms: byPlatform(current),
      budget: { total: budget, spent: totals.spend, remaining: Math.max(budget - totals.spend, 0) },
    });
  }),
);

campaignsRouter.patch(
  '/:id',
  requireAgency,
  validateParams(idParam),
  validateBody(campaignSchema.innerType().partial()),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);

    const existing = await prisma.campaign.findFirst({
      where: { id: req.params.id, ...scopeWhere(actor) },
      select: { id: true, startDate: true, endDate: true },
    });
    if (!existing) throw notFound('Campaign');

    const body = req.body as Partial<z.infer<typeof campaignSchema>>;
    const start = body.startDate ?? existing.startDate;
    const end = body.endDate ?? existing.endDate;
    if (end < start) throw badRequest('End date must fall on or after the start date');

    const { platforms, clientId: _ignored, budget, ...rest } = body;

    const campaign = await prisma.campaign.update({
      where: { id: existing.id },
      data: {
        ...rest,
        ...(budget === undefined ? {} : { budget: new Prisma.Decimal(budget) }),
        ...(platforms
          ? {
              platforms: {
                deleteMany: {},
                create: platforms.map((p) => ({ platform: p.platform, budget: new Prisma.Decimal(p.budget) })),
              },
            }
          : {}),
      },
      include: { platforms: true, client: { select: { id: true, name: true } } },
    });

    await recordAudit({ actor, action: 'campaign.update', entity: 'Campaign', entityId: campaign.id, ip: req.ip });
    res.json({ campaign: serialise(campaign) });
  }),
);

campaignsRouter.delete(
  '/:id',
  requireAgency,
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);

    const existing = await prisma.campaign.findFirst({
      where: { id: req.params.id, ...scopeWhere(actor) },
      select: { id: true, name: true },
    });
    if (!existing) throw notFound('Campaign');

    await prisma.campaign.delete({ where: { id: existing.id } });
    await recordAudit({
      actor, action: 'campaign.delete', entity: 'Campaign', entityId: existing.id,
      meta: { name: existing.name }, ip: req.ip,
    });
    res.json({ ok: true });
  }),
);

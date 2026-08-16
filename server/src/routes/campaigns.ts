/** /api/campaigns — campaign CRUD, platform mix, and per-campaign analytics. */

import { Router } from 'express';
import {
  CampaignObjective,
  CampaignStatus,
  CostCategory,
  CostKind,
  Language,
  NotificationType,
  Platform,
  Prisma,
} from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest, notFound } from '../lib/errors.js';
import { actorOf, requireAgency, requireAuth } from '../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { dateRangeQuery, decimalToNumber, idParam, pageResult, paginate, paginationQuery, resolveRange } from '../lib/http.js';
import { assertWritable, orgId, resolveClientId, scopeWhere } from '../lib/scope.js';
import { byDay, byPlatform, derive, previousWindow, sumSnapshots } from '../services/analytics.js';
import { loadRollup } from '../services/campaign-rollup.js';
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

    secondaryObjective: z.nativeEnum(CampaignObjective).nullish(),
    strategy: z.string().trim().max(4000).nullish(),
    description: z.string().trim().max(4000).nullish(),
    language: z.nativeEnum(Language).nullish(),
    offer: z.string().trim().max(500).nullish(),
    products: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
    landingPageUrl: z.string().trim().url().max(2000).nullish(),
    ctaLabel: z.string().trim().max(120).nullish(),

    // Targets and financial actuals are nullable throughout: null means "not
    // set", which the finance engine reports as NO_DATA rather than as zero.
    targetCpa: z.coerce.number().nonnegative().max(1_000_000).nullish(),
    targetRoas: z.coerce.number().nonnegative().max(1000).nullish(),
    targetRevenue: z.coerce.number().nonnegative().max(1_000_000_000).nullish(),
    targetConversions: z.coerce.number().int().nonnegative().max(100_000_000).nullish(),
    grossRevenue: z.coerce.number().nonnegative().max(1_000_000_000).nullish(),
    discounts: z.coerce.number().nonnegative().max(1_000_000_000).nullish(),
    cogs: z.coerce.number().nonnegative().max(1_000_000_000).nullish(),
    platforms: z
      .array(z.object({ platform: z.nativeEnum(Platform), budget: z.coerce.number().nonnegative().default(0) }))
      .min(1, 'Pick at least one platform')
      .max(8),
  })
  .refine((value) => value.endDate >= value.startDate, {
    message: 'End date must fall on or after the start date',
    path: ['endDate'],
  });

/** Decimal-backed money columns, converted on the way in and out. */
const MONEY_FIELDS = [
  'budget',
  'spend',
  'targetCpa',
  'targetRoas',
  'targetRevenue',
  'grossRevenue',
  'discounts',
  'cogs',
] as const;

const serialise = <T extends { budget: unknown; spend: unknown }>(campaign: T) =>
  decimalToNumber(campaign as never, MONEY_FIELDS as unknown as (keyof T)[]);

/**
 * Turn the numeric money fields present in `body` into Decimals.
 *
 * `undefined` and `null` are kept apart deliberately: undefined means the
 * caller did not mention the field and it must not be written, null means they
 * explicitly cleared it back to "not recorded".
 */
function moneyData(body: Record<string, unknown>): Record<string, Prisma.Decimal | null> {
  const output: Record<string, Prisma.Decimal | null> = {};
  for (const field of MONEY_FIELDS) {
    if (field === 'spend') continue; // maintained from snapshots, never set by the client
    const value = body[field];
    if (value === undefined) continue;
    output[field] = value === null ? null : new Prisma.Decimal(value as number);
  }
  return output;
}

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
        ...moneyData(data),
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

/**
 * The full financial picture: costs, revenue, profit, ratios, budget health,
 * performance against target, a health score and a recommendation.
 *
 * Figures that cannot be derived come back as `{ available: false, reason }`
 * rather than as zero, so the UI can say what is missing instead of showing a
 * confident nought.
 */
campaignsRouter.get(
  '/:id/finance',
  validateParams(idParam),
  validateQuery(dateRangeQuery),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const range = resolveRange(req.query as { from?: Date; to?: Date });

    const rollup = await loadRollup({ id: req.params.id, ...scopeWhere(actor) }, { range });
    if (!rollup) throw notFound('Campaign');

    res.json({
      range: { from: range.from.toISOString().slice(0, 10), to: range.to.toISOString().slice(0, 10) },
      campaign: { id: rollup.id, name: rollup.name, status: rollup.status, clientId: rollup.clientId, clientName: rollup.clientName },
      finance: rollup.finance,
      health: rollup.health,
      recommendation: rollup.recommendation,
    });
  }),
);

// ---------------------------------------------------------------- cost lines

const costSchema = z.object({
  kind: z.nativeEnum(CostKind),
  category: z.nativeEnum(CostCategory),
  amount: z.coerce.number().nonnegative().max(1_000_000_000),
  currency: z.string().trim().length(3).default('USD'),
  description: z.string().trim().max(500).nullish(),
  incurredOn: z.coerce.date().nullish(),
});

const serialiseCost = <T extends { amount: unknown }>(cost: T) => decimalToNumber(cost as never, ['amount']);

campaignsRouter.get(
  '/:id/costs',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, ...scopeWhere(actor) },
      select: { id: true },
    });
    if (!campaign) throw notFound('Campaign');

    const costs = await prisma.campaignCost.findMany({
      where: { campaignId: campaign.id },
      orderBy: [{ kind: 'asc' }, { category: 'asc' }, { createdAt: 'asc' }],
    });
    res.json({ costs: costs.map(serialiseCost) });
  }),
);

campaignsRouter.post(
  '/:id/costs',
  requireAgency,
  validateParams(idParam),
  validateBody(costSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);

    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, ...scopeWhere(actor) },
      select: { id: true },
    });
    if (!campaign) throw notFound('Campaign');

    const body = req.body as z.infer<typeof costSchema>;
    const cost = await prisma.campaignCost.create({
      data: {
        ...body,
        amount: new Prisma.Decimal(body.amount),
        campaignId: campaign.id,
        organizationId: orgId(actor),
      },
    });

    await recordAudit({ actor, action: 'campaign.cost.create', entity: 'CampaignCost', entityId: cost.id, ip: req.ip });
    res.status(201).json({ cost: serialiseCost(cost) });
  }),
);

campaignsRouter.delete(
  '/:id/costs/:costId',
  requireAgency,
  validateParams(idParam.extend({ costId: z.string().min(1).max(40) })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);

    // Scoped through the campaign, so a cost id from another tenant is a miss.
    const cost = await prisma.campaignCost.findFirst({
      where: {
        id: (req.params as { costId: string }).costId,
        campaign: { id: req.params.id, ...scopeWhere(actor) },
      },
      select: { id: true },
    });
    if (!cost) throw notFound('Cost line');

    await prisma.campaignCost.delete({ where: { id: cost.id } });
    await recordAudit({ actor, action: 'campaign.cost.delete', entity: 'CampaignCost', entityId: cost.id, ip: req.ip });
    res.json({ ok: true });
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

    const { platforms, clientId: _ignored, ...rest } = body;

    const campaign = await prisma.campaign.update({
      where: { id: existing.id },
      data: {
        ...rest,
        ...moneyData(body),
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

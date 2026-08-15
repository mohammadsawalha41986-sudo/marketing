/**
 * /api/ads — individual ads inside a campaign, and their measured performance.
 *
 * Figures are entered by the operator from the ad platform's own reporting.
 * There is no automatic fetch: the ad-platform adapters are architecture only
 * and every one of them returns 501 (see services/integrations). Rather than
 * invent an integration, this endpoint makes manual entry a first-class
 * workflow and is honest about where the numbers came from — `metricsAt` is
 * null until the operator has recorded something, which is what lets the UI say
 * "not recorded" instead of showing a misleading zero.
 */

import { Router } from 'express';
import { AdStatus, CampaignObjective, Platform, Prisma } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest, notFound } from '../lib/errors.js';
import { actorOf, requireAuth } from '../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { idParam, pageResult, paginate, paginationQuery } from '../lib/http.js';
import { deriveAd, type AdMetricSource } from '../services/analytics.js';
import { recordAudit } from '../services/audit.js';

export const adsRouter: Router = Router();
adsRouter.use(requireAuth);

const createSchema = z
  .object({
    campaignId: z.string().min(1).max(40),
    name: z.string().trim().min(2).max(200),
    platform: z.nativeEnum(Platform),
    objective: z.nativeEnum(CampaignObjective).default(CampaignObjective.AWARENESS),
    status: z.nativeEnum(AdStatus).default(AdStatus.DRAFT),
    headline: z.string().trim().max(300).nullish(),
    primaryText: z.string().trim().max(6000).nullish(),
    cta: z.string().trim().max(200).nullish(),
    audience: z.string().trim().max(2000).nullish(),
    creativeId: z.string().max(40).nullish(),
    budget: z.coerce.number().nonnegative().max(1_000_000_000).default(0),
    startDate: z.coerce.date().nullish(),
    endDate: z.coerce.date().nullish(),
    notes: z.string().trim().max(4000).nullish(),
  })
  .refine((value) => !value.startDate || !value.endDate || value.endDate >= value.startDate, {
    message: 'End date must fall on or after the start date',
    path: ['endDate'],
  });

/** Everything the operator copies across from the ad platform's reporting. */
const metricsSchema = z.object({
  spend: z.coerce.number().nonnegative().max(1_000_000_000),
  impressions: z.coerce.number().int().nonnegative().max(2_000_000_000),
  reach: z.coerce.number().int().nonnegative().max(2_000_000_000),
  clicks: z.coerce.number().int().nonnegative().max(2_000_000_000),
  leads: z.coerce.number().int().nonnegative().max(2_000_000_000).default(0),
  conversions: z.coerce.number().int().nonnegative().max(2_000_000_000).default(0),
  revenue: z.coerce.number().nonnegative().max(1_000_000_000).default(0),
});

const adInclude = {
  restaurant: { select: { id: true, name: true, logoUrl: true } },
  campaign: { select: { id: true, name: true, currency: true } },
  creative: { select: { id: true, url: true, thumbnailUrl: true, type: true } },
} satisfies Prisma.AdInclude;

type AdRow = AdMetricSource & { budget: Prisma.Decimal; metricsAt: Date | null };

/**
 * Money columns become numbers and the ratios are attached.
 *
 * CTR, CPC, CPM and ROAS are computed here on every read rather than stored,
 * so they cannot drift out of step with the figures they are derived from.
 */
const present = <T extends AdRow>(ad: T) => ({
  ...ad,
  budget: Number(ad.budget.toString()),
  spend: Number(ad.spend.toString()),
  revenue: Number(ad.revenue.toString()),
  metrics: deriveAd(ad),
  metricsRecorded: ad.metricsAt !== null,
});

adsRouter.get(
  '/',
  validateQuery(
    paginationQuery.extend({
      restaurantId: z.string().max(40).optional(),
      campaignId: z.string().max(40).optional(),
      status: z.nativeEnum(AdStatus).optional(),
      platform: z.nativeEnum(Platform).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof paginationQuery> & {
      restaurantId?: string; campaignId?: string; status?: AdStatus; platform?: Platform;
    };

    const where: Prisma.AdWhereInput = {
      ...(query.restaurantId ? { restaurantId: query.restaurantId } : {}),
      ...(query.campaignId ? { campaignId: query.campaignId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.platform ? { platform: query.platform } : {}),
      ...(query.search ? { name: { contains: query.search, mode: 'insensitive' } } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.ad.findMany({ where, ...paginate(query), orderBy: { updatedAt: 'desc' }, include: adInclude }),
      prisma.ad.count({ where }),
    ]);

    res.json(pageResult(items.map(present), total, query));
  }),
);

adsRouter.post(
  '/',
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const body = req.body as z.infer<typeof createSchema>;

    /*
     * The restaurant is taken from the campaign rather than accepted from the
     * caller. It is the one thing that guarantees an ad can never be filed
     * under a different restaurant than the campaign it runs in.
     */
    const campaign = await prisma.campaign.findUnique({
      where: { id: body.campaignId },
      select: { id: true, restaurantId: true },
    });
    if (!campaign) throw notFound('Campaign');

    if (body.creativeId) {
      const creative = await prisma.media.findUnique({ where: { id: body.creativeId }, select: { id: true } });
      if (!creative) throw notFound('Creative');
    }

    const { budget, ...data } = body;
    const ad = await prisma.ad.create({
      data: { ...data, restaurantId: campaign.restaurantId, budget: new Prisma.Decimal(budget) },
      include: adInclude,
    });

    await recordAudit({ actor, action: 'ad.create', entity: 'Ad', entityId: ad.id, ip: req.ip });
    res.status(201).json({ ad: present(ad) });
  }),
);

adsRouter.get(
  '/:id',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const ad = await prisma.ad.findUnique({ where: { id: req.params.id }, include: adInclude });
    if (!ad) throw notFound('Ad');
    res.json({ ad: present(ad) });
  }),
);

adsRouter.patch(
  '/:id',
  validateParams(idParam),
  validateBody(createSchema.innerType().partial()),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);

    const existing = await prisma.ad.findUnique({
      where: { id: req.params.id },
      select: { id: true, restaurantId: true, startDate: true, endDate: true },
    });
    if (!existing) throw notFound('Ad');

    const body = req.body as Partial<z.infer<typeof createSchema>>;
    const start = body.startDate ?? existing.startDate;
    const end = body.endDate ?? existing.endDate;
    if (start && end && end < start) throw badRequest('End date must fall on or after the start date');

    // Moving an ad between campaigns is allowed, but only within the same
    // restaurant — otherwise its recorded spend would land on someone else's
    // reporting.
    if (body.campaignId) {
      const campaign = await prisma.campaign.findFirst({
        where: { id: body.campaignId, restaurantId: existing.restaurantId },
        select: { id: true },
      });
      if (!campaign) throw notFound('Campaign');
    }

    const { budget, ...rest } = body;
    const ad = await prisma.ad.update({
      where: { id: existing.id },
      data: { ...rest, ...(budget === undefined ? {} : { budget: new Prisma.Decimal(budget) }) },
      include: adInclude,
    });

    await recordAudit({ actor, action: 'ad.update', entity: 'Ad', entityId: ad.id, ip: req.ip });
    res.json({ ad: present(ad) });
  }),
);

/**
 * Record the figures for an ad.
 *
 * A separate endpoint from the general update because it is a separate job:
 * editing an ad's copy is authoring, entering its numbers is reporting.
 * Stamping `metricsAt` is what distinguishes "measured zero" from "never
 * entered", and both the dashboard alert and the report renderer read it.
 */
adsRouter.post(
  '/:id/metrics',
  validateParams(idParam),
  validateBody(metricsSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const body = req.body as z.infer<typeof metricsSchema>;

    const existing = await prisma.ad.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!existing) throw notFound('Ad');

    const ad = await prisma.ad.update({
      where: { id: existing.id },
      data: {
        spend: new Prisma.Decimal(body.spend),
        revenue: new Prisma.Decimal(body.revenue),
        impressions: body.impressions,
        reach: body.reach,
        clicks: body.clicks,
        leads: body.leads,
        conversions: body.conversions,
        metricsAt: new Date(),
      },
      include: adInclude,
    });

    await recordAudit({ actor, action: 'ad.metrics', entity: 'Ad', entityId: ad.id, ip: req.ip });
    res.json({ ad: present(ad) });
  }),
);

adsRouter.delete(
  '/:id',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);

    const existing = await prisma.ad.findUnique({ where: { id: req.params.id }, select: { id: true, name: true } });
    if (!existing) throw notFound('Ad');

    await prisma.ad.delete({ where: { id: existing.id } });
    await recordAudit({
      actor, action: 'ad.delete', entity: 'Ad', entityId: existing.id,
      meta: { name: existing.name }, ip: req.ip,
    });
    res.json({ ok: true });
  }),
);

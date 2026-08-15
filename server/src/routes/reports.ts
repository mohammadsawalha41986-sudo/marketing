/** /api/reports — generate, list, read and export restaurant reports. */

import { Router } from 'express';
import { AdStatus, NotificationType, Prisma, ReportType } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { asyncHandler, notFound } from '../lib/errors.js';
import { actorOf, requireAuth } from '../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { idParam, pageResult, paginate, paginationQuery, resolveRange } from '../lib/http.js';
import { byDay, byPlatform, derive, previousWindow, sumSnapshots, changeRatio } from '../services/analytics.js';
import { analyzeCampaigns, buildFacts } from '../services/ai/index.js';
import { recordAiUsage, recordAudit } from '../services/audit.js';
import { notify } from '../services/notify.js';
import { renderReportHtml, renderReportMarkdown } from '../services/report.js';
import { readWorkspace } from '../lib/workspace.js';

export const reportsRouter: Router = Router();
reportsRouter.use(requireAuth);

const snapshotSelect = {
  platform: true, date: true, spend: true, reach: true, impressions: true,
  clicks: true, leads: true, conversions: true, revenue: true, engagements: true,
} as const;

reportsRouter.get(
  '/',
  validateQuery(paginationQuery.extend({ restaurantId: z.string().max(40).optional(), type: z.nativeEnum(ReportType).optional() })),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof paginationQuery> & { restaurantId?: string; type?: ReportType };

    const where: Prisma.ReportWhereInput = {
      ...(query.restaurantId ? { restaurantId: query.restaurantId } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.search ? { title: { contains: query.search, mode: 'insensitive' } } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.report.findMany({
        where,
        ...paginate(query),
        orderBy: { createdAt: 'desc' },
        include: {
          restaurant: { select: { id: true, name: true, logoUrl: true } },
          campaign: { select: { id: true, name: true } },
        },
      }),
      prisma.report.count({ where }),
    ]);

    res.json(pageResult(items, total, query));
  }),
);

const generateSchema = z.object({
  restaurantId: z.string().min(1).max(40),
  campaignId: z.string().max(40).nullish(),
  type: z.nativeEnum(ReportType).default(ReportType.RESTAURANT),
  title: z.string().trim().min(2).max(200).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  includeAi: z.boolean().default(true),
});

/**
 * Build a report. Figures are frozen into `payload` at generation time so a
 * report reads the same next quarter as it did the day it was produced.
 */
reportsRouter.post(
  '/generate',
  validateBody(generateSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const body = req.body as z.infer<typeof generateSchema>;

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: body.restaurantId },
      select: { id: true, name: true, businessName: true, logoUrl: true },
    });
    if (!restaurant) throw notFound('Restaurant');

    const range = resolveRange(body);
    const prior = previousWindow(range.from, range.to);
    const where: Prisma.AnalyticsSnapshotWhereInput = {
      restaurantId: restaurant.id,
      ...(body.campaignId ? { campaignId: body.campaignId } : {}),
    };

    const [current, previous, campaigns, ads, topContent, workspace] = await Promise.all([
      prisma.analyticsSnapshot.findMany({ where: { ...where, date: { gte: range.from, lte: range.to } }, select: snapshotSelect, orderBy: { date: 'asc' } }),
      prisma.analyticsSnapshot.findMany({ where: { ...where, date: { gte: prior.from, lte: prior.to } }, select: snapshotSelect }),
      prisma.campaign.findMany({
        where: { restaurantId: restaurant.id, ...(body.campaignId ? { id: body.campaignId } : {}) },
        select: { id: true, name: true, status: true, budget: true, spend: true, startDate: true, endDate: true, objective: true },
      }),
      prisma.ad.findMany({
        where: {
          restaurantId: restaurant.id,
          ...(body.campaignId ? { campaignId: body.campaignId } : {}),
          status: { in: [AdStatus.ACTIVE, AdStatus.COMPLETED, AdStatus.PAUSED] },
        },
        select: {
          id: true, name: true, platform: true, status: true, budget: true, spend: true,
          impressions: true, reach: true, clicks: true, leads: true, conversions: true,
          revenue: true, metricsAt: true,
        },
        orderBy: { spend: 'desc' },
      }),
      prisma.content.findMany({
        where: { restaurantId: restaurant.id, status: 'PUBLISHED', publishedAt: { gte: range.from, lte: range.to } },
        select: { id: true, name: true, type: true, platform: true, publishedAt: true, headline: true },
        orderBy: { publishedAt: 'desc' },
        take: 10,
      }),
      readWorkspace(),
    ]);

    const totals = derive(sumSnapshots(current));
    const previousTotals = derive(sumSnapshots(previous));
    const budget = campaigns.reduce((sum, campaign) => sum + Number(campaign.budget.toString()), 0);

    let analysis = null;
    let aiMeta: Record<string, unknown> | null = null;

    if (body.includeAi) {
      const lastEnd = campaigns.reduce<Date | null>((latest, c) => (!latest || c.endDate > latest ? c.endDate : latest), null);
      const facts = buildFacts({
        restaurantName: restaurant.name,
        campaignNames: campaigns.map((c) => c.name),
        current,
        previous,
        periodStart: range.from,
        periodEnd: range.to,
        budget,
        daysRemaining: lastEnd ? Math.max(0, Math.ceil((lastEnd.getTime() - Date.now()) / 86400000)) : 0,
      });
      const result = await analyzeCampaigns(facts);
      analysis = result.data;
      aiMeta = { provider: result.provider, model: result.model, isFallback: result.isFallback, notice: result.notice };

      await recordAiUsage({
        restaurantId: restaurant.id,
        kind: 'ANALYSIS', model: result.model, provider: result.provider, latencyMs: result.latencyMs,
      });
    }

    const payload = {
      restaurant: { id: restaurant.id, name: restaurant.name, businessName: restaurant.businessName, logoUrl: restaurant.logoUrl },
      currency: workspace.currency,
      period: { from: range.from.toISOString().slice(0, 10), to: range.to.toISOString().slice(0, 10) },
      totals,
      previous: previousTotals,
      changes: {
        spend: changeRatio(totals.spend, previousTotals.spend),
        reach: changeRatio(totals.reach, previousTotals.reach),
        clicks: changeRatio(totals.clicks, previousTotals.clicks),
        leads: changeRatio(totals.leads, previousTotals.leads),
        conversions: changeRatio(totals.conversions, previousTotals.conversions),
        roas: changeRatio(totals.roas, previousTotals.roas),
      },
      series: byDay(current, range.from, range.to),
      platforms: byPlatform(current),
      campaigns: campaigns.map((campaign) => ({
        ...campaign,
        budget: Number(campaign.budget.toString()),
        spend: Number(campaign.spend.toString()),
      })),
      /*
       * Ad figures are reported in their own section rather than folded into the
       * totals above. They are entered by hand from the ad platforms, while the
       * totals come from AnalyticsSnapshot; adding them together would count the
       * same spend twice. `metricsAt: null` means nothing has been entered yet,
       * which the renderer shows as "not recorded" rather than as zero.
       */
      ads: ads.map((ad) => ({
        ...ad,
        budget: Number(ad.budget.toString()),
        spend: Number(ad.spend.toString()),
        revenue: Number(ad.revenue.toString()),
      })),
      topContent,
      budget: { total: budget, spent: totals.spend },
      analysis,
      aiMeta,
      generatedAt: new Date().toISOString(),
    };

    const report = await prisma.report.create({
      data: {
        restaurantId: restaurant.id,
        campaignId: body.campaignId ?? null,
        type: body.type,
        title: body.title ?? `${restaurant.name} — ${payload.period.from} to ${payload.period.to}`,
        periodStart: range.from,
        periodEnd: range.to,
        payload: payload as unknown as Prisma.InputJsonValue,
      },
      include: { restaurant: { select: { id: true, name: true } } },
    });

    await notify({
      restaurantId: restaurant.id,
      type: NotificationType.REPORT_READY,
      title: `Report ready: ${report.title}`,
      link: `/reports/${report.id}`,
    });
    await recordAudit({ actor, action: 'report.generate', entity: 'Report', entityId: report.id, ip: req.ip });

    res.status(201).json({ report });
  }),
);

reportsRouter.get(
  '/:id',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const report = await prisma.report.findUnique({
      where: { id: req.params.id },
      include: {
        restaurant: { select: { id: true, name: true, logoUrl: true } },
        campaign: { select: { id: true, name: true } },
      },
    });
    if (!report) throw notFound('Report');
    res.json({ report });
  }),
);

/** Export as standalone HTML or Markdown. `?format=html|md` */
reportsRouter.get(
  '/:id/export',
  validateParams(idParam),
  validateQuery(z.object({ format: z.enum(['html', 'md']).default('html') })),
  asyncHandler(async (req, res) => {
    const report = await prisma.report.findUnique({ where: { id: req.params.id } });
    if (!report) throw notFound('Report');

    const format = (req.query as { format: 'html' | 'md' }).format;
    const filename = `${report.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.${format}`;

    if (format === 'md') {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(renderReportMarkdown(report));
      return;
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(renderReportHtml(report));
  }),
);

reportsRouter.delete(
  '/:id',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const existing = await prisma.report.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!existing) throw notFound('Report');

    await prisma.report.delete({ where: { id: existing.id } });
    await recordAudit({ actor, action: 'report.delete', entity: 'Report', entityId: existing.id, ip: req.ip });
    res.json({ ok: true });
  }),
);

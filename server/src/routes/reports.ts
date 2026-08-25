/** /api/reports — generate, list, read and export reports. */

import { Router } from 'express';
import { NotificationType, Platform, Prisma, ReportType } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest, notFound } from '../lib/errors.js';
import { actorOf, requireAgency, requireAuth } from '../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { idParam, pageResult, paginate, paginationQuery, resolveRange } from '../lib/http.js';
import { assertWritable, orgId, resolveClientId } from '../lib/scope.js';
import { byDay, byPlatform, derive, previousWindow, sumSnapshots, changeRatio } from '../services/analytics.js';
import { analyzeCampaigns, buildFacts } from '../services/ai/index.js';
import { recordAiUsage, recordAudit } from '../services/audit.js';
import { notify } from '../services/notify.js';
import { renderReportHtml, renderReportMarkdown } from '../services/report.js';
import {
  DEFAULT_CONFIG, REPORT_METRICS, REPORT_SECTIONS, buildReportData, parseConfig,
  type ReportConfig,
} from '../services/reports/builder.js';

export const reportsRouter: Router = Router();
reportsRouter.use(requireAuth);

const snapshotSelect = {
  platform: true, date: true, spend: true, reach: true, impressions: true,
  clicks: true, conversions: true, revenue: true, engagements: true,
} as const;

reportsRouter.get(
  '/',
  validateQuery(paginationQuery.extend({ clientId: z.string().max(40).optional(), type: z.nativeEnum(ReportType).optional() })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const query = req.query as unknown as z.infer<typeof paginationQuery> & { clientId?: string; type?: ReportType };
    const clientId = resolveClientId(actor, query.clientId);

    const where: Prisma.ReportWhereInput = {
      organizationId: orgId(actor),
      ...(clientId ? { clientId } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.search ? { title: { contains: query.search, mode: 'insensitive' } } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.report.findMany({
        where,
        ...paginate(query),
        orderBy: { createdAt: 'desc' },
        include: {
          client: { select: { id: true, name: true, logoUrl: true } },
          campaign: { select: { id: true, name: true } },
        },
      }),
      prisma.report.count({ where }),
    ]);

    res.json(pageResult(items, total, query));
  }),
);

const generateSchema = z.object({
  clientId: z.string().min(1).max(40),
  campaignId: z.string().max(40).nullish(),
  type: z.nativeEnum(ReportType).default(ReportType.CLIENT),
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
  requireAgency,
  validateBody(generateSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);
    const body = req.body as z.infer<typeof generateSchema>;

    const client = await prisma.client.findFirst({
      where: { id: body.clientId, organizationId: orgId(actor) },
      select: { id: true, name: true, businessName: true, logoUrl: true },
    });
    if (!client) throw notFound('Client');

    const range = resolveRange(body);
    const prior = previousWindow(range.from, range.to);
    const where: Prisma.AnalyticsSnapshotWhereInput = {
      organizationId: orgId(actor),
      clientId: client.id,
      ...(body.campaignId ? { campaignId: body.campaignId } : {}),
    };

    const [current, previous, campaigns] = await Promise.all([
      prisma.analyticsSnapshot.findMany({ where: { ...where, date: { gte: range.from, lte: range.to } }, select: snapshotSelect, orderBy: { date: 'asc' } }),
      prisma.analyticsSnapshot.findMany({ where: { ...where, date: { gte: prior.from, lte: prior.to } }, select: snapshotSelect }),
      prisma.campaign.findMany({
        where: { organizationId: orgId(actor), clientId: client.id, ...(body.campaignId ? { id: body.campaignId } : {}) },
        select: { id: true, name: true, status: true, budget: true, spend: true, startDate: true, endDate: true, objective: true },
      }),
    ]);

    const totals = derive(sumSnapshots(current));
    const previousTotals = derive(sumSnapshots(previous));
    const budget = campaigns.reduce((sum, campaign) => sum + Number(campaign.budget.toString()), 0);

    let analysis = null;
    let aiMeta: Record<string, unknown> | null = null;

    if (body.includeAi) {
      const lastEnd = campaigns.reduce<Date | null>((latest, c) => (!latest || c.endDate > latest ? c.endDate : latest), null);
      const facts = buildFacts({
        clientName: client.name,
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
        organizationId: orgId(actor), clientId: client.id, userId: actor.id,
        kind: 'ANALYSIS', model: result.model, provider: result.provider, latencyMs: result.latencyMs,
      });
    }

    const payload = {
      client: { id: client.id, name: client.name, businessName: client.businessName, logoUrl: client.logoUrl },
      period: { from: range.from.toISOString().slice(0, 10), to: range.to.toISOString().slice(0, 10) },
      totals,
      previous: previousTotals,
      changes: {
        spend: changeRatio(totals.spend, previousTotals.spend),
        reach: changeRatio(totals.reach, previousTotals.reach),
        clicks: changeRatio(totals.clicks, previousTotals.clicks),
        conversions: changeRatio(totals.conversions, previousTotals.conversions),
        // Null when either period had no measurable ROAS: a change from
        // "unavailable" to a number is not a percentage movement.
        roas:
          totals.roas === null || previousTotals.roas === null
            ? null
            : changeRatio(totals.roas, previousTotals.roas),
      },
      series: byDay(current, range.from, range.to),
      platforms: byPlatform(current),
      campaigns: campaigns.map((campaign) => ({
        ...campaign,
        budget: Number(campaign.budget.toString()),
        spend: Number(campaign.spend.toString()),
      })),
      budget: { total: budget, spent: totals.spend },
      analysis,
      aiMeta,
      generatedAt: new Date().toISOString(),
    };

    const report = await prisma.report.create({
      data: {
        organizationId: orgId(actor),
        clientId: client.id,
        campaignId: body.campaignId ?? null,
        type: body.type,
        title: body.title ?? `${client.name} — ${payload.period.from} to ${payload.period.to}`,
        periodStart: range.from,
        periodEnd: range.to,
        payload: payload as unknown as Prisma.InputJsonValue,
      },
      include: { client: { select: { id: true, name: true } } },
    });

    await notify({
      organizationId: orgId(actor),
      clientId: client.id,
      type: NotificationType.REPORT_READY,
      title: `Report ready: ${report.title}`,
      link: `/app/reports/${report.id}`,
      audience: 'both',
    });
    await recordAudit({ actor, action: 'report.generate', entity: 'Report', entityId: report.id, ip: req.ip });

    res.status(201).json({ report });
  }),
);


// ---------------------------------------------------------------- builder
//
// A BUILDER report is a saved *configuration*, not a snapshot. It is stored in
// the same Report table — same organisation scoping, same list, same delete —
// and its payload holds the configuration rather than frozen figures, so
// opening it re-reads Phase 14 and shows current numbers.

const builderConfigSchema = z.object({
  description: z.string().trim().max(2000).nullish(),
  platforms: z.array(z.nativeEnum(Platform)).max(12).optional(),
  metrics: z.array(z.enum(REPORT_METRICS)).max(REPORT_METRICS.length).optional(),
  sections: z.array(z.enum(REPORT_SECTIONS)).max(REPORT_SECTIONS.length).optional(),
});

const builderCreateSchema = builderConfigSchema.extend({
  clientId: z.string().min(1).max(40),
  title: z.string().trim().min(1).max(200),
  periodStart: z.coerce.date(),
  periodEnd: z.coerce.date(),
});

function toConfig(body: z.infer<typeof builderConfigSchema>, base: ReportConfig = DEFAULT_CONFIG): ReportConfig {
  return {
    version: 1,
    description: body.description === undefined ? base.description : (body.description ?? null),
    platforms: body.platforms ?? base.platforms,
    metrics: body.metrics ?? base.metrics,
    sections: body.sections ?? base.sections,
  };
}

/** The one place a builder report is looked up, so scoping cannot drift. */
async function findBuilder(actor: ReturnType<typeof actorOf>, id: string) {
  const clientId = resolveClientId(actor, undefined);
  const report = await prisma.report.findFirst({
    where: {
      id,
      type: ReportType.BUILDER,
      // Organisation isolation is the same predicate every other report route
      // uses; a portal user is additionally pinned to their own client.
      organizationId: orgId(actor),
      ...(clientId ? { clientId } : {}),
    },
    include: { client: { select: { id: true, name: true, businessName: true, logoUrl: true } } },
  });
  if (!report) throw notFound('Report');
  return report;
}

reportsRouter.post(
  '/builder',
  requireAgency,
  validateBody(builderCreateSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);
    const body = req.body as z.infer<typeof builderCreateSchema>;

    if (body.periodEnd < body.periodStart) {
      throw badRequest('The report period ends before it starts.');
    }

    // The client must belong to this organisation. Trusting the body here is
    // how a report gets built over another tenant's data.
    const client = await prisma.client.findFirst({
      where: { id: body.clientId, organizationId: orgId(actor) },
      select: { id: true },
    });
    if (!client) throw notFound('Client');

    const report = await prisma.report.create({
      data: {
        organizationId: orgId(actor),
        clientId: client.id,
        type: ReportType.BUILDER,
        title: body.title,
        periodStart: body.periodStart,
        periodEnd: body.periodEnd,
        payload: { builder: toConfig(body) } as unknown as Prisma.InputJsonValue,
      },
      include: { client: { select: { id: true, name: true, businessName: true, logoUrl: true } } },
    });

    await recordAudit({ actor, action: 'report.builder.create', entity: 'Report', entityId: report.id, ip: req.ip });
    res.status(201).json({ report });
  }),
);

reportsRouter.patch(
  '/builder/:id',
  requireAgency,
  validateParams(idParam),
  validateBody(builderCreateSchema.partial().omit({ clientId: true })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);
    const existing = await findBuilder(actor, (req.params as { id: string }).id);
    const body = req.body as Partial<z.infer<typeof builderCreateSchema>>;

    const periodStart = body.periodStart ?? existing.periodStart;
    const periodEnd = body.periodEnd ?? existing.periodEnd;
    if (periodEnd < periodStart) throw badRequest('The report period ends before it starts.');

    const report = await prisma.report.update({
      where: { id: existing.id },
      data: {
        ...(body.title ? { title: body.title } : {}),
        periodStart,
        periodEnd,
        payload: { builder: toConfig(body, parseConfig(existing.payload)) } as unknown as Prisma.InputJsonValue,
      },
      include: { client: { select: { id: true, name: true, businessName: true, logoUrl: true } } },
    });

    await recordAudit({ actor, action: 'report.builder.update', entity: 'Report', entityId: report.id, ip: req.ip });
    res.json({ report });
  }),
);

reportsRouter.post(
  '/builder/:id/duplicate',
  requireAgency,
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);
    const existing = await findBuilder(actor, (req.params as { id: string }).id);

    const report = await prisma.report.create({
      data: {
        organizationId: existing.organizationId,
        clientId: existing.clientId,
        type: ReportType.BUILDER,
        title: `${existing.title} (copy)`.slice(0, 200),
        periodStart: existing.periodStart,
        periodEnd: existing.periodEnd,
        payload: { builder: parseConfig(existing.payload) } as unknown as Prisma.InputJsonValue,
      },
      include: { client: { select: { id: true, name: true, businessName: true, logoUrl: true } } },
    });

    await recordAudit({ actor, action: 'report.builder.duplicate', entity: 'Report', entityId: report.id, ip: req.ip });
    res.status(201).json({ report });
  }),
);

/**
 * The rendered report, computed from Phase 14 at read time.
 *
 * Separate from GET /:id, which returns the saved row: the configuration and
 * the figures have different lifetimes, and a preview that re-fetched the whole
 * row on every slider change would be re-reading a configuration it already has.
 */
reportsRouter.get(
  '/builder/:id/data',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const report = await findBuilder(actor, (req.params as { id: string }).id);

    const data = await buildReportData({
      organizationId: report.organizationId,
      clientId: report.clientId,
      from: report.periodStart,
      to: report.periodEnd,
      config: parseConfig(report.payload),
    });

    res.json({ report, config: parseConfig(report.payload), data });
  }),
);

/**
 * A preview of a configuration that has not been saved yet.
 *
 * This is what makes the builder feel live: the operator changes a platform or
 * a date and sees the real numbers, without a save and without exporting a PDF
 * to find out what the report says.
 */
reportsRouter.post(
  '/builder/preview',
  requireAgency,
  validateBody(builderCreateSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const body = req.body as z.infer<typeof builderCreateSchema>;

    if (body.periodEnd < body.periodStart) {
      throw badRequest('The report period ends before it starts.');
    }

    const client = await prisma.client.findFirst({
      where: { id: body.clientId, organizationId: orgId(actor) },
      select: { id: true, name: true, businessName: true, logoUrl: true },
    });
    if (!client) throw notFound('Client');

    const data = await buildReportData({
      organizationId: orgId(actor),
      clientId: client.id,
      from: body.periodStart,
      to: body.periodEnd,
      config: toConfig(body),
    });

    res.json({ client, config: toConfig(body), data });
  }),
);

reportsRouter.get(
  '/:id',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const clientId = resolveClientId(actor, undefined);
    const report = await prisma.report.findFirst({
      where: { id: req.params.id, organizationId: orgId(actor), ...(clientId ? { clientId } : {}) },
      include: { client: { select: { id: true, name: true, logoUrl: true } }, campaign: { select: { id: true, name: true } } },
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
    const actor = actorOf(req);
    const clientId = resolveClientId(actor, undefined);
    const report = await prisma.report.findFirst({
      where: { id: req.params.id, organizationId: orgId(actor), ...(clientId ? { clientId } : {}) },
    });
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
  requireAgency,
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);
    const existing = await prisma.report.findFirst({
      where: { id: req.params.id, organizationId: orgId(actor) },
      select: { id: true },
    });
    if (!existing) throw notFound('Report');

    await prisma.report.delete({ where: { id: existing.id } });
    res.json({ ok: true });
  }),
);

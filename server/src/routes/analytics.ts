/** /api/analytics — dashboard rollups, series, and the AI marketing analyst. */

import { Router } from 'express';
import { ApprovalStatus, CampaignStatus, ContentStatus, Prisma } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { creativePerformance, DEFAULT_THRESHOLDS } from '../services/analytics/creative-performance.js';
import { creativeFileUrl } from '../services/storage/objects.js';
import { asyncHandler, notFound } from '../lib/errors.js';
import { actorOf, requireAuth } from '../middleware/auth.js';
import { validateQuery } from '../middleware/validate.js';
import { dateRangeQuery, resolveRange } from '../lib/http.js';
import { orgId, resolveClientId, scopeWhere } from '../lib/scope.js';
import { byDay, byPlatform, derive, previousWindow, sumSnapshots } from '../services/analytics.js';
import { analyzeCampaigns, buildFacts } from '../services/ai/index.js';
import { recordAiUsage } from '../services/audit.js';

export const analyticsRouter: Router = Router();
analyticsRouter.use(requireAuth);

const snapshotSelect = {
  platform: true, date: true, spend: true, reach: true, impressions: true,
  clicks: true, conversions: true, revenue: true, engagements: true,
} as const;

const scopedQuery = dateRangeQuery.extend({ clientId: z.string().max(40).optional() });


/**
 * Which creative is working.
 *
 * Summed per creative across every campaign it ran in, judged against this
 * account's own averages rather than an industry number nobody can source, and
 * never declared a winner without enough evidence to be one.
 */
analyticsRouter.get(
  '/creatives',
  validateQuery(
    scopedQuery.extend({
      minImpressions: z.coerce.number().int().min(0).max(1_000_000).optional(),
      minClicks: z.coerce.number().int().min(0).max(100_000).optional(),
      minSpend: z.coerce.number().min(0).max(1_000_000).optional(),
      minConversions: z.coerce.number().int().min(0).max(10_000).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const query = req.query as unknown as z.infer<typeof scopedQuery> & Record<string, number | undefined>;
    const range = resolveRange(query);
    const clientId = resolveClientId(actor, query.clientId);

    const result = await creativePerformance({
      prisma,
      organizationId: orgId(actor),
      clientId: clientId ?? undefined,
      from: range.from,
      to: range.to,
      // Thresholds are the caller's to set: what counts as enough evidence
      // differs between an operator spending 50 a day and one spending 5,000.
      thresholds: {
        minImpressions: query.minImpressions ?? DEFAULT_THRESHOLDS.minImpressions,
        minClicks: query.minClicks ?? DEFAULT_THRESHOLDS.minClicks,
        minSpend: query.minSpend ?? DEFAULT_THRESHOLDS.minSpend,
        minConversions: query.minConversions ?? DEFAULT_THRESHOLDS.minConversions,
      },
    });

    // Attach what the operator needs to recognise the creative: the picture,
    // its shape, and which campaigns it ran in.
    const creatives = await prisma.creative.findMany({
      where: { id: { in: result.rows.map((row) => row.creativeId) }, ...scopeWhere(actor) },
      select: {
        id: true, source: true, preset: true, platform: true, width: true, height: true,
        headline: true, status: true, createdAt: true,
      },
    });
    const byId = new Map(creatives.map((creative) => [creative.id, creative]));

    const campaigns = await prisma.campaign.findMany({
      where: { id: { in: [...new Set(result.rows.flatMap((row) => row.campaignIds))] }, ...scopeWhere(actor) },
      select: { id: true, name: true },
    });
    const campaignNames = new Map(campaigns.map((campaign) => [campaign.id, campaign.name]));

    res.json({
      range: { from: range.from.toISOString().slice(0, 10), to: range.to.toISOString().slice(0, 10) },
      thresholds: result.thresholds,
      baseline: result.baseline,
      items: result.rows.map((row) => ({
        ...row,
        creative: byId.get(row.creativeId)
          ? { ...byId.get(row.creativeId)!, url: creativeFileUrl(row.creativeId) }
          : null,
        campaigns: row.campaignIds.map((id) => ({ id, name: campaignNames.get(id) ?? 'Unknown campaign' })),
      })),
      /*
       * Said plainly rather than left to be inferred from an empty list: these
       * rows exist only for advertisements this system published and synced.
       */
      provenance:
        result.rows.length === 0
          ? 'No creative-level measurements yet. These appear after an advertisement is published through this system and its metrics are synced.'
          : 'Measured from provider insights for advertisements published through this system.',
    });
  }),
);

/** The main dashboard payload: KPIs, series, platform split and live alerts. */
analyticsRouter.get(
  '/dashboard',
  validateQuery(scopedQuery),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const query = req.query as unknown as z.infer<typeof scopedQuery>;
    const range = resolveRange(query);
    const prior = previousWindow(range.from, range.to);
    const clientId = resolveClientId(actor, query.clientId);

    const scope: Prisma.AnalyticsSnapshotWhereInput = {
      organizationId: orgId(actor),
      ...(clientId ? { clientId } : {}),
    };

    const [current, previous, clients, campaigns, scheduled, pendingApprovals, recentActivity] = await Promise.all([
      prisma.analyticsSnapshot.findMany({
        where: { ...scope, date: { gte: range.from, lte: range.to } },
        select: snapshotSelect,
        orderBy: { date: 'asc' },
      }),
      prisma.analyticsSnapshot.findMany({
        where: { ...scope, date: { gte: prior.from, lte: prior.to } },
        select: snapshotSelect,
      }),
      prisma.client.count({
        where: { organizationId: orgId(actor), ...(clientId ? { id: clientId } : {}), status: 'ACTIVE' },
      }),
      prisma.campaign.groupBy({
        by: ['status'],
        where: { organizationId: orgId(actor), ...(clientId ? { clientId } : {}) },
        _count: { _all: true },
        _sum: { budget: true, spend: true },
      }),
      prisma.content.count({
        where: { organizationId: orgId(actor), ...(clientId ? { clientId } : {}), status: ContentStatus.SCHEDULED },
      }),
      prisma.approval.count({
        where: { organizationId: orgId(actor), ...(clientId ? { clientId } : {}), status: ApprovalStatus.PENDING },
      }),
      prisma.auditLog.findMany({
        where: { organizationId: orgId(actor) },
        orderBy: { createdAt: 'desc' },
        take: 12,
        include: { user: { select: { id: true, name: true } } },
      }),
    ]);

    const totals = derive(sumSnapshots(current));
    const previousTotals = derive(sumSnapshots(previous));
    const activeCampaigns = campaigns.find((row) => row.status === CampaignStatus.RUNNING)?._count._all ?? 0;

    res.json({
      range: { from: range.from.toISOString().slice(0, 10), to: range.to.toISOString().slice(0, 10) },
      kpis: {
        clients,
        activeCampaigns,
        scheduled,
        pendingApprovals,
        ...totals,
      },
      previous: previousTotals,
      series: byDay(current, range.from, range.to),
      platforms: byPlatform(current),
      campaignsByStatus: Object.fromEntries(campaigns.map((row) => [row.status, row._count._all])),
      alerts: await buildAlerts(orgId(actor), clientId),
      recentActivity: recentActivity.map((entry) => ({
        id: entry.id,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId,
        user: entry.user?.name ?? 'System',
        createdAt: entry.createdAt,
      })),
    });
  }),
);

/**
 * Alerts are derived from live rows, not authored. Each one states the figure
 * behind it so the reader can check it.
 */
async function buildAlerts(organizationId: string, clientId?: string) {
  const now = new Date();
  const soon = new Date(now.getTime() + 7 * 86400000);

  const [pending, endingSoon, overspending, failed] = await Promise.all([
    prisma.approval.count({ where: { organizationId, ...(clientId ? { clientId } : {}), status: ApprovalStatus.PENDING } }),
    prisma.campaign.findMany({
      where: {
        organizationId,
        ...(clientId ? { clientId } : {}),
        status: CampaignStatus.RUNNING,
        endDate: { gte: now, lte: soon },
      },
      select: { id: true, name: true, endDate: true },
      take: 5,
    }),
    prisma.$queryRaw<Array<{ id: string; name: string; budget: string; spend: string }>>`
      SELECT c.id, c.name, c.budget::text, c.spend::text
      FROM "Campaign" c
      WHERE c."organizationId" = ${organizationId}
        ${clientId ? Prisma.sql`AND c."clientId" = ${clientId}` : Prisma.empty}
        AND c.status = 'RUNNING'
        AND c.budget > 0
        AND c.spend >= c.budget * 0.85
      LIMIT 5`,
    prisma.content.count({
      where: { organizationId, ...(clientId ? { clientId } : {}), status: ContentStatus.FAILED },
    }),
  ]);

  const alerts: Array<{ level: 'info' | 'warning' | 'critical'; title: string; body: string; link?: string }> = [];

  if (pending > 0) {
    alerts.push({
      level: 'info',
      title: `${pending} item${pending === 1 ? '' : 's'} awaiting approval`,
      body: 'Content cannot be scheduled until the client signs it off.',
      link: '/app/approvals',
    });
  }
  for (const campaign of endingSoon) {
    const days = Math.max(0, Math.ceil((campaign.endDate.getTime() - now.getTime()) / 86400000));
    alerts.push({
      level: 'warning',
      title: `${campaign.name} ends in ${days} day${days === 1 ? '' : 's'}`,
      body: 'Plan the wrap-up report or extend the flight.',
      link: `/app/campaigns/${campaign.id}`,
    });
  }
  for (const campaign of overspending) {
    const budget = Number(campaign.budget);
    const spend = Number(campaign.spend);
    alerts.push({
      level: 'critical',
      title: `${campaign.name} is at ${Math.round((spend / budget) * 100)}% of budget`,
      body: `$${Math.round(spend).toLocaleString('en-US')} spent of $${Math.round(budget).toLocaleString('en-US')}.`,
      link: `/app/campaigns/${campaign.id}`,
    });
  }
  if (failed > 0) {
    alerts.push({
      level: 'critical',
      title: `${failed} publish${failed === 1 ? '' : 'es'} failed`,
      body: 'Check the integration connection and retry.',
      link: '/app/integrations',
    });
  }

  return alerts;
}

analyticsRouter.get(
  '/series',
  validateQuery(scopedQuery.extend({ campaignId: z.string().max(40).optional() })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const query = req.query as unknown as z.infer<typeof scopedQuery> & { campaignId?: string };
    const range = resolveRange(query);
    const clientId = resolveClientId(actor, query.clientId);

    const rows = await prisma.analyticsSnapshot.findMany({
      where: {
        organizationId: orgId(actor),
        ...(clientId ? { clientId } : {}),
        ...(query.campaignId ? { campaignId: query.campaignId } : {}),
        date: { gte: range.from, lte: range.to },
      },
      select: snapshotSelect,
      orderBy: { date: 'asc' },
    });

    res.json({
      range: { from: range.from.toISOString().slice(0, 10), to: range.to.toISOString().slice(0, 10) },
      series: byDay(rows, range.from, range.to),
      platforms: byPlatform(rows),
      totals: derive(sumSnapshots(rows)),
    });
  }),
);

/**
 * AI marketing analyst. The model receives only the computed figures assembled
 * below — it has no database access and cannot cite a number that was not
 * measured. Output is explicitly framed as recommendations.
 */
analyticsRouter.post(
  '/analyze',
  validateQuery(z.object({})),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const body = z
      .object({
        clientId: z.string().max(40).optional(),
        campaignId: z.string().max(40).optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
      })
      .parse(req.body ?? {});

    const clientId = resolveClientId(actor, body.clientId);
    if (!clientId) throw notFound('Client');

    const client = await prisma.client.findFirst({
      where: { id: clientId, organizationId: orgId(actor) },
      select: { id: true, name: true },
    });
    if (!client) throw notFound('Client');

    const range = resolveRange(body);
    const prior = previousWindow(range.from, range.to);
    const where: Prisma.AnalyticsSnapshotWhereInput = {
      organizationId: orgId(actor),
      clientId,
      ...(body.campaignId ? { campaignId: body.campaignId } : {}),
    };

    const [current, previous, campaigns] = await Promise.all([
      prisma.analyticsSnapshot.findMany({ where: { ...where, date: { gte: range.from, lte: range.to } }, select: snapshotSelect }),
      prisma.analyticsSnapshot.findMany({ where: { ...where, date: { gte: prior.from, lte: prior.to } }, select: snapshotSelect }),
      prisma.campaign.findMany({
        where: {
          organizationId: orgId(actor),
          clientId,
          ...(body.campaignId ? { id: body.campaignId } : { status: { in: [CampaignStatus.RUNNING, CampaignStatus.SCHEDULED] } }),
        },
        select: { name: true, budget: true, endDate: true },
      }),
    ]);

    const budget = campaigns.reduce((sum, campaign) => sum + Number(campaign.budget.toString()), 0);
    const lastEnd = campaigns.reduce<Date | null>(
      (latest, campaign) => (!latest || campaign.endDate > latest ? campaign.endDate : latest),
      null,
    );
    const daysRemaining = lastEnd ? Math.max(0, Math.ceil((lastEnd.getTime() - Date.now()) / 86400000)) : 0;

    const facts = buildFacts({
      clientName: client.name,
      campaignNames: campaigns.map((campaign) => campaign.name),
      current,
      previous,
      periodStart: range.from,
      periodEnd: range.to,
      budget,
      daysRemaining,
    });

    const result = await analyzeCampaigns(facts);

    await recordAiUsage({
      organizationId: orgId(actor),
      clientId,
      userId: actor.id,
      kind: 'ANALYSIS',
      model: result.model,
      provider: result.provider,
      latencyMs: result.latencyMs,
    });

    res.json({
      analysis: result.data,
      facts: { totals: facts.totals, platforms: facts.platforms, periodDays: facts.periodDays, budgetUsed: facts.budgetUsed },
      meta: {
        provider: result.provider,
        model: result.model,
        isFallback: result.isFallback,
        notice: result.notice,
        disclaimer: 'These are recommendations for a human to weigh, generated from measured campaign data.',
      },
    });
  }),
);

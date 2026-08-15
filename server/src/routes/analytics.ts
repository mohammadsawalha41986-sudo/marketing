/** /api/analytics — dashboard rollups, series, and the AI marketing analyst. */

import { Router } from 'express';
import { AdStatus, CampaignStatus, ContentStatus, Platform, Prisma } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { asyncHandler, notFound } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { validateQuery } from '../middleware/validate.js';
import { dateRangeQuery, resolveRange } from '../lib/http.js';
import { byDay, byPlatform, derive, previousWindow, sumSnapshots } from '../services/analytics.js';
import { analyzeCampaigns, buildFacts } from '../services/ai/index.js';
import { recordAiUsage } from '../services/audit.js';
import { workspaceCurrency } from '../lib/workspace.js';

export const analyticsRouter: Router = Router();
analyticsRouter.use(requireAuth);

const snapshotSelect = {
  platform: true, date: true, spend: true, reach: true, impressions: true,
  clicks: true, leads: true, conversions: true, revenue: true, engagements: true,
} as const;

const scopedQuery = dateRangeQuery.extend({
  restaurantId: z.string().max(40).optional(),
  campaignId: z.string().max(40).optional(),
  platform: z.nativeEnum(Platform).optional(),
});

/** The operator dashboard: KPIs, series, platform split and live alerts. */
analyticsRouter.get(
  '/dashboard',
  validateQuery(scopedQuery),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof scopedQuery>;
    const range = resolveRange(query);
    const prior = previousWindow(range.from, range.to);

    const scope: Prisma.AnalyticsSnapshotWhereInput = {
      ...(query.restaurantId ? { restaurantId: query.restaurantId } : {}),
      ...(query.campaignId ? { campaignId: query.campaignId } : {}),
      ...(query.platform ? { platform: query.platform } : {}),
    };
    const restaurantScope = query.restaurantId ? { restaurantId: query.restaurantId } : {};

    const [
      current, previous, restaurants, activeRestaurants, campaigns, scheduled,
      publishedInRange, ads, topRestaurant, topCampaign, upcoming, openTasks, recentActivity,
    ] = await Promise.all([
      prisma.analyticsSnapshot.findMany({
        where: { ...scope, date: { gte: range.from, lte: range.to } },
        select: snapshotSelect,
        orderBy: { date: 'asc' },
      }),
      prisma.analyticsSnapshot.findMany({
        where: { ...scope, date: { gte: prior.from, lte: prior.to } },
        select: snapshotSelect,
      }),
      prisma.restaurant.count({ where: query.restaurantId ? { id: query.restaurantId } : {} }),
      prisma.restaurant.count({ where: { ...(query.restaurantId ? { id: query.restaurantId } : {}), status: 'ACTIVE' } }),
      prisma.campaign.groupBy({
        by: ['status'],
        where: restaurantScope,
        _count: { _all: true },
        _sum: { budget: true, spend: true },
      }),
      prisma.content.count({ where: { ...restaurantScope, status: ContentStatus.SCHEDULED } }),
      prisma.content.count({
        where: { ...restaurantScope, status: ContentStatus.PUBLISHED, publishedAt: { gte: range.from, lte: range.to } },
      }),
      prisma.ad.aggregate({
        where: { ...restaurantScope, status: AdStatus.ACTIVE },
        _sum: { spend: true, leads: true, conversions: true },
        _count: { _all: true },
      }),
      // "Best performing" is decided by revenue over the window, computed from
      // stored snapshots rather than assigned by hand.
      prisma.analyticsSnapshot.groupBy({
        by: ['restaurantId'],
        where: { ...scope, date: { gte: range.from, lte: range.to } },
        _sum: { revenue: true, spend: true, conversions: true },
        orderBy: { _sum: { revenue: 'desc' } },
        take: 1,
      }),
      prisma.analyticsSnapshot.groupBy({
        by: ['campaignId'],
        where: { ...scope, date: { gte: range.from, lte: range.to }, campaignId: { not: null } },
        _sum: { revenue: true, spend: true, conversions: true },
        orderBy: { _sum: { revenue: 'desc' } },
        take: 1,
      }),
      prisma.content.findMany({
        where: { ...restaurantScope, status: ContentStatus.SCHEDULED, scheduledAt: { gte: new Date() } },
        orderBy: { scheduledAt: 'asc' },
        take: 8,
        select: {
          id: true, name: true, type: true, platform: true, scheduledAt: true,
          restaurant: { select: { id: true, name: true, logoUrl: true } },
        },
      }),
      prisma.task.count({ where: { ...restaurantScope, status: { not: 'DONE' } } }),
      prisma.auditLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 12,
        include: { user: { select: { id: true, name: true } } },
      }),
    ]);

    const totals = derive(sumSnapshots(current));
    const previousTotals = derive(sumSnapshots(previous));
    const activeCampaigns = campaigns.find((row) => row.status === CampaignStatus.ACTIVE)?._count._all ?? 0;

    // The group-by returns ids; the names are looked up only for the winners.
    const [bestRestaurant, bestCampaign] = await Promise.all([
      topRestaurant[0]
        ? prisma.restaurant.findUnique({
            where: { id: topRestaurant[0].restaurantId },
            select: { id: true, name: true, logoUrl: true },
          })
        : null,
      topCampaign[0]?.campaignId
        ? prisma.campaign.findUnique({
            where: { id: topCampaign[0].campaignId },
            select: { id: true, name: true, restaurant: { select: { id: true, name: true } } },
          })
        : null,
    ]);

    res.json({
      range: { from: range.from.toISOString().slice(0, 10), to: range.to.toISOString().slice(0, 10) },
      currency: await workspaceCurrency(),
      kpis: {
        restaurants,
        activeRestaurants,
        activeCampaigns,
        activeAds: ads._count._all,
        adSpend: Number(ads._sum.spend ?? 0),
        adLeads: ads._sum.leads ?? 0,
        adConversions: ads._sum.conversions ?? 0,
        scheduled,
        published: publishedInRange,
        openTasks,
        ...totals,
      },
      previous: previousTotals,
      series: byDay(current, range.from, range.to),
      platforms: byPlatform(current),
      campaignsByStatus: Object.fromEntries(campaigns.map((row) => [row.status, row._count._all])),
      best: {
        restaurant: bestRestaurant
          ? { ...bestRestaurant, revenue: Number(topRestaurant[0]?._sum.revenue ?? 0), spend: Number(topRestaurant[0]?._sum.spend ?? 0) }
          : null,
        campaign: bestCampaign
          ? { ...bestCampaign, revenue: Number(topCampaign[0]?._sum.revenue ?? 0), spend: Number(topCampaign[0]?._sum.spend ?? 0) }
          : null,
      },
      upcoming,
      alerts: await buildAlerts(query.restaurantId),
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
async function buildAlerts(restaurantId?: string) {
  const now = new Date();
  const soon = new Date(now.getTime() + 7 * 86400000);
  const scope = restaurantId ? { restaurantId } : {};

  const [endingSoon, overspending, overdueTasks, staleAds] = await Promise.all([
    prisma.campaign.findMany({
      where: { ...scope, status: CampaignStatus.ACTIVE, endDate: { gte: now, lte: soon } },
      select: { id: true, name: true, endDate: true },
      take: 5,
    }),
    prisma.$queryRaw<Array<{ id: string; name: string; budget: string; spend: string }>>`
      SELECT c.id, c.name, c.budget::text, c.spend::text
      FROM "Campaign" c
      WHERE ${restaurantId ? Prisma.sql`c."restaurantId" = ${restaurantId}` : Prisma.sql`TRUE`}
        AND c.status = 'ACTIVE'
        AND c.budget > 0
        AND c.spend >= c.budget * 0.85
      LIMIT 5`,
    prisma.task.count({ where: { ...scope, status: { not: 'DONE' }, dueAt: { lt: now } } }),
    // An active ad nobody has entered figures for is a reporting gap, and the
    // operator is the only one who can close it.
    prisma.ad.count({ where: { ...scope, status: AdStatus.ACTIVE, metricsAt: null } }),
  ]);

  const alerts: Array<{ level: 'info' | 'warning' | 'critical'; title: string; body: string; link?: string }> = [];
  const currency = await workspaceCurrency();

  for (const campaign of endingSoon) {
    const days = Math.max(0, Math.ceil((campaign.endDate.getTime() - now.getTime()) / 86400000));
    alerts.push({
      level: 'warning',
      title: `${campaign.name} ends in ${days} day${days === 1 ? '' : 's'}`,
      body: 'Plan the wrap-up report or extend the flight.',
      link: `/campaigns/${campaign.id}`,
    });
  }
  for (const campaign of overspending) {
    const budget = Number(campaign.budget);
    const spend = Number(campaign.spend);
    alerts.push({
      level: 'critical',
      title: `${campaign.name} is at ${Math.round((spend / budget) * 100)}% of budget`,
      body: `${currency} ${Math.round(spend).toLocaleString('en-US')} spent of ${currency} ${Math.round(budget).toLocaleString('en-US')}.`,
      link: `/campaigns/${campaign.id}`,
    });
  }
  if (overdueTasks > 0) {
    alerts.push({
      level: 'warning',
      title: `${overdueTasks} task${overdueTasks === 1 ? '' : 's'} overdue`,
      body: 'Past their due date and not marked done.',
      link: '/tasks',
    });
  }
  if (staleAds > 0) {
    alerts.push({
      level: 'info',
      title: `${staleAds} active ad${staleAds === 1 ? '' : 's'} with no figures recorded`,
      body: 'Enter the latest numbers from the ad platform to keep reporting accurate.',
      link: '/ads',
    });
  }

  return alerts;
}

analyticsRouter.get(
  '/series',
  validateQuery(scopedQuery),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof scopedQuery>;
    const range = resolveRange(query);

    const rows = await prisma.analyticsSnapshot.findMany({
      where: {
        ...(query.restaurantId ? { restaurantId: query.restaurantId } : {}),
        ...(query.campaignId ? { campaignId: query.campaignId } : {}),
        ...(query.platform ? { platform: query.platform } : {}),
        date: { gte: range.from, lte: range.to },
      },
      select: snapshotSelect,
      orderBy: { date: 'asc' },
    });

    res.json({
      range: { from: range.from.toISOString().slice(0, 10), to: range.to.toISOString().slice(0, 10) },
      currency: await workspaceCurrency(),
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
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        restaurantId: z.string().min(1).max(40),
        campaignId: z.string().max(40).optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
      })
      .parse(req.body ?? {});

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: body.restaurantId },
      select: { id: true, name: true },
    });
    if (!restaurant) throw notFound('Restaurant');

    const range = resolveRange(body);
    const prior = previousWindow(range.from, range.to);
    const where: Prisma.AnalyticsSnapshotWhereInput = {
      restaurantId: restaurant.id,
      ...(body.campaignId ? { campaignId: body.campaignId } : {}),
    };

    const [current, previous, campaigns] = await Promise.all([
      prisma.analyticsSnapshot.findMany({ where: { ...where, date: { gte: range.from, lte: range.to } }, select: snapshotSelect }),
      prisma.analyticsSnapshot.findMany({ where: { ...where, date: { gte: prior.from, lte: prior.to } }, select: snapshotSelect }),
      prisma.campaign.findMany({
        where: {
          restaurantId: restaurant.id,
          ...(body.campaignId ? { id: body.campaignId } : { status: { in: [CampaignStatus.ACTIVE, CampaignStatus.PLANNING] } }),
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
      restaurantName: restaurant.name,
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
      restaurantId: restaurant.id,
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

/**
 * Loads campaigns and turns them into fully-derived rollups.
 *
 * Shared by `/api/campaigns/:id/finance` and `/api/ceo/*` so a campaign's
 * numbers are identical wherever they are read. Two views computing the same
 * figure through different code is how a dashboard and a report end up
 * disagreeing about the same campaign.
 */

import { Prisma } from '@prisma/client';

import { prisma } from '../lib/prisma.js';
import { campaignHealth, recommend } from './campaign-health.js';
import type { CampaignRollup } from './ceo.js';
import { computeCampaignFinance, type FinanceInput } from './finance.js';

/** Approved-and-beyond content counts as ready; earlier states do not. */
const APPROVED_STATES = ['APPROVED', 'SCHEDULED', 'PUBLISHED'] as const;

const CAMPAIGN_SELECT = {
  id: true,
  name: true,
  clientId: true,
  status: true,
  budget: true,
  currency: true,
  startDate: true,
  endDate: true,
  objective: true,
  targetAudience: true,
  offer: true,
  landingPageUrl: true,
  ctaLabel: true,
  strategy: true,
  grossRevenue: true,
  discounts: true,
  cogs: true,
  targetCpa: true,
  targetRoas: true,
  targetRevenue: true,
  targetConversions: true,
  client: { select: { id: true, name: true } },
  costs: { select: { kind: true, category: true, amount: true } },
  contents: { select: { status: true } },
} satisfies Prisma.CampaignSelect;

type LoadedCampaign = Prisma.CampaignGetPayload<{ select: typeof CAMPAIGN_SELECT }>;

/**
 * Performance totals per campaign, from AnalyticsSnapshot.
 *
 * Aggregated in one grouped query rather than per campaign — the CEO view reads
 * every campaign in the organisation at once, and a query each would make the
 * page cost grow with the customer's success.
 */
async function performanceByCampaign(campaignIds: string[], range?: { from: Date; to: Date }) {
  if (campaignIds.length === 0) return new Map<string, { spend: number; revenue: number; conversions: number; clicks: number; impressions: number }>();

  const rows = await prisma.analyticsSnapshot.groupBy({
    by: ['campaignId'],
    where: {
      campaignId: { in: campaignIds },
      ...(range ? { date: { gte: range.from, lte: range.to } } : {}),
    },
    _sum: { spend: true, revenue: true, conversions: true, clicks: true, impressions: true },
  });

  const number = (value: Prisma.Decimal | number | null) =>
    value === null ? 0 : typeof value === 'number' ? value : Number(value.toString());

  return new Map(
    rows
      .filter((row) => row.campaignId !== null)
      .map((row) => [
        row.campaignId as string,
        {
          spend: number(row._sum.spend),
          revenue: number(row._sum.revenue),
          conversions: row._sum.conversions ?? 0,
          clicks: row._sum.clicks ?? 0,
          impressions: row._sum.impressions ?? 0,
        },
      ]),
  );
}

function toRollup(
  campaign: LoadedCampaign,
  performance: { spend: number; revenue: number; conversions: number; clicks: number; impressions: number } | undefined,
  now: Date,
): CampaignRollup {
  const input: FinanceInput = {
    budget: campaign.budget,
    currency: campaign.currency,
    startDate: campaign.startDate,
    endDate: campaign.endDate,
    grossRevenue: campaign.grossRevenue,
    discounts: campaign.discounts,
    cogs: campaign.cogs,
    targetCpa: campaign.targetCpa,
    targetRoas: campaign.targetRoas,
    targetRevenue: campaign.targetRevenue,
    targetConversions: campaign.targetConversions,
    costs: campaign.costs,
    performance: {
      hasSnapshots: performance !== undefined,
      spend: performance?.spend ?? 0,
      revenue: performance?.revenue ?? 0,
      conversions: performance?.conversions ?? 0,
      clicks: performance?.clicks ?? 0,
      impressions: performance?.impressions ?? 0,
    },
  };

  const finance = computeCampaignFinance(input, now);
  const approved = campaign.contents.filter((content) =>
    (APPROVED_STATES as readonly string[]).includes(content.status),
  ).length;

  const health = campaignHealth({
    status: campaign.status,
    finance,
    brief: {
      hasObjective: Boolean(campaign.objective),
      hasAudience: Boolean(campaign.targetAudience?.trim()),
      hasOffer: Boolean(campaign.offer?.trim()),
      hasLandingPage: Boolean(campaign.landingPageUrl?.trim()),
      hasCta: Boolean(campaign.ctaLabel?.trim()),
      hasStrategy: Boolean(campaign.strategy?.trim()),
    },
    content: { total: campaign.contents.length, approved },
  });

  return {
    id: campaign.id,
    name: campaign.name,
    clientId: campaign.clientId,
    clientName: campaign.client.name,
    status: campaign.status,
    finance,
    health,
    recommendation: recommend({ finance, health, status: campaign.status }),
  };
}

/** Rollups for every campaign matching `where`. */
export async function loadRollups(
  where: Prisma.CampaignWhereInput,
  options: { range?: { from: Date; to: Date }; now?: Date } = {},
): Promise<CampaignRollup[]> {
  const campaigns = await prisma.campaign.findMany({ where, select: CAMPAIGN_SELECT, orderBy: { startDate: 'desc' } });
  const performance = await performanceByCampaign(campaigns.map((campaign) => campaign.id), options.range);
  const now = options.now ?? new Date();
  return campaigns.map((campaign) => toRollup(campaign, performance.get(campaign.id), now));
}

/** Rollup for one campaign, or null when it is outside the caller's scope. */
export async function loadRollup(
  where: Prisma.CampaignWhereInput,
  options: { range?: { from: Date; to: Date }; now?: Date } = {},
): Promise<CampaignRollup | null> {
  const campaign = await prisma.campaign.findFirst({ where, select: CAMPAIGN_SELECT });
  if (!campaign) return null;
  const performance = await performanceByCampaign([campaign.id], options.range);
  return toRollup(campaign, performance.get(campaign.id), options.now ?? new Date());
}

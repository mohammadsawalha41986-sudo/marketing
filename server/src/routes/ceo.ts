/** /api/ceo — the executive portfolio view. Read-only. */

import { Router } from 'express';
import { ApprovalStatus, CampaignStatus, Prisma } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { asyncHandler } from '../lib/errors.js';
import { actorOf, requireAuth } from '../middleware/auth.js';
import { validateQuery } from '../middleware/validate.js';
import { dateRangeQuery, resolveRange } from '../lib/http.js';
import { orgId, resolveClientId } from '../lib/scope.js';
import { loadRollups } from '../services/campaign-rollup.js';
import { executiveBrief, executiveOverview } from '../services/ceo.js';

export const ceoRouter: Router = Router();
ceoRouter.use(requireAuth);

/** Campaigns starting within this many days count as "upcoming". */
const UPCOMING_DAYS = 14;

const overviewQuery = dateRangeQuery.extend({
  clientId: z.string().max(40).optional(),
});

ceoRouter.get(
  '/overview',
  validateQuery(overviewQuery),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const query = req.query as unknown as z.infer<typeof overviewQuery>;
    // Client users may only ever name their own client; the scope layer turns
    // any other id into a miss rather than confirming it exists.
    const clientId = resolveClientId(actor, query.clientId);
    const range = resolveRange(query);

    const where: Prisma.CampaignWhereInput = {
      organizationId: orgId(actor),
      ...(clientId ? { clientId } : {}),
      // Archived campaigns are history, not portfolio.
      status: { not: CampaignStatus.ARCHIVED },
    };

    const now = new Date();
    const horizon = new Date(now.getTime() + UPCOMING_DAYS * 86400000);

    const [rollups, pendingApprovals, upcoming, currencyRow] = await Promise.all([
      loadRollups(where, { range, now }),
      prisma.approval.count({
        where: {
          status: ApprovalStatus.PENDING,
          content: { organizationId: orgId(actor), ...(clientId ? { clientId } : {}) },
        },
      }),
      prisma.campaign.findMany({
        where: { ...where, startDate: { gt: now, lte: horizon } },
        select: { id: true, name: true, startDate: true },
        orderBy: { startDate: 'asc' },
        take: 5,
      }),
      prisma.campaign.findFirst({
        where,
        select: { currency: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const overview = executiveOverview(rollups, {
      pendingApprovals,
      upcoming,
      currency: currencyRow?.currency ?? 'USD',
    });

    res.json({
      range: { from: range.from.toISOString().slice(0, 10), to: range.to.toISOString().slice(0, 10) },
      overview,
      brief: executiveBrief(overview, rollups),
      campaigns: rollups.map((rollup) => ({
        id: rollup.id,
        name: rollup.name,
        clientId: rollup.clientId,
        clientName: rollup.clientName,
        status: rollup.status,
        health: rollup.health,
        recommendation: rollup.recommendation,
        finance: {
          currency: rollup.finance.currency,
          adSpend: rollup.finance.adSpend,
          attributedRevenue: rollup.finance.attributedRevenue,
          contributionProfit: rollup.finance.contributionProfit,
          roas: rollup.finance.roas,
          roi: rollup.finance.roi,
          cpa: rollup.finance.cpa,
          budget: rollup.finance.budget,
        },
      })),
    });
  }),
);

export default ceoRouter;

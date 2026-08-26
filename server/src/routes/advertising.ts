/**
 * The Advertising Command Center's API.
 *
 * Read-only by design. This phase is view, monitor and preview: every write
 * path an advertisement has — drafting, approving, publishing — already exists
 * on `/api/publications` and is deliberately left there, because those routes
 * spend money in somebody's ad account and already have the approval gate,
 * the preflight and the audit trail around them. Adding a second way to reach
 * them from a dashboard would be a second thing to keep safe.
 *
 * Every handler resolves its actor and hands it to the service, which applies
 * `scopeWhere` to each query. Nothing here takes an organisation id from the
 * request; a filter naming another tenant's client simply matches no rows.
 */

import { Router } from 'express';
import { Platform } from '@prisma/client';
import { z } from 'zod';

import { asyncHandler, notFound } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { resolveClientId, scopeWhere } from '../lib/scope.js';
import { actorOf, requireAgency, requireAuth } from '../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { brandContext } from '../services/ai/context.js';
import { advertisingInsights } from '../services/advertising/ai/insights.js';
import { organicToPaid, paidToOrganic } from '../services/advertising/ai/bridge.js';
import { decide, listRecommendations, persistInsights } from '../services/advertising/ai/store.js';
import { BriefUnavailableError, briefProviderStatus, creativeBrief } from '../services/advertising/ai/brief.js';
import {
  advertisingOverview,
  campaignDetail,
  listCampaigns,
  platformAvailability,
  type AdvertisingFilters,
} from '../services/advertising/overview.js';
import { buildPreview } from '../services/advertising/preview.js';
import { creativeLibrary } from '../services/advertising/creatives.js';
import { paidCalendar } from '../services/advertising/calendar.js';

export const advertisingRouter: Router = Router();

advertisingRouter.use(requireAuth);

const AD_STATUS = [
  'DRAFT', 'PENDING', 'ACTIVE', 'PAUSED', 'COMPLETED',
  'FAILED', 'REJECTED', 'NEEDS_ATTENTION', 'UNKNOWN',
] as const;

/** The filter vocabulary, shared by every list endpoint below. */
const filterQuery = z.object({
  clientId: z.string().max(40).optional(),
  platform: z.nativeEnum(Platform).optional(),
  status: z.enum(AD_STATUS).optional(),
  objective: z.string().max(60).optional(),
  campaignId: z.string().max(40).optional(),
  accountId: z.string().max(80).optional(),
  search: z.string().max(120).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

type FilterQuery = z.infer<typeof filterQuery>;

function toFilters(query: FilterQuery): AdvertisingFilters {
  return {
    ...query,
    from: query.from ? new Date(query.from) : undefined,
    to: query.to ? new Date(query.to) : undefined,
  };
}

const idParam = z.object({ id: z.string().min(1).max(40) });

// ------------------------------------------------------------- dashboard

advertisingRouter.get(
  '/overview',
  validateQuery(filterQuery),
  asyncHandler(async (req, res) => {
    res.json(await advertisingOverview(actorOf(req), toFilters(req.query as FilterQuery)));
  }),
);

/**
 * The platform availability list on its own.
 *
 * Filters need it before any campaign has loaded, and the dashboard would
 * otherwise be fetched twice to populate a select.
 */
advertisingRouter.get(
  '/platforms',
  asyncHandler(async (_req, res) => {
    res.json({ platforms: platformAvailability() });
  }),
);

// ------------------------------------------------------------- campaigns

advertisingRouter.get(
  '/campaigns',
  validateQuery(filterQuery),
  asyncHandler(async (req, res) => {
    res.json(await listCampaigns(actorOf(req), toFilters(req.query as FilterQuery)));
  }),
);

advertisingRouter.get(
  '/campaigns/:id',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const campaign = await campaignDetail(actorOf(req), req.params.id!);
    // 404 rather than 403 for another organisation's id: the response must not
    // confirm that the row exists.
    if (!campaign) throw notFound('Campaign');
    res.json({ campaign });
  }),
);

/**
 * How the advertisement will look, per placement.
 *
 * Built from the campaign's own recorded copy and creative — never from
 * defaults — so a field the draft never had shows as missing rather than as a
 * plausible-looking placeholder the customer will not see.
 */
advertisingRouter.get(
  '/campaigns/:id/preview',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const campaign = await campaignDetail(actorOf(req), req.params.id!);
    if (!campaign) throw notFound('Campaign');

    const preview = buildPreview({
      platform: campaign.platform,
      advertiserName: campaign.clientName,
      advertiserAvatarUrl: null,
      headline: campaign.copy.headline,
      message: campaign.copy.message,
      description: null,
      callToAction: campaign.copy.callToAction,
      linkUrl: campaign.copy.linkUrl,
      media: campaign.media.kind
        ? {
          type: campaign.media.kind === 'VIDEO' ? 'VIDEO' : 'IMAGE',
          mimeType: campaign.media.mimeType ?? 'image/jpeg',
          sizeBytes: campaign.media.sizeBytes ?? 0,
          width: campaign.media.width,
          height: campaign.media.height,
          durationSeconds: campaign.media.durationSeconds,
          url: campaign.media.url,
        }
        : null,
    });

    res.json({ preview });
  }),
);

// -------------------------------------------------------------- library

advertisingRouter.get(
  '/creatives',
  validateQuery(filterQuery.extend({ kind: z.enum(['IMAGE', 'VIDEO']).optional() })),
  asyncHandler(async (req, res) => {
    const query = req.query as FilterQuery & { kind?: 'IMAGE' | 'VIDEO' };
    res.json(await creativeLibrary(actorOf(req), { ...toFilters(query), kind: query.kind }));
  }),
);

// ------------------------------------------------------------- calendar

advertisingRouter.get(
  '/calendar',
  validateQuery(filterQuery),
  asyncHandler(async (req, res) => {
    res.json(await paidCalendar(actorOf(req), toFilters(req.query as FilterQuery)));
  }),
);

// ------------------------------------------------------------------- AI
//
// The AI Advertising Engine. Read and decide only: `/insights` analyses,
// `/recommendations` lists what was persisted, and the decision endpoint
// records agreement or disagreement. None of them changes a budget, a schedule
// or a campaign — accepting a recommendation is not applying it, and there is
// deliberately no route here that spends money. §29.

const AI_PRIORITY = ['P0', 'P1', 'P2', 'P3'] as const;

const RECOMMENDATION_STATUS = [
  'PENDING', 'REVIEWED', 'APPROVED', 'REJECTED', 'APPLIED', 'EXPIRED', 'FAILED',
] as const;

/** The analysis window. Thirty days unless the caller says otherwise. */
function windowFrom(query: { from?: string; to?: string }): { from: Date; to: Date } {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * 86_400_000);
  return { from, to };
}

advertisingRouter.get(
  '/ai/insights',
  validateQuery(filterQuery.extend({ persist: z.enum(['true', 'false']).optional() })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const query = req.query as FilterQuery & { persist?: 'true' | 'false' };
    const { from, to } = windowFrom(query);

    const clientId = resolveClientId(actor, query.clientId);

    const [report, toPaid, toOrganic] = await Promise.all([
      advertisingInsights({
        prisma, actor, clientId, from, to,
        ...(query.platform ? { platform: query.platform } : {}),
      }),
      organicToPaid({ actor, clientId, from, to }),
      paidToOrganic({ prisma, actor, clientId, from, to }),
    ]);

    // The two bridge directions are sections like any other, so the dashboard
    // renders them with the same card and the same evidence treatment.
    const sections = [
      ...report.sections,
      { key: 'ORGANIC_TO_PAID', insights: toPaid },
      { key: 'PAID_TO_ORGANIC', insights: toOrganic },
    ];

    /*
     * Persistence is opt-in and needs a single client: a recommendation row is
     * keyed to one client, and "all restaurants" is a view rather than an owner.
     */
    let persisted: { created: number; superseded: number } | null = null;
    if (query.persist === 'true' && clientId) {
      persisted = await persistInsights({
        prisma, actor, clientId, report: { ...report, sections },
      });
    }

    res.json({
      ...report,
      sections,
      persisted,
      // So the UI can say whether a model was involved at all. §28.
      ai: briefProviderStatus(),
    });
  }),
);

advertisingRouter.get(
  '/ai/recommendations',
  validateQuery(
    filterQuery.extend({
      type: z.string().max(40).optional(),
      priority: z.enum(AI_PRIORITY).optional(),
      recommendationStatus: z.enum(RECOMMENDATION_STATUS).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const query = req.query as FilterQuery & {
      type?: string; priority?: string; recommendationStatus?: string;
    };

    res.json(await listRecommendations(prisma, actor, {
      clientId: resolveClientId(actor, query.clientId),
      platform: query.platform,
      ...(query.type ? { type: query.type as never } : {}),
      ...(query.priority ? { priority: query.priority } : {}),
      ...(query.recommendationStatus ? { status: query.recommendationStatus as never } : {}),
      ...(query.campaignId ? { campaignId: query.campaignId } : {}),
      ...(query.page ? { page: query.page } : {}),
      ...(query.pageSize ? { pageSize: query.pageSize } : {}),
    }));
  }),
);

/**
 * Record a decision.
 *
 * Agency-only: deciding what to do about somebody's advertising budget is
 * agency work, and the client portal reads rather than directs.
 */
advertisingRouter.post(
  '/ai/recommendations/:id/decision',
  requireAgency,
  validateParams(idParam),
  validateBody(z.object({ decision: z.enum(['REVIEWED', 'ACCEPTED', 'DISMISSED']) })),
  asyncHandler(async (req, res) => {
    const body = req.body as { decision: 'REVIEWED' | 'ACCEPTED' | 'DISMISSED' };

    const updated = await decide({
      prisma, actor: actorOf(req), id: req.params.id!, decision: body.decision,
    });
    // 404 rather than 403: the response must not confirm another org's row.
    if (!updated) throw notFound('Recommendation');

    res.json({ recommendation: updated });
  }),
);

/**
 * A creative brief for one platform.
 *
 * Refuses outright for a platform this deployment cannot advertise on — a brief
 * describing an advertisement nobody can run is worse than no brief, because
 * somebody would act on it.
 */
advertisingRouter.post(
  '/ai/brief',
  requireAgency,
  validateBody(
    z.object({
      clientId: z.string().max(40),
      platform: z.nativeEnum(Platform),
      objective: z.string().min(1).max(80),
      language: z.enum(['EN', 'AR']).default('EN'),
      audience: z.string().max(200).optional(),
      location: z.string().max(120).optional(),
      offer: z.string().max(200).optional(),
      creativeType: z.string().max(40).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const body = req.body as {
      clientId: string; platform: Platform; objective: string;
      language: 'EN' | 'AR'; audience?: string; location?: string;
      offer?: string; creativeType?: string;
    };

    const client = await prisma.client.findFirst({
      where: { id: body.clientId, ...scopeWhere(actor) },
      include: { brand: true },
    });
    if (!client?.brand) throw notFound('Brand');

    try {
      const brief = await creativeBrief({
        brand: brandContext(client.brand),
        platform: body.platform,
        objective: body.objective,
        language: body.language,
        audience: body.audience ?? null,
        location: body.location ?? null,
        offer: body.offer ?? null,
        creativeType: body.creativeType ?? null,
      });
      res.json({ brief });
    } catch (error) {
      if (error instanceof BriefUnavailableError) {
        // Not a 500: the platform genuinely has no advertising integration,
        // and the reason is the useful part of the answer.
        res.status(422).json({
          error: { code: 'BRIEF_UNAVAILABLE', message: error.detail, platform: error.platform },
        });
        return;
      }
      throw error;
    }
  }),
);

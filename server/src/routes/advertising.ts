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
import { actorOf, requireAuth } from '../middleware/auth.js';
import { validateParams, validateQuery } from '../middleware/validate.js';
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

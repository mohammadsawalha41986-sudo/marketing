/**
 * /api/google — Business Profile locations, reviews and the local SEO audit.
 *
 * The route that matters most in this file is the reply. Publishing to Google
 * puts words under the restaurant's own name on a public listing, so the path
 * is deliberately narrow:
 *
 *   suggest  → writes `aiSuggestion`, and can never publish
 *   approve  → a person accepts or edits the text; the row records who
 *   publish  → sends only the approved text, and refuses if none was approved
 *
 * There is no endpoint that generates and publishes in one call, and `publish`
 * does not read `aiSuggestion`. That is the whole safety property: no sequence
 * of requests puts unreviewed AI wording in front of a customer.
 *
 * Every read is scoped by organisation, and by client for a portal user, using
 * the same `scopeWhere`/`resolveClientId` helpers the rest of the API uses.
 */

import { Router } from 'express';
import { Platform, ReviewCategory, ReviewReplyStatus, ReviewSentiment } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest, conflict, notFound } from '../lib/errors.js';
import { actorOf, requireAgency, requireAuth } from '../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { idParam, pageResult, paginate, paginationQuery } from '../lib/http.js';
import { assertWritable, orgId, resolveClientId } from '../lib/scope.js';
import { recordAudit } from '../services/audit.js';
import type { FetchLike } from '../services/integrations/meta.js';
import { GoogleNotConnectedError, accessTokenFor, syncLocations, syncReviews } from '../services/google/sync.js';
import { publishReply } from '../services/google/reviews.js';
import { clusterComplaints, suggestReply } from '../services/google/analyze.js';
import { auditLocation, auditNap, unsupported } from '../services/google/seo.js';

export const googleRouter: Router = Router();
googleRouter.use(requireAuth);

const fetchImpl = fetch as unknown as FetchLike;

/** Connection problems are the operator's to fix, not 500s. */
function rethrow(error: unknown): never {
  if (error instanceof GoogleNotConnectedError) throw badRequest(error.message);
  throw error;
}

/** Every location this actor may see. The one scoping predicate for the file. */
function locationScope(actor: ReturnType<typeof actorOf>) {
  const clientId = resolveClientId(actor, undefined);
  return { organizationId: orgId(actor), ...(clientId ? { clientId } : {}) };
}

// ---------------------------------------------------------------- locations

googleRouter.get(
  '/locations',
  validateQuery(z.object({ clientId: z.string().max(40).optional() })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const requested = (req.query as { clientId?: string }).clientId;
    const clientId = resolveClientId(actor, requested);

    const locations = await prisma.googleLocation.findMany({
      where: { organizationId: orgId(actor), ...(clientId ? { clientId } : {}) },
      orderBy: { title: 'asc' },
      select: {
        id: true, externalName: true, title: true, storeCode: true,
        addressLines: true, locality: true, region: true, postalCode: true, country: true,
        phone: true, websiteUri: true, mapsUri: true, primaryCategory: true, syncedAt: true,
        client: { select: { id: true, name: true, businessName: true } },
        _count: { select: { reviews: true } },
      },
    });

    res.json({ locations });
  }),
);

googleRouter.post(
  '/locations/sync',
  requireAgency,
  validateBody(z.object({ clientId: z.string().min(1).max(40) })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);
    const { clientId } = req.body as { clientId: string };

    // The client must be this organisation's before its Google data is touched.
    const client = await prisma.client.findFirst({
      where: { id: clientId, organizationId: orgId(actor) },
      select: { id: true },
    });
    if (!client) throw notFound('Client');

    try {
      const result = await syncLocations({
        prisma, organizationId: orgId(actor), clientId: client.id, fetchImpl,
      });
      await recordAudit({ actor, action: 'google.locations.sync', entity: 'Client', entityId: client.id, ip: req.ip });
      res.json(result);
    } catch (error) {
      rethrow(error);
    }
  }),
);

// ------------------------------------------------------------------ reviews

googleRouter.get(
  '/reviews',
  validateQuery(paginationQuery.extend({
    clientId: z.string().max(40).optional(),
    locationId: z.string().max(40).optional(),
    sentiment: z.nativeEnum(ReviewSentiment).optional(),
    category: z.nativeEnum(ReviewCategory).optional(),
    replyStatus: z.nativeEnum(ReviewReplyStatus).optional(),
    rating: z.coerce.number().int().min(1).max(5).optional(),
    search: z.string().max(200).optional(),
  })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const query = req.query as unknown as z.infer<typeof paginationQuery> & {
      clientId?: string; locationId?: string; sentiment?: ReviewSentiment;
      category?: ReviewCategory; replyStatus?: ReviewReplyStatus; rating?: number; search?: string;
    };
    const clientId = resolveClientId(actor, query.clientId);

    const where = {
      organizationId: orgId(actor),
      ...(clientId ? { clientId } : {}),
      ...(query.locationId ? { locationId: query.locationId } : {}),
      ...(query.sentiment ? { sentiment: query.sentiment } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.replyStatus ? { replyStatus: query.replyStatus } : {}),
      ...(query.rating ? { rating: query.rating } : {}),
      ...(query.search
        ? { comment: { contains: query.search, mode: 'insensitive' as const } }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.googleReview.findMany({
        where,
        ...paginate(query),
        orderBy: { createTime: 'desc' },
        select: {
          id: true, externalId: true, reviewerName: true, reviewerPhotoUrl: true,
          rating: true, comment: true, createTime: true, updateTime: true,
          sentiment: true, category: true, complaintKey: true, analyzedAt: true,
          aiSuggestion: true, aiProvider: true, aiGeneratedAt: true,
          replyStatus: true, replyText: true, repliedAt: true, replyError: true,
          approvedBy: { select: { id: true, name: true } },
          location: { select: { id: true, title: true, locality: true } },
        },
      }),
      prisma.googleReview.count({ where }),
    ]);

    res.json(pageResult(items, total, query));
  }),
);

googleRouter.post(
  '/locations/:id/reviews/sync',
  requireAgency,
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);

    const location = await prisma.googleLocation.findFirst({
      where: { id: (req.params as { id: string }).id, ...locationScope(actor) },
      select: { id: true },
    });
    if (!location) throw notFound('Location');

    try {
      const result = await syncReviews({
        prisma, organizationId: orgId(actor), clientId: '', locationId: location.id, fetchImpl,
      });
      await recordAudit({
        actor, action: 'google.reviews.sync', entity: 'GoogleLocation', entityId: location.id, ip: req.ip,
      });
      res.json(result);
    } catch (error) {
      rethrow(error);
    }
  }),
);

/** The review, plus everything derived about it. */
async function findReview(actor: ReturnType<typeof actorOf>, id: string) {
  const review = await prisma.googleReview.findFirst({
    where: { id, ...locationScope(actor) },
    include: {
      location: { select: { id: true, title: true, externalName: true, accountName: true, clientId: true } },
      client: {
        select: {
          id: true, businessName: true,
          brand: true,
        },
      },
    },
  });
  if (!review) throw notFound('Review');
  return review;
}

/**
 * Draft a reply. Writes a suggestion and nothing else.
 *
 * The status becomes SUGGESTED, which is explicitly *not* approved: it records
 * that a machine wrote something, and the workspace shows it as unread.
 */
googleRouter.post(
  '/reviews/:id/suggest',
  requireAgency,
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);
    const review = await findReview(actor, (req.params as { id: string }).id);

    if (review.replyStatus === ReviewReplyStatus.PUBLISHED) {
      throw conflict('This review has already been answered on Google.');
    }

    const suggestion = await suggestReply({
      brand: review.client.brand,
      businessName: review.client.businessName,
      language: review.client.brand?.preferredLanguage === 'AR' ? 'AR' : 'EN',
      rating: review.rating,
      comment: review.comment,
      category: review.category ?? ReviewCategory.OTHER,
      sentiment: review.sentiment ?? ReviewSentiment.NEUTRAL,
      reviewerName: review.reviewerName,
    });

    const updated = await prisma.googleReview.update({
      where: { id: review.id },
      data: {
        aiSuggestion: suggestion.text,
        aiProvider: suggestion.provider,
        aiGeneratedAt: new Date(),
        // Never PENDING_APPROVAL: nobody has read it yet.
        replyStatus: ReviewReplyStatus.SUGGESTED,
      },
      select: { id: true, aiSuggestion: true, aiProvider: true, aiGeneratedAt: true, replyStatus: true },
    });

    res.json({ review: updated, notice: suggestion.notice ?? null });
  }),
);

/**
 * Approve a reply — the human gate.
 *
 * Takes the text explicitly rather than approving whatever is stored, so an
 * operator who edited the suggestion approves what they actually read. The
 * approver is recorded, which is what makes "a person approved this" provable
 * afterwards rather than merely claimed.
 */
googleRouter.post(
  '/reviews/:id/approve',
  requireAgency,
  validateParams(idParam),
  validateBody(z.object({ text: z.string().trim().min(1).max(1500) })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);
    const review = await findReview(actor, (req.params as { id: string }).id);

    if (review.replyStatus === ReviewReplyStatus.PUBLISHED) {
      throw conflict('This review has already been answered on Google.');
    }

    const updated = await prisma.googleReview.update({
      where: { id: review.id },
      data: {
        replyText: (req.body as { text: string }).text,
        replyStatus: ReviewReplyStatus.PENDING_APPROVAL,
        replyApprovedById: actor.id,
        replyError: null,
      },
      select: { id: true, replyText: true, replyStatus: true, approvedBy: { select: { id: true, name: true } } },
    });

    await recordAudit({
      actor, action: 'google.review.approve', entity: 'GoogleReview', entityId: review.id, ip: req.ip,
    });
    res.json({ review: updated });
  }),
);

/**
 * Publish the approved reply to Google.
 *
 * Reads `replyText`, never `aiSuggestion`, and refuses unless the row is in
 * PENDING_APPROVAL. Those two lines are what stop a generated reply reaching a
 * customer without a person in between.
 */
googleRouter.post(
  '/reviews/:id/publish',
  requireAgency,
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);
    const review = await findReview(actor, (req.params as { id: string }).id);

    if (review.replyStatus === ReviewReplyStatus.PUBLISHED) {
      throw conflict('This review has already been answered on Google.');
    }
    if (review.replyStatus !== ReviewReplyStatus.PENDING_APPROVAL || !review.replyText?.trim()) {
      throw badRequest('This reply has not been approved yet. Approve the wording before publishing it.');
    }
    if (!review.location.accountName) {
      throw badRequest('This location has no Google account reference. Re-sync locations first.');
    }

    try {
      const { accessToken } = await accessTokenFor({
        prisma,
        organizationId: orgId(actor),
        clientId: review.location.clientId,
        fetchImpl,
      });

      const result = await publishReply({
        accessToken,
        accountName: review.location.accountName,
        locationName: review.location.externalName,
        reviewExternalId: review.externalId,
        comment: review.replyText,
        fetchImpl,
      });

      const updated = await prisma.googleReview.update({
        where: { id: review.id },
        data: {
          replyStatus: ReviewReplyStatus.PUBLISHED,
          repliedAt: result.updateTime ?? new Date(),
          replyError: null,
        },
        select: { id: true, replyStatus: true, replyText: true, repliedAt: true },
      });

      await recordAudit({
        actor, action: 'google.review.publish', entity: 'GoogleReview', entityId: review.id, ip: req.ip,
      });
      res.json({ review: updated });
    } catch (error) {
      if (error instanceof GoogleNotConnectedError) rethrow(error);

      // The failure is recorded on the row so the workspace can show it, and
      // the approved text is kept so a retry does not need a second approval.
      const message = (error as Error).message.slice(0, 500);
      await prisma.googleReview.update({
        where: { id: review.id },
        data: { replyStatus: ReviewReplyStatus.FAILED, replyError: message },
      });
      res.status(502).json({ error: { code: 'GOOGLE_REPLY_FAILED', message } });
    }
  }),
);

// ------------------------------------------------------------------ seo

googleRouter.get(
  '/seo/audit',
  validateQuery(z.object({ clientId: z.string().max(40).optional() })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const clientId = resolveClientId(actor, (req.query as { clientId?: string }).clientId);

    const locations = await prisma.googleLocation.findMany({
      where: { organizationId: orgId(actor), ...(clientId ? { clientId } : {}) },
      orderBy: { title: 'asc' },
    });

    res.json({
      locations: locations.map(auditLocation),
      nap: auditNap(locations),
      // Named rather than omitted, so a blank panel is never mistaken for
      // "no data yet" when the truth is "Google has no API for this".
      unsupported: unsupported(),
    });
  }),
);

// ------------------------------------------------------------- overview

/**
 * The Google overview.
 *
 * Every figure is counted from rows Google gave us, and the response says so
 * per metric via `source`. The average rating is a mean of real star ratings
 * and is null — not 0 — when there are no reviews to average, because a
 * restaurant with no reviews does not have a rating of zero.
 */
googleRouter.get(
  '/overview',
  validateQuery(z.object({ clientId: z.string().max(40).optional() })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const clientId = resolveClientId(actor, (req.query as { clientId?: string }).clientId);
    const where = { organizationId: orgId(actor), ...(clientId ? { clientId } : {}) };

    const since = new Date();
    since.setDate(since.getDate() - 30);

    const [locations, reviews, recent, aggregate, answered] = await Promise.all([
      prisma.googleLocation.count({ where }),
      prisma.googleReview.count({ where }),
      prisma.googleReview.count({ where: { ...where, createTime: { gte: since } } }),
      prisma.googleReview.aggregate({ where, _avg: { rating: true } }),
      prisma.googleReview.count({ where: { ...where, replyStatus: ReviewReplyStatus.PUBLISHED } }),
    ]);

    const clusters = clusterComplaints(
      await prisma.googleReview.findMany({
        where,
        select: { id: true, complaintKey: true, category: true, createTime: true },
      }),
    );

    const pending = await prisma.googleReview.count({
      where: { ...where, replyStatus: { in: [ReviewReplyStatus.SUGGESTED, ReviewReplyStatus.PENDING_APPROVAL] } },
    });

    res.json({
      // `source` on every figure, as the spec requires: an operator can see
      // which product a number came from without reading the code.
      locations: { value: locations, source: 'GOOGLE_BUSINESS_PROFILE' },
      reviews: { value: reviews, source: 'GOOGLE_BUSINESS_PROFILE' },
      newReviews30d: { value: recent, source: 'GOOGLE_BUSINESS_PROFILE' },
      averageRating: {
        // Null rather than 0: no reviews is not a rating of zero.
        value: reviews > 0 ? aggregate._avg.rating : null,
        source: 'GOOGLE_BUSINESS_PROFILE',
      },
      responseRate: {
        value: reviews > 0 ? answered / reviews : null,
        source: 'GOOGLE_BUSINESS_PROFILE',
      },
      awaitingReply: { value: pending, source: 'DERIVED' },
      repeatedComplaints: {
        value: clusters.map((cluster) => ({ key: cluster.key, count: cluster.count })),
        source: 'DERIVED',
      },
      /*
       * The products this phase does not cover, reported rather than absent.
       * A dashboard that silently omits Search Console reads as "no traffic";
       * one that says "not connected" reads as what it is.
       */
      notConnected: [
        { key: 'SEARCH_CONSOLE', title: 'Search Console', reason: 'Not connected in this phase.' },
        { key: 'GA4', title: 'Google Analytics 4', reason: 'Not connected in this phase.' },
        { key: 'GOOGLE_ADS', title: 'Google Ads', reason: 'Ads publishing exists; reporting is not connected in this phase.' },
      ],
    });
  }),
);

/** Whether Google is connected for this client, for the empty states. */
googleRouter.get(
  '/status',
  validateQuery(z.object({ clientId: z.string().max(40).optional() })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const clientId = resolveClientId(actor, (req.query as { clientId?: string }).clientId);

    const integration = clientId
      ? await prisma.integration.findFirst({
        where: { organizationId: orgId(actor), clientId, platform: Platform.GOOGLE_BUSINESS },
        select: {
          id: true, status: true, accountName: true, scopes: true, lastError: true,
          accessTokenEnc: true, refreshTokenEnc: true,
          accounts: { where: { selected: true }, select: { id: true, name: true, externalId: true } },
        },
      })
      : null;

    res.json({
      connected: Boolean(integration?.accessTokenEnc),
      status: integration?.status ?? null,
      accountName: integration?.accountName ?? null,
      // Booleans only — a token's presence is a fact the UI needs; its value is
      // never serialised, and `decryptSecret` is deliberately not called here.
      hasRefreshToken: Boolean(integration?.refreshTokenEnc),
      scopes: integration?.scopes ?? [],
      selectedAccounts: integration?.accounts ?? [],
      lastError: integration?.lastError ?? null,
    });
  }),
);

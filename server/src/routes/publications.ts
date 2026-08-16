/**
 * /api/publications — prepare, review, approve and publish an advertisement.
 *
 * The flow is deliberately three separate calls rather than one "publish"
 * button that does everything:
 *
 *   POST /            draft it
 *   GET  /:id/preview exactly what is about to be sent, in provider terms
 *   POST /:id/approve the human says yes
 *   POST /:id/publish it goes
 *
 * Publishing spends the client's money and creates objects in their ad account
 * that somebody then has to find and clean up. A single button that drafts,
 * approves and publishes in one request would make an accidental double-click a
 * second campaign.
 */

import { Router } from 'express';
import { Platform, Prisma, PublicationStatus } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest, notFound } from '../lib/errors.js';
import { actorOf, requireAgency, requireAuth } from '../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { idParam } from '../lib/http.js';
import { assertWritable, orgId, scopeWhere } from '../lib/scope.js';
import { recordAudit } from '../services/audit.js';
import { publishToMeta } from '../services/integrations/publish-flow.js';
import { storage } from '../services/storage/index.js';

export const publicationsRouter: Router = Router();
publicationsRouter.use(requireAuth);

/** Meta's outcome-era objectives. The old ones are rejected by the API now. */
const META_OBJECTIVES = [
  'OUTCOME_AWARENESS',
  'OUTCOME_TRAFFIC',
  'OUTCOME_ENGAGEMENT',
  'OUTCOME_LEADS',
  'OUTCOME_SALES',
  'OUTCOME_APP_PROMOTION',
] as const;

const draftSchema = z
  .object({
    clientId: z.string().min(1).max(40),
    platform: z.nativeEnum(Platform).default(Platform.FACEBOOK),
    creativeId: z.string().max(40).optional(),
    videoCreativeId: z.string().max(40).optional(),
    campaignId: z.string().max(40).optional(),
    productId: z.string().max(40).optional(),
    name: z.string().trim().min(1).max(120),
    objective: z.enum(META_OBJECTIVES),
    dailyBudget: z.number().positive().max(1_000_000),
    currency: z.string().trim().length(3),
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
    countries: z.array(z.string().trim().length(2)).min(1).max(25),
    linkUrl: z.string().url().max(2000),
    message: z.string().trim().min(1).max(2000),
    headline: z.string().trim().min(1).max(120),
    callToAction: z.string().trim().max(40).optional(),
  })
  .refine((body) => Boolean(body.creativeId) !== Boolean(body.videoCreativeId), {
    message: 'Attach exactly one of creativeId or videoCreativeId',
  })
  .refine((body) => body.endDate > body.startDate, { message: 'The end date must be after the start date' });

publicationsRouter.post(
  '/',
  requireAgency,
  validateBody(draftSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);
    const body = req.body as z.infer<typeof draftSchema>;

    const client = await prisma.client.findFirst({
      where: { id: body.clientId, organizationId: orgId(actor) },
      select: { id: true },
    });
    if (!client) throw notFound('Client');

    // The media must belong to this client — an id in a request body is not an
    // authorisation to publish somebody else's artwork.
    if (body.creativeId) {
      const creative = await prisma.creative.findFirst({
        where: { id: body.creativeId, clientId: body.clientId, ...scopeWhere(actor) },
        select: { id: true },
      });
      if (!creative) throw notFound('Creative');
    }
    if (body.videoCreativeId) {
      const video = await prisma.videoCreative.findFirst({
        where: { id: body.videoCreativeId, clientId: body.clientId, ...scopeWhere(actor) },
        select: { id: true },
      });
      if (!video) throw notFound('Video');
    }

    const publication = await prisma.adPublication.create({
      data: {
        organizationId: orgId(actor),
        clientId: body.clientId,
        campaignId: body.campaignId ?? null,
        productId: body.productId ?? null,
        creativeId: body.creativeId ?? null,
        videoCreativeId: body.videoCreativeId ?? null,
        platform: body.platform,
        name: body.name,
        objective: body.objective,
        dailyBudget: new Prisma.Decimal(body.dailyBudget),
        currency: body.currency.toUpperCase(),
        startDate: body.startDate,
        endDate: body.endDate,
        countries: body.countries.map((code) => code.toUpperCase()),
        linkUrl: body.linkUrl,
        message: body.message,
        headline: body.headline,
        callToAction: body.callToAction ?? null,
      },
    });

    res.status(201).json({ publication });
  }),
);

/**
 * Everything the operator is about to commit to, assembled in one place.
 *
 * This is the screen that stands between a draft and real money: the account it
 * will run under, the creative, the budget and the audience, plus anything that
 * would block the publish. Blockers are reported here rather than discovered
 * halfway through a sequence that has already created a campaign.
 */
publicationsRouter.get(
  '/:id/preview',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);

    const publication = await prisma.adPublication.findFirst({
      where: { id: req.params.id, ...scopeWhere(actor) },
      include: { client: { select: { id: true, name: true, businessName: true } } },
    });
    if (!publication) throw notFound('Publication');

    const integration = await prisma.integration.findFirst({
      where: { clientId: publication.clientId, platform: { in: [Platform.FACEBOOK, Platform.INSTAGRAM] } },
      include: { accounts: { where: { selected: true }, select: { kind: true, name: true, externalId: true } } },
    });

    const creative = publication.creativeId
      ? await prisma.creative.findUnique({
          where: { id: publication.creativeId },
          select: { id: true, preset: true, width: true, height: true, format: true, storageKey: true },
        })
      : null;

    const video = publication.videoCreativeId
      ? await prisma.videoCreative.findUnique({
          where: { id: publication.videoCreativeId },
          select: { id: true, placement: true, width: true, height: true, durationSeconds: true, storageKey: true },
        })
      : null;

    const storageKey = video?.storageKey ?? creative?.storageKey ?? null;
    const mediaPresent = storageKey && storage.exists ? await storage.exists(storageKey) : null;

    const blockers: string[] = [];
    if (!integration) blockers.push('This client is not connected to Meta.');
    else if (integration.status !== 'CONNECTED') blockers.push(`The Meta connection is ${integration.status.toLowerCase()}.`);
    if (integration && !integration.accounts.some((account) => account.kind === 'AD_ACCOUNT')) {
      blockers.push('No Meta ad account has been selected for this client.');
    }
    if (integration && !integration.accounts.some((account) => account.kind === 'PAGE')) {
      blockers.push('No Facebook Page has been selected for this client.');
    }
    if (mediaPresent === false) blockers.push('The media for this advertisement is no longer in storage.');
    if (publication.status === PublicationStatus.PUBLISHED) blockers.push('This advertisement has already been published.');

    res.json({
      publication,
      client: publication.client,
      account: {
        connection: integration?.status ?? 'DISCONNECTED',
        accountName: integration?.accountName ?? null,
        selected: integration?.accounts ?? [],
      },
      creative: creative ?? video,
      mediaKind: video ? 'VIDEO' : creative ? 'IMAGE' : null,
      mediaPresent,
      budget: {
        daily: Number(publication.dailyBudget),
        currency: publication.currency,
        // Stated explicitly because it is the number that surprises people.
        estimatedTotal: Number(
          (
            Number(publication.dailyBudget) *
            Math.max(
              1,
              Math.ceil((publication.endDate.getTime() - publication.startDate.getTime()) / (24 * 60 * 60 * 1000)),
            )
          ).toFixed(2),
        ),
      },
      audience: { countries: publication.countries },
      readyToPublish: blockers.length === 0 && publication.status === PublicationStatus.APPROVED,
      blockers,
      confirmation:
        'You are about to publish this advertisement. It will be created in the connected Meta ad account, paused, and will spend the daily budget above once you activate it in Ads Manager.',
    });
  }),
);

publicationsRouter.post(
  '/:id/approve',
  requireAgency,
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);

    const existing = await prisma.adPublication.findFirst({
      where: { id: req.params.id, ...scopeWhere(actor) },
      select: { id: true, status: true },
    });
    if (!existing) throw notFound('Publication');
    if (existing.status === PublicationStatus.PUBLISHED) {
      throw badRequest('This advertisement has already been published.');
    }

    const publication = await prisma.adPublication.update({
      where: { id: existing.id },
      data: { status: PublicationStatus.APPROVED },
    });

    await recordAudit({
      actor, action: 'publication.approve', entity: 'AdPublication', entityId: publication.id, ip: req.ip,
    });
    res.json({ publication });
  }),
);

/**
 * Publish.
 *
 * A provider failure comes back 200 with the failed row rather than as an HTTP
 * error: the attempt is a result the operator needs to read, carrying Meta's own
 * message, the HTTP status and every step that did succeed — including the
 * campaign and ad set that now exist in their account.
 */
publicationsRouter.post(
  '/:id/publish',
  requireAgency,
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);

    const publication = await publishToMeta({
      publicationId: req.params.id as string,
      organizationId: orgId(actor),
      fetchImpl: fetch as unknown as Parameters<typeof publishToMeta>[0]['fetchImpl'],
    });

    await recordAudit({
      actor,
      action: 'publication.publish',
      entity: 'AdPublication',
      entityId: publication.id,
      meta: { status: publication.status, providerAdId: publication.providerAdId },
      ip: req.ip,
    });

    res.status(publication.status === PublicationStatus.PUBLISHED ? 200 : 502).json({
      publication,
      published: publication.status === PublicationStatus.PUBLISHED,
      // Never fabricated: null unless Meta returned one.
      providerIds: {
        campaign: publication.providerCampaignId,
        adSet: publication.providerAdSetId,
        creative: publication.providerCreativeId,
        ad: publication.providerAdId,
      },
      managerUrl: publication.managerUrl,
      error:
        publication.status === PublicationStatus.PUBLISHED
          ? null
          : { message: publication.errorMessage, status: publication.errorStatus, retryable: publication.status === PublicationStatus.FAILED },
    });
  }),
);

publicationsRouter.get(
  '/',
  validateQuery(
    z.object({
      clientId: z.string().max(40).optional(),
      campaignId: z.string().max(40).optional(),
      status: z.nativeEnum(PublicationStatus).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const query = req.query as { clientId?: string; campaignId?: string; status?: PublicationStatus };

    const publications = await prisma.adPublication.findMany({
      where: {
        ...scopeWhere(actor),
        ...(query.clientId ? { clientId: query.clientId } : {}),
        ...(query.campaignId ? { campaignId: query.campaignId } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    res.json({ publications });
  }),
);

publicationsRouter.get(
  '/:id',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const publication = await prisma.adPublication.findFirst({
      where: { id: req.params.id, ...scopeWhere(actor) },
    });
    if (!publication) throw notFound('Publication');
    res.json({ publication });
  }),
);

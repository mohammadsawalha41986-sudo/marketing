/**
 * /api/creatives — render, score, store and download post artwork.
 *
 * Ownership is resolved through the source media's own client on every route,
 * so a creative can only ever be built from, or downloaded by, the tenant that
 * owns the asset. There is no path here that takes a client id from the caller.
 */

import { Router } from 'express';
import { CreativeFormat, CreativeStatus, MediaType, Platform, Prisma } from '@prisma/client';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';

import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest, notFound } from '../lib/errors.js';
import { actorOf, requireAgency, requireAuth } from '../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { idParam } from '../lib/http.js';
import { assertWritable, orgId, scopeWhere } from '../lib/scope.js';
import { storage } from '../services/storage/index.js';
import { recordAudit } from '../services/audit.js';
import { PRESETS, defaultPresetFor, presetByKey, type CreativePreset } from '../services/creative/presets.js';
import { renderCreative, type BrandTreatment } from '../services/creative/render.js';
import { scoreCreative } from '../services/creative/match.js';

export const creativesRouter: Router = Router();
creativesRouter.use(requireAuth);

/** The preset catalogue, so the UI never hardcodes platform dimensions. */
creativesRouter.get('/presets', (_req, res) => {
  res.json({
    presets: PRESETS.map((preset) => ({
      key: preset.key,
      platform: preset.platform,
      label: preset.label,
      width: preset.width,
      height: preset.height,
      aspect: Number((preset.width / preset.height).toFixed(4)),
    })),
  });
});

const MEDIA_SELECT = {
  id: true,
  clientId: true,
  organizationId: true,
  type: true,
  filename: true,
  originalName: true,
  mimeType: true,
  sizeBytes: true,
  width: true,
  height: true,
  url: true,
  tags: true,
  category: true,
} satisfies Prisma.MediaSelect;

/**
 * Load the source asset and everything the score and the render need, all
 * pinned to the caller's tenant in a single query.
 */
async function loadContext(actor: ReturnType<typeof actorOf>, mediaId: string, campaignId?: string, contentId?: string) {
  const media = await prisma.media.findFirst({
    where: { id: mediaId, ...scopeWhere(actor) },
    select: MEDIA_SELECT,
  });
  if (!media) throw notFound('Media');
  if (media.type !== MediaType.IMAGE) throw badRequest('Creatives can only be rendered from an image asset');
  if (!media.clientId) throw badRequest('This asset is not attached to a client, so it has no brand to render with');

  const [client, campaign, content] = await Promise.all([
    prisma.client.findFirst({
      where: { id: media.clientId, organizationId: orgId(actor) },
      select: { id: true, name: true, businessName: true, brand: true },
    }),
    campaignId
      ? prisma.campaign.findFirst({
          where: { id: campaignId, ...scopeWhere(actor) },
          select: { id: true, clientId: true, name: true, offer: true, products: true, targetAudience: true, objective: true, ctaLabel: true },
        })
      : Promise.resolve(null),
    contentId
      ? prisma.content.findFirst({
          where: { id: contentId, ...scopeWhere(actor) },
          select: { id: true, clientId: true, headline: true, platform: true },
        })
      : Promise.resolve(null),
  ]);

  if (!client) throw notFound('Client');
  // A campaign or content item from a different client would silently render
  // one tenant's copy onto another's asset.
  if (campaignId && !campaign) throw notFound('Campaign');
  if (campaign && campaign.clientId !== media.clientId) throw badRequest('That campaign belongs to a different client');
  if (contentId && !content) throw notFound('Content');
  if (content && content.clientId !== media.clientId) throw badRequest('That content belongs to a different client');

  return { media, client, campaign, content };
}

function treatmentFor(client: { name: string; businessName: string; brand: { primaryColor: string; accentColor: string; textColor: string; logoUrl: string | null } | null }): BrandTreatment {
  return {
    name: client.businessName || client.name,
    primaryColor: client.brand?.primaryColor ?? '#6366F1',
    accentColor: client.brand?.accentColor ?? '#22D3EE',
    textColor: client.brand?.textColor ?? '#E8EBF2',
    logoUrl: client.brand?.logoUrl ?? null,
  };
}

/** Read the source bytes back out of the storage provider. */
async function readSource(key: string): Promise<Buffer> {
  const path = storage.localPath(key);
  if (!path) {
    // A remote driver would fetch here; local is the only driver today and the
    // failure must be explicit rather than a silent empty buffer.
    throw badRequest(`Storage driver "${storage.name}" cannot read objects back for rendering`);
  }
  return readFile(path);
}

const analyseSchema = z.object({
  mediaId: z.string().min(1).max(40),
  campaignId: z.string().max(40).optional(),
  contentId: z.string().max(40).optional(),
  presetKey: z.string().max(40).optional(),
  platform: z.nativeEnum(Platform).optional(),
  headline: z.string().max(300).nullish(),
  ctaLabel: z.string().max(120).nullish(),
});

function resolvePreset(input: { presetKey?: string; platform?: Platform }): CreativePreset {
  if (input.presetKey) {
    const preset = presetByKey(input.presetKey);
    if (!preset) throw badRequest(`Unknown creative preset: ${input.presetKey}`);
    return preset;
  }
  return defaultPresetFor(input.platform ?? Platform.INSTAGRAM);
}

/** Score an asset for a placement without rendering or storing anything. */
creativesRouter.post(
  '/analyze',
  validateBody(analyseSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const body = req.body as z.infer<typeof analyseSchema>;
    const { media, client, campaign } = await loadContext(actor, body.mediaId, body.campaignId, body.contentId);
    const preset = resolvePreset(body);

    res.json({
      preset: { key: preset.key, label: preset.label, width: preset.width, height: preset.height, platform: preset.platform },
      match: scoreCreative({
        media,
        brand: client.brand,
        campaign,
        preset,
        headline: body.headline,
        ctaLabel: body.ctaLabel ?? campaign?.ctaLabel,
      }),
    });
  }),
);

const renderSchema = analyseSchema.extend({
  presetKeys: z.array(z.string().max(40)).min(1).max(10).optional(),
  format: z.nativeEnum(CreativeFormat).default(CreativeFormat.PNG),
});

/**
 * Render one creative per requested preset, store each, and persist a row.
 *
 * Variants are separate rows rather than one row with sizes attached: each has
 * its own crop, its own burned-in copy and its own score, and each is
 * downloaded, approved and superseded on its own.
 */
creativesRouter.post(
  '/',
  requireAgency,
  validateBody(renderSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);
    const body = req.body as z.infer<typeof renderSchema>;

    const { media, client, campaign, content } = await loadContext(actor, body.mediaId, body.campaignId, body.contentId);

    const presets = body.presetKeys
      ? body.presetKeys.map((key) => {
          const preset = presetByKey(key);
          if (!preset) throw badRequest(`Unknown creative preset: ${key}`);
          return preset;
        })
      : [resolvePreset(body)];

    const source = await readSource(media.filename);
    const brand = treatmentFor(client);
    const headline = body.headline ?? content?.headline ?? null;
    const ctaLabel = body.ctaLabel ?? campaign?.ctaLabel ?? null;

    const created = [];
    for (const preset of presets) {
      const match = scoreCreative({ media, brand: client.brand, campaign, preset, headline, ctaLabel });

      const rendered = await renderCreative({ source, preset, brand, headline, ctaLabel, format: body.format });

      // Stored under the client's own prefix, which keeps one tenant's rendered
      // artwork out of another's folder even at the storage layer.
      const stored = await storage.save(rendered.buffer, {
        filename: `${preset.key.toLowerCase()}.${rendered.extension}`,
        mimeType: rendered.mimeType,
        prefix: `clients/${media.clientId}/creatives`,
      });

      created.push(
        await prisma.creative.create({
          data: {
            organizationId: orgId(actor),
            clientId: media.clientId!,
            contentId: content?.id ?? null,
            campaignId: campaign?.id ?? null,
            sourceMediaId: media.id,
            platform: preset.platform,
            preset: preset.key,
            width: rendered.width,
            height: rendered.height,
            format: body.format,
            storageKey: stored.key,
            url: stored.url,
            sizeBytes: stored.sizeBytes,
            headline,
            ctaLabel,
            match: match as unknown as Prisma.InputJsonValue,
          },
        }),
      );
    }

    await recordAudit({
      actor,
      action: 'creative.render',
      entity: 'Creative',
      meta: { count: created.length, mediaId: media.id, presets: presets.map((p) => p.key) },
      ip: req.ip,
    });

    res.status(201).json({ creatives: created });
  }),
);

creativesRouter.get(
  '/',
  validateQuery(
    z.object({
      contentId: z.string().max(40).optional(),
      campaignId: z.string().max(40).optional(),
      sourceMediaId: z.string().max(40).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const query = req.query as { contentId?: string; campaignId?: string; sourceMediaId?: string };

    const creatives = await prisma.creative.findMany({
      where: {
        ...scopeWhere(actor),
        ...(query.contentId ? { contentId: query.contentId } : {}),
        ...(query.campaignId ? { campaignId: query.campaignId } : {}),
        ...(query.sourceMediaId ? { sourceMediaId: query.sourceMediaId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({ creatives });
  }),
);

creativesRouter.get(
  '/:id',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const creative = await prisma.creative.findFirst({
      where: { id: req.params.id, ...scopeWhere(actor) },
      include: { sourceMedia: { select: { id: true, originalName: true, url: true, width: true, height: true } } },
    });
    if (!creative) throw notFound('Creative');
    res.json({ creative });
  }),
);

/**
 * Download the rendered artwork.
 *
 * This streams the *rendered* file — the one carrying the headline, brand
 * treatment and CTA at the platform's dimensions — never the source upload.
 * When the requested format differs from the stored one it is transcoded from
 * the rendered artwork, so a JPG download is still the finished creative.
 */
creativesRouter.get(
  '/:id/download',
  validateParams(idParam),
  validateQuery(z.object({ format: z.nativeEnum(CreativeFormat).optional() })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const query = req.query as { format?: CreativeFormat };

    const creative = await prisma.creative.findFirst({
      where: { id: req.params.id, ...scopeWhere(actor) },
      include: { client: { select: { name: true } } },
    });
    if (!creative) throw notFound('Creative');

    const stored = await readSource(creative.storageKey);
    const wanted = query.format ?? creative.format;

    let buffer = stored;
    let mimeType = creative.format === CreativeFormat.JPG ? 'image/jpeg' : 'image/png';
    let extension = creative.format === CreativeFormat.JPG ? 'jpg' : 'png';

    if (wanted !== creative.format) {
      const sharp = (await import('sharp')).default;
      buffer =
        wanted === CreativeFormat.JPG
          ? await sharp(stored).jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer()
          : await sharp(stored).png({ compressionLevel: 9 }).toBuffer();
      mimeType = wanted === CreativeFormat.JPG ? 'image/jpeg' : 'image/png';
      extension = wanted === CreativeFormat.JPG ? 'jpg' : 'png';
    }

    const slug = `${creative.client.name}-${creative.preset}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', String(buffer.byteLength));
    res.setHeader('Content-Disposition', `attachment; filename="${slug}.${extension}"`);
    res.setHeader('X-Creative-Id', creative.id);
    res.setHeader('X-Creative-Dimensions', `${creative.width}x${creative.height}`);
    // Rendered artwork is tenant data, never a shared cache entry.
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buffer);
  }),
);

creativesRouter.patch(
  '/:id',
  requireAgency,
  validateParams(idParam),
  validateBody(z.object({ status: z.nativeEnum(CreativeStatus) })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);

    const existing = await prisma.creative.findFirst({
      where: { id: req.params.id, ...scopeWhere(actor) },
      select: { id: true },
    });
    if (!existing) throw notFound('Creative');

    const creative = await prisma.creative.update({
      where: { id: existing.id },
      data: { status: (req.body as { status: CreativeStatus }).status },
    });

    await recordAudit({
      actor, action: 'creative.status', entity: 'Creative', entityId: creative.id,
      meta: { status: creative.status }, ip: req.ip,
    });
    res.json({ creative });
  }),
);

creativesRouter.delete(
  '/:id',
  requireAgency,
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);

    const existing = await prisma.creative.findFirst({
      where: { id: req.params.id, ...scopeWhere(actor) },
      select: { id: true, storageKey: true },
    });
    if (!existing) throw notFound('Creative');

    await prisma.creative.delete({ where: { id: existing.id } });
    // The source asset is deliberately untouched — deleting a rendered variant
    // must never destroy the photograph it was made from.
    await storage.delete(existing.storageKey).catch(() => undefined);

    await recordAudit({ actor, action: 'creative.delete', entity: 'Creative', entityId: existing.id, ip: req.ip });
    res.json({ ok: true });
  }),
);

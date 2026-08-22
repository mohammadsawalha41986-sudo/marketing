/**
 * /api/creatives — render, score, store and download post artwork.
 *
 * Ownership is resolved through the source media's own client on every route,
 * so a creative can only ever be built from, or downloaded by, the tenant that
 * owns the asset. There is no path here that takes a client id from the caller.
 */

import { Router } from 'express';
import { CreativeFormat, CreativeSource, CreativeStatus, MediaType, Platform, Prisma } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest, notFound } from '../lib/errors.js';
import { actorOf, requireAgency, requireAuth } from '../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { idParam } from '../lib/http.js';
import { assertWritable, orgId, resolveClientId, scopeWhere } from '../lib/scope.js';
import { storage } from '../services/storage/index.js';
import {
  creativeFileUrl,
  deleteObjectIfUnreferenced,
  readObject,
  sendObject,
  withMediaUrls,
} from '../services/storage/objects.js';
import { recordAudit } from '../services/audit.js';
import { PRESETS, defaultPresetFor, presetByKey, type CreativePreset } from '../services/creative/presets.js';
import { renderCreative, type BrandTreatment } from '../services/creative/render.js';
import { scoreCreative } from '../services/creative/match.js';
import { inspectMedia } from '../services/creative/inspect.js';
import { specsFor, validateCreative } from '../services/creative/specs.js';
import { uploadAny } from '../middleware/upload.js';

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

/**
 * Turn an image-decoding failure into an answer the operator can act on.
 *
 * sharp raises libvips errors like `vipspng: libpng read error` for a file that
 * passed the magic-number check but is truncated or malformed inside. Left
 * unhandled that becomes a 500, which reads as "the renderer is broken" when in
 * fact the input was.
 */
function asDecodeError(error: unknown): never {
  const message = (error as Error).message ?? '';
  if (/vips|libpng|jpeg|heif|magick|unsupported image format|Input buffer/i.test(message)) {
    throw badRequest(
      'That image could not be decoded. It may be truncated or corrupt — re-export it and upload it again.',
    );
  }
  throw error;
}

/**
 * Point a creative's `url` at the authenticated proxy route.
 *
 * The column holds whatever the driver returned when the object was written —
 * a bucket URL under S3, a `/uploads` path under the disk driver — and neither
 * is something a browser should be sent to. The bucket is private, and the
 * `/uploads` path only resolves on a machine that still has the file.
 */
function withCreativeUrl<T extends { id: string; url: string }>(creative: T): T {
  return { ...creative, url: creativeFileUrl(creative.id) };
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


// ---------------------------------------------------------------- uploaded

/**
 * Bring in a finished advertisement.
 *
 * This is the product's primary path and the inverse of `POST /` below: the
 * operator made the ad in Canva, Photoshop, CapCut or on their phone, and this
 * accepts it *as the ad*. Nothing is rendered, resized, cropped or re-encoded.
 * The bytes stored are the bytes uploaded, and the sha256 recorded is of those
 * exact bytes, so what runs on Meta is provably what was approved here.
 *
 * The upload becomes two rows: a `Media` row holding the file and everything
 * measured from it, and a `Creative` row with `source = UPLOADED` pointing at
 * it. They are separate because a creative can later gain variants, campaign
 * links and a performance history, while the file underneath stays untouched.
 */
creativesRouter.post(
  '/upload',
  requireAgency,
  uploadAny.single('file'),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);

    const file = req.file;
    if (!file) throw badRequest('No file uploaded. Send it as multipart field "file".');

    const clientId = resolveClientId(actor, typeof req.body.clientId === 'string' ? req.body.clientId : undefined);
    if (!clientId) throw badRequest('An uploaded advertisement belongs to one restaurant. Choose one first.');

    const client = await prisma.client.findFirst({
      where: { id: clientId, organizationId: orgId(actor) },
      select: { id: true },
    });
    if (!client) throw notFound('Client');

    // Measured from the bytes, never from the multipart headers.
    const inspected = await inspectMedia(file.buffer, file.mimetype);

    /*
     * The same file, uploaded twice, is one asset.
     *
     * Content-addressed storage already collapses the objects; without this the
     * library would still grow a second row pointing at the same bytes every
     * time somebody re-uploaded, and "which of these four identical thumbnails
     * is the live one" is a question nobody should have to answer.
     */
    const duplicate = await prisma.media.findFirst({
      where: { organizationId: orgId(actor), clientId, sha256: inspected.sha256 },
      select: { id: true, originalName: true, createdAt: true },
    });

    const stored = await storage.save(file.buffer, {
      filename: file.originalname,
      mimeType: file.mimetype,
      prefix: `clients/${clientId}/assets`,
    });

    const media = duplicate
      ? await prisma.media.findUniqueOrThrow({ where: { id: duplicate.id } })
      : await prisma.media.create({
          data: {
            organizationId: orgId(actor),
            clientId,
            type: inspected.kind === 'VIDEO' ? MediaType.VIDEO : MediaType.IMAGE,
            filename: stored.key,
            originalName: file.originalname.slice(0, 200),
            mimeType: file.mimetype,
            sizeBytes: stored.sizeBytes,
            width: inspected.width,
            height: inspected.height,
            url: stored.url,
            thumbnailUrl: inspected.kind === 'IMAGE' ? stored.url : null,
            sha256: inspected.sha256,
            durationSeconds: inspected.durationSeconds,
            frameRate: inspected.frameRate,
            videoCodec: inspected.videoCodec,
            audioCodec: inspected.audioCodec,
            bitrateKbps: inspected.bitrateKbps,
            hasAudio: inspected.hasAudio,
          },
        });

    const creative = await prisma.creative.create({
      data: {
        organizationId: orgId(actor),
        clientId,
        source: CreativeSource.UPLOADED,
        mediaId: media.id,
        // No source asset and no preset: the file is not derived from anything
        // here, and it has whatever shape the operator gave it.
        sourceMediaId: null,
        preset: 'UPLOADED',
        platform: (typeof req.body.platform === 'string' ? req.body.platform : Platform.FACEBOOK) as Platform,
        width: inspected.width ?? 0,
        height: inspected.height ?? 0,
        format: inspected.kind === 'IMAGE' && inspected.format === 'jpeg' ? CreativeFormat.JPG : CreativeFormat.PNG,
        storageKey: stored.key,
        url: stored.url,
        sizeBytes: stored.sizeBytes,
        headline: typeof req.body.headline === 'string' ? req.body.headline.slice(0, 300) : null,
        ctaLabel: typeof req.body.ctaLabel === 'string' ? req.body.ctaLabel.slice(0, 120) : null,
        // Nothing was composed and nothing was scored against a preset, so both
        // stay empty rather than carrying numbers that were never measured.
        match: {},
        composition: {},
      },
    });

    await recordAudit({
      actor,
      action: 'creative.upload',
      entity: 'Creative',
      entityId: creative.id,
      meta: { mediaId: media.id, kind: inspected.kind, duplicate: Boolean(duplicate) },
      ip: req.ip,
    });

    res.status(201).json({
      creative: withCreativeUrl(creative),
      media: withMediaUrls(media),
      inspected,
      // Immediately useful: the operator wants to know where this can run.
      validation: validateCreative({
        kind: inspected.kind,
        mimeType: file.mimetype,
        sizeBytes: inspected.sizeBytes,
        width: inspected.width,
        height: inspected.height,
        aspectRatio: inspected.aspectRatio,
        durationSeconds: inspected.durationSeconds,
        measured: inspected.measured,
      }),
      duplicateOf: duplicate ? { id: duplicate.id, originalName: duplicate.originalName, uploadedAt: duplicate.createdAt } : null,
    });
  }),
);

/** The placement catalogue, so nothing downstream hardcodes a platform limit. */
creativesRouter.get('/specs', (req, res) => {
  const platform = (req.query as { platform?: Platform }).platform;
  res.json({ specs: specsFor(platform) });
});

/**
 * Where can this creative actually run?
 *
 * Re-measured from the stored bytes rather than trusted from the row, so a
 * creative validated today reflects the file that is in the bucket today.
 */
creativesRouter.get(
  '/:id/validate',
  validateParams(idParam),
  validateQuery(z.object({ platform: z.nativeEnum(Platform).optional() })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);

    const creative = await prisma.creative.findFirst({
      where: { id: req.params.id, ...scopeWhere(actor) },
      include: { media: true, sourceMedia: true },
    });
    if (!creative) throw notFound('Creative');

    const asset = creative.media ?? creative.sourceMedia;
    const bytes = await readObject(creative.storageKey);
    const inspected = await inspectMedia(bytes, asset?.mimeType ?? 'image/png');

    res.json({
      creative: { id: creative.id, source: creative.source, platform: creative.platform },
      inspected,
      validation: validateCreative(
        {
          kind: inspected.kind,
          mimeType: asset?.mimeType ?? 'image/png',
          sizeBytes: inspected.sizeBytes,
          width: inspected.width,
          height: inspected.height,
          aspectRatio: inspected.aspectRatio,
          durationSeconds: inspected.durationSeconds,
          measured: inspected.measured,
        },
        (req.query as { platform?: Platform }).platform,
      ),
    });
  }),
);

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

    const source = await readObject(media.filename);
    const brand = treatmentFor(client);
    const headline = body.headline ?? content?.headline ?? null;
    const ctaLabel = body.ctaLabel ?? campaign?.ctaLabel ?? null;

    const created = [];
    for (const preset of presets) {
      const match = scoreCreative({ media, brand: client.brand, campaign, preset, headline, ctaLabel });

      const rendered = await renderCreative({ source, preset, brand, headline, ctaLabel, format: body.format }).catch(
        asDecodeError,
      );

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
            composition: rendered.composition as unknown as Prisma.InputJsonValue,
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

    res.status(201).json({ creatives: created.map(withCreativeUrl) });
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
    res.json({ creatives: creatives.map(withCreativeUrl) });
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
    res.json({
      creative: {
        ...withCreativeUrl(creative),
        sourceMedia: creative.sourceMedia ? withMediaUrls(creative.sourceMedia) : null,
      },
    });
  }),
);

/**
 * The rendered artwork, inline.
 *
 * Separate from `/download` because a preview and a download are different
 * things: this one carries no attachment disposition, so the studio can show the
 * finished creative in an <img> without the browser trying to save it. Both read
 * the same stored object through the same tenant check.
 */
creativesRouter.get(
  '/:id/file',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const creative = await prisma.creative.findFirst({
      where: { id: req.params.id, ...scopeWhere(actor) },
      select: { storageKey: true, format: true, preset: true },
    });
    if (!creative) throw notFound('Creative');

    const buffer = await readObject(creative.storageKey);
    const jpg = creative.format === CreativeFormat.JPG;
    sendObject(res, buffer, {
      mimeType: jpg ? 'image/jpeg' : 'image/png',
      filename: `${creative.preset.toLowerCase()}.${jpg ? 'jpg' : 'png'}`,
    });
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

    const stored = await readObject(creative.storageKey);
    const wanted = query.format ?? creative.format;

    let buffer = stored;
    let mimeType = creative.format === CreativeFormat.JPG ? 'image/jpeg' : 'image/png';
    let extension = creative.format === CreativeFormat.JPG ? 'jpg' : 'png';

    if (wanted !== creative.format) {
      const sharp = (await import('sharp')).default;
      buffer = await (wanted === CreativeFormat.JPG
        ? sharp(stored).jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer()
        : sharp(stored).png({ compressionLevel: 9 }).toBuffer()
      ).catch(asDecodeError);
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
    // Only if no other row shares these bytes — a re-render of the same source
    // at the same placement is content-addressed to the same object.
    await deleteObjectIfUnreferenced(existing.storageKey);

    await recordAudit({ actor, action: 'creative.delete', entity: 'Creative', entityId: existing.id, ip: req.ip });
    res.json({ ok: true });
  }),
);

/**
 * /api/videos — render, store, preview and download video advertisements.
 *
 * The route reports FFmpeg as a *capability*. A deployment without it answers
 * 503 VIDEO_UNAVAILABLE and says why, rather than failing somewhere inside a
 * render after the operator has waited thirty seconds. Same principle as
 * storage: a missing dependency is a state the product describes, not a crash it
 * discovers.
 *
 * Rendering is synchronous. A fifteen-second vertical video takes tens of
 * seconds, which is a long request but a short wait, and a job queue would need
 * a worker, a broker and a status-polling UI to save an operator from watching a
 * spinner once. That trade is worth revisiting when several clients render at
 * once; it is not worth paying for now, and the timeout is bounded in ffmpeg.ts
 * so a pathological input cannot pin a worker.
 */

import { Router } from 'express';
import { AudioSource, CreativeStatus, MediaType, Prisma } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { AppError, asyncHandler, badRequest, notFound } from '../lib/errors.js';
import { actorOf, requireAgency, requireAuth } from '../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { idParam } from '../lib/http.js';
import { assertWritable, orgId, scopeWhere } from '../lib/scope.js';
import { storage } from '../services/storage/index.js';
import { deleteObjectIfUnreferenced, readObject, sendObject } from '../services/storage/objects.js';
import { recordAudit } from '../services/audit.js';
import { ffmpegCapability } from '../services/video/ffmpeg.js';
import { VIDEO_PLACEMENTS, videoPlacementByKey } from '../services/video/placements.js';
import { buildScript, type Scene } from '../services/video/script.js';
import { renderVideo, type AudioTrack } from '../services/video/render.js';
import type { BrandTreatment } from '../services/creative/render.js';
import type { ProductForCopy } from '../services/product/copy.js';

export const videosRouter: Router = Router();
videosRouter.use(requireAuth);

const videoUnavailable = (reason: string) => new AppError(503, 'VIDEO_UNAVAILABLE', reason);

/** The placement catalogue, so the UI never hardcodes video dimensions. */
videosRouter.get(
  '/placements',
  asyncHandler(async (_req, res) => {
    const capability = await ffmpegCapability();
    res.json({
      capability,
      placements: VIDEO_PLACEMENTS.map((placement) => ({
        key: placement.key,
        platform: placement.platform,
        label: placement.label,
        width: placement.width,
        height: placement.height,
        aspect: Number((placement.width / placement.height).toFixed(4)),
        defaultDurationSeconds: placement.defaultDurationSeconds,
        safeArea: placement.safeArea,
      })),
    });
  }),
);

const sceneSchema = z.object({
  kind: z.enum(['HOOK', 'PRODUCT', 'BENEFIT', 'OFFER', 'CTA']),
  text: z.string().trim().min(1).max(200),
  subtext: z.string().trim().max(120).nullish(),
  durationSeconds: z.number().min(1).max(10),
  motion: z.enum(['ZOOM_IN', 'ZOOM_OUT', 'PAN_LEFT', 'PAN_RIGHT', 'STATIC']),
});

const renderSchema = z.object({
  productId: z.string().max(40).optional(),
  mediaIds: z.array(z.string().max(40)).max(8).optional(),
  campaignId: z.string().max(40).optional(),
  placementKeys: z.array(z.string().max(40)).min(1).max(4),
  targetSeconds: z.number().min(5).max(60).default(15),
  /** Supply to override the generated script entirely. Every line is editable. */
  scenes: z.array(sceneSchema).min(1).max(8).optional(),
  audioMediaId: z.string().max(40).optional(),
  audioVolume: z.number().min(0).max(2).optional(),
  audioTrimStartSeconds: z.number().min(0).max(600).optional(),
  audioFadeInSeconds: z.number().min(0).max(10).optional(),
  audioFadeOutSeconds: z.number().min(0).max(10).optional(),
});

/**
 * Build the script for a product, or return the operator's edited one.
 *
 * A supplied script wins outright — this is the "all text must be editable"
 * requirement, and honouring it half way (regenerating one scene, keeping
 * another) would make edits mysteriously revert.
 */
function scriptFor(input: {
  scenes?: z.infer<typeof sceneSchema>[];
  product: ProductForCopy | null;
  targetSeconds: number;
}): { scenes: Scene[]; omitted: string[] } {
  if (input.scenes) {
    return {
      scenes: input.scenes.map((scene) => ({ ...scene, subtext: scene.subtext ?? null, from: ['operator'] })),
      omitted: [],
    };
  }
  if (!input.product) {
    throw badRequest('Supply either a productId to generate a script from, or the scenes to render');
  }
  const built = buildScript(input.product, input.targetSeconds);
  return { scenes: built.scenes, omitted: built.omitted };
}

videosRouter.post(
  '/',
  requireAgency,
  validateBody(renderSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);
    const body = req.body as z.infer<typeof renderSchema>;

    const capability = await ffmpegCapability();
    if (!capability.available) throw videoUnavailable(capability.reason ?? 'Video rendering is unavailable');

    const placements = body.placementKeys.map((key) => {
      const placement = videoPlacementByKey(key);
      if (!placement) throw badRequest(`Unknown video placement: ${key}`);
      return placement;
    });

    // ------------------------------------------------------ resolve the inputs
    const product = body.productId
      ? await prisma.product.findFirst({ where: { id: body.productId, ...scopeWhere(actor) } })
      : null;
    if (body.productId && !product) throw notFound('Product');

    const clientId = product?.clientId ?? null;

    const mediaIds = body.mediaIds ?? (product ? [product.mainMediaId, ...product.galleryMediaIds].filter((id): id is string => Boolean(id)) : []);
    if (mediaIds.length === 0) {
      throw badRequest('This product has no imagery to build a video from. Upload an image or import one first.');
    }

    const media = await prisma.media.findMany({
      where: { id: { in: mediaIds }, ...scopeWhere(actor), type: MediaType.IMAGE },
      select: { id: true, clientId: true, filename: true },
    });
    if (media.length === 0) throw notFound('Media');

    // Ordered as the caller asked, not as the database returned them.
    const ordered = mediaIds.map((id) => media.find((item) => item.id === id)).filter((item): item is (typeof media)[number] => Boolean(item));

    const resolvedClientId = clientId ?? ordered[0]?.clientId ?? null;
    if (!resolvedClientId) throw badRequest('The source imagery is not attached to a client');
    // One video cannot be built from two clients' assets.
    if (ordered.some((item) => item.clientId !== resolvedClientId)) {
      throw badRequest('All source imagery must belong to the same client');
    }

    const client = await prisma.client.findFirst({
      where: { id: resolvedClientId, organizationId: orgId(actor) },
      select: { id: true, name: true, businessName: true, brand: true },
    });
    if (!client) throw notFound('Client');

    const brand: BrandTreatment = {
      name: client.businessName || client.name,
      primaryColor: client.brand?.primaryColor ?? '#6366F1',
      accentColor: client.brand?.accentColor ?? '#22D3EE',
      textColor: client.brand?.textColor ?? '#E8EBF2',
      logoUrl: client.brand?.logoUrl ?? null,
    };

    // ------------------------------------------------------------------ audio
    let audio: AudioTrack | null = null;
    if (body.audioMediaId) {
      const track = await prisma.media.findFirst({
        where: { id: body.audioMediaId, ...scopeWhere(actor) },
        select: { id: true, filename: true, originalName: true, mimeType: true, clientId: true },
      });
      if (!track) throw notFound('Audio');
      if (!/^audio\//.test(track.mimeType)) throw badRequest('That asset is not an audio file');
      if (track.clientId && track.clientId !== resolvedClientId) {
        throw badRequest('That audio belongs to a different client');
      }

      audio = {
        buffer: await readObject(track.filename),
        filename: track.originalName,
        volume: body.audioVolume,
        trimStartSeconds: body.audioTrimStartSeconds,
        fadeInSeconds: body.audioFadeInSeconds,
        fadeOutSeconds: body.audioFadeOutSeconds,
      };
    }

    const forCopy: ProductForCopy | null = product
      ? {
          name: product.name,
          brand: product.brand,
          description: product.description,
          price: product.price ? Number(product.price) : null,
          salePrice: product.salePrice ? Number(product.salePrice) : null,
          currency: product.currency,
          category: product.category,
          features: product.features,
        }
      : null;

    const sources = await Promise.all(ordered.map((item) => readObject(item.filename)));

    // ----------------------------------------------------------------- render
    const created = [];
    for (const placement of placements) {
      const script = scriptFor({
        scenes: body.scenes,
        product: forCopy,
        targetSeconds: body.targetSeconds || placement.defaultDurationSeconds,
      });

      const rendered = await renderVideo({ sources, scenes: script.scenes, placement, brand, audio });

      const stored = await storage.save(rendered.buffer, {
        filename: `${placement.key.toLowerCase()}.mp4`,
        mimeType: 'video/mp4',
        prefix: `clients/${resolvedClientId}/videos`,
      });

      const video = await prisma.videoCreative.create({
        data: {
          organizationId: orgId(actor),
          clientId: resolvedClientId,
          productId: product?.id ?? null,
          campaignId: body.campaignId ?? null,
          sourceMediaId: ordered[0]?.id ?? null,
          platform: placement.platform,
          placement: placement.key,
          width: rendered.width,
          height: rendered.height,
          durationSeconds: rendered.durationSeconds,
          storageKey: stored.key,
          url: stored.url,
          sizeBytes: stored.sizeBytes,
          videoCodec: rendered.probe.videoCodec,
          audioCodec: rendered.probe.audioCodec,
          frameRate: rendered.probe.frameRate,
          audioSource: audio ? AudioSource.UPLOAD : AudioSource.NONE,
          audioMediaId: body.audioMediaId ?? null,
          script: { scenes: script.scenes, omitted: script.omitted } as unknown as Prisma.InputJsonValue,
          compositions: rendered.compositions as unknown as Prisma.InputJsonValue,
        },
      });

      created.push({ ...video, url: `/api/videos/${video.id}/file` });
    }

    await recordAudit({
      actor,
      action: 'video.render',
      entity: 'VideoCreative',
      meta: { count: created.length, placements: placements.map((p) => p.key) },
      ip: req.ip,
    });

    res.status(201).json({ videos: created });
  }),
);

videosRouter.get(
  '/',
  validateQuery(
    z.object({
      productId: z.string().max(40).optional(),
      campaignId: z.string().max(40).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const query = req.query as { productId?: string; campaignId?: string };

    const videos = await prisma.videoCreative.findMany({
      where: {
        ...scopeWhere(actor),
        ...(query.productId ? { productId: query.productId } : {}),
        ...(query.campaignId ? { campaignId: query.campaignId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    res.json({ videos: videos.map((video) => ({ ...video, url: `/api/videos/${video.id}/file` })) });
  }),
);

/**
 * Stream the MP4.
 *
 * Range requests are honoured because a video element issues one immediately;
 * answering 200 with the whole file makes seeking download the video again from
 * the start.
 */
videosRouter.get(
  '/:id/file',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const video = await prisma.videoCreative.findFirst({
      where: { id: req.params.id, ...scopeWhere(actor) },
      select: { storageKey: true, placement: true, sizeBytes: true },
    });
    if (!video) throw notFound('Video');

    const buffer = await readObject(video.storageKey);
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');

    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), buffer.byteLength - 1) : buffer.byteLength - 1;

      if (start >= buffer.byteLength || start > end) {
        res.status(416).setHeader('Content-Range', `bytes */${buffer.byteLength}`);
        res.end();
        return;
      }

      const slice = buffer.subarray(start, end + 1);
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${buffer.byteLength}`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', String(slice.byteLength));
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.send(slice);
      return;
    }

    res.setHeader('Accept-Ranges', 'bytes');
    sendObject(res, buffer, { mimeType: 'video/mp4', filename: `${video.placement.toLowerCase()}.mp4` });
  }),
);

videosRouter.get(
  '/:id/download',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const video = await prisma.videoCreative.findFirst({
      where: { id: req.params.id, ...scopeWhere(actor) },
      include: { client: { select: { name: true } } },
    });
    if (!video) throw notFound('Video');

    const buffer = await readObject(video.storageKey);
    const slug = `${video.client.name}-${video.placement}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    res.setHeader('X-Video-Dimensions', `${video.width}x${video.height}`);
    sendObject(res, buffer, { mimeType: 'video/mp4', filename: `${slug}.mp4`, download: true });
  }),
);

videosRouter.patch(
  '/:id',
  requireAgency,
  validateParams(idParam),
  validateBody(z.object({ status: z.nativeEnum(CreativeStatus) })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);

    const existing = await prisma.videoCreative.findFirst({
      where: { id: req.params.id, ...scopeWhere(actor) },
      select: { id: true },
    });
    if (!existing) throw notFound('Video');

    const video = await prisma.videoCreative.update({
      where: { id: existing.id },
      data: { status: (req.body as { status: CreativeStatus }).status },
    });
    res.json({ video });
  }),
);

videosRouter.delete(
  '/:id',
  requireAgency,
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);

    const existing = await prisma.videoCreative.findFirst({
      where: { id: req.params.id, ...scopeWhere(actor) },
      select: { id: true, storageKey: true },
    });
    if (!existing) throw notFound('Video');

    await prisma.videoCreative.delete({ where: { id: existing.id } });
    const object = await deleteObjectIfUnreferenced(existing.storageKey);

    await recordAudit({ actor, action: 'video.delete', entity: 'VideoCreative', entityId: existing.id, ip: req.ip });
    res.json({ ok: true, object });
  }),
);

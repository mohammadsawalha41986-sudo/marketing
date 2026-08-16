/** /api/media — upload, browse, retag and delete the media library. */

import { Router } from 'express';
import { MediaType, Prisma } from '@prisma/client';
import { z } from 'zod';
import sharp from 'sharp';

import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest, notFound } from '../lib/errors.js';
import { actorOf, requireAgency, requireAuth } from '../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { idParam, pageResult, paginate, paginationQuery } from '../lib/http.js';
import { assertWritable, orgId, resolveClientId, scopeWhere } from '../lib/scope.js';
import { IMAGE_MIME, VIDEO_MIME, uploadAny, sniffImage } from '../middleware/upload.js';
import { env } from '../env.js';
import { storage } from '../services/storage/index.js';
import { recordAudit } from '../services/audit.js';

export const mediaRouter: Router = Router();
mediaRouter.use(requireAuth);

function typeFor(mimeType: string): MediaType {
  if (IMAGE_MIME.has(mimeType)) return MediaType.IMAGE;
  if (VIDEO_MIME.has(mimeType)) return MediaType.VIDEO;
  return MediaType.DOCUMENT;
}

mediaRouter.get(
  '/',
  validateQuery(
    paginationQuery.extend({
      clientId: z.string().max(40).optional(),
      campaignId: z.string().max(40).optional(),
      type: z.nativeEnum(MediaType).optional(),
      category: z.string().max(80).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const query = req.query as unknown as z.infer<typeof paginationQuery> & {
      clientId?: string; campaignId?: string; type?: MediaType; category?: string;
    };

    const clientId = resolveClientId(actor, query.clientId);
    const where: Prisma.MediaWhereInput = {
      organizationId: orgId(actor),
      ...(clientId ? { clientId } : {}),
      ...(query.campaignId ? { campaignId: query.campaignId } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.search
        ? {
            OR: [
              { originalName: { contains: query.search, mode: 'insensitive' } },
              { tags: { has: query.search } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.media.findMany({
        where,
        ...paginate(query),
        orderBy: { createdAt: 'desc' },
        include: { client: { select: { id: true, name: true } } },
      }),
      prisma.media.count({ where }),
    ]);

    res.json(pageResult(items, total, query));
  }),
);

mediaRouter.post(
  '/',
  requireAgency,
  uploadAny.array('files', 10),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) throw badRequest('No files uploaded. Send them as multipart field "files".');

    const clientId = resolveClientId(actor, typeof req.body.clientId === 'string' ? req.body.clientId : undefined);
    const campaignId = typeof req.body.campaignId === 'string' && req.body.campaignId ? req.body.campaignId : undefined;
    const category = typeof req.body.category === 'string' ? req.body.category.slice(0, 80) : undefined;

    // Both references must belong to this tenant before anything is stored.
    if (clientId) {
      const client = await prisma.client.findFirst({ where: { id: clientId, organizationId: orgId(actor) }, select: { id: true } });
      if (!client) throw notFound('Client');
    }
    if (campaignId) {
      const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, organizationId: orgId(actor) }, select: { id: true } });
      if (!campaign) throw notFound('Campaign');
    }

    const created = [];
    for (const file of files) {
      const isImage = IMAGE_MIME.has(file.mimetype);
      // Claimed image types must actually be images.
      if (isImage && !sniffImage(file.buffer)) throw badRequest(`${file.originalname} is not a readable image`);

      let width: number | null = null;
      let height: number | null = null;
      if (isImage) {
        /*
         * The magic-number check above proves the file *starts* like an image;
         * it cannot prove the rest of it decodes. A truncated or malformed body
         * makes libvips throw here, and unhandled that is a 500 — which tells
         * the operator the server is broken when their file is. Rejected as a
         * bad request instead, naming the file.
         */
        try {
          const meta = await sharp(file.buffer).metadata();
          width = meta.width ?? null;
          height = meta.height ?? null;
        } catch {
          throw badRequest(`${file.originalname} could not be decoded. It may be truncated or corrupt.`);
        }
      }

      const stored = await storage.save(file.buffer, {
        filename: file.originalname,
        mimeType: file.mimetype,
        prefix: clientId ? `clients/${clientId}` : 'shared',
      });

      created.push(
        await prisma.media.create({
          data: {
            organizationId: orgId(actor),
            clientId: clientId ?? null,
            campaignId: campaignId ?? null,
            type: typeFor(file.mimetype),
            filename: stored.key,
            originalName: file.originalname.slice(0, 200),
            mimeType: file.mimetype,
            sizeBytes: stored.sizeBytes,
            width,
            height,
            url: stored.url,
            thumbnailUrl: isImage ? stored.url : null,
            category: category ?? null,
            tags: [],
          },
        }),
      );
    }

    await recordAudit({ actor, action: 'media.upload', entity: 'Media', meta: { count: created.length }, ip: req.ip });
    res.status(201).json({ items: created });
  }),
);

/**
 * Ingest an image from a URL into the library.
 *
 * The bytes are fetched and stored rather than the URL being kept as a
 * reference. Hotlinking would leave every creative dependent on somebody else's
 * server staying up and serving the same picture, and a rendered ad that breaks
 * three months later is worse than the storage cost.
 *
 * The fetch is deliberately constrained: https only, no redirects followed to
 * another host, a size ceiling, and the bytes are magic-number checked before
 * anything is written — a URL supplied by a user is an untrusted input, and
 * this endpoint would otherwise be a way to make the server fetch arbitrary
 * addresses.
 */
mediaRouter.post(
  '/from-url',
  requireAgency,
  validateBody(
    z.object({
      url: z.string().url().max(2000),
      clientId: z.string().max(40).optional(),
      campaignId: z.string().max(40).optional(),
      category: z.string().trim().max(80).optional(),
      tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
    }),
  ),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);
    const body = req.body as {
      url: string; clientId?: string; campaignId?: string; category?: string; tags: string[];
    };

    const target = new URL(body.url);
    if (target.protocol !== 'https:') throw badRequest('Only https image URLs can be imported');

    const clientId = resolveClientId(actor, body.clientId);
    if (clientId) {
      const client = await prisma.client.findFirst({ where: { id: clientId, organizationId: orgId(actor) }, select: { id: true } });
      if (!client) throw notFound('Client');
    }
    if (body.campaignId) {
      const campaign = await prisma.campaign.findFirst({ where: { id: body.campaignId, organizationId: orgId(actor) }, select: { id: true } });
      if (!campaign) throw notFound('Campaign');
    }

    const limitBytes = env.MAX_UPLOAD_MB * 1024 * 1024;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    let buffer: Buffer;
    let contentType: string;
    try {
      const response = await fetch(target, { redirect: 'follow', signal: controller.signal });
      if (!response.ok) throw badRequest(`The image URL responded with ${response.status}`);

      // Refuse a redirect that landed on a different host than the one asked for.
      if (new URL(response.url).host !== target.host) {
        throw badRequest('The image URL redirected to a different host');
      }

      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > limitBytes) throw badRequest(`That image is larger than the ${env.MAX_UPLOAD_MB}MB limit`);

      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > limitBytes) throw badRequest(`That image is larger than the ${env.MAX_UPLOAD_MB}MB limit`);

      buffer = bytes;
      contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw badRequest('The image URL took too long to respond');
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    // The bytes decide, not the header — a content-type can claim anything.
    const sniffed = sniffImage(buffer);
    if (!sniffed) throw badRequest('That URL did not return a readable image');
    const mimeType = sniffed === 'jpeg' ? 'image/jpeg' : `image/${sniffed}`;
    if (contentType && !IMAGE_MIME.has(contentType)) {
      // Not fatal — the magic number already proved it is an image — but the
      // real type is what gets stored.
    }

    const meta = await sharp(buffer)
      .metadata()
      .catch(() => {
        throw badRequest('That URL returned an image that could not be decoded.');
      });
    const name = decodeURIComponent(target.pathname.split('/').pop() || 'image').slice(0, 200);

    const stored = await storage.save(buffer, {
      filename: name,
      mimeType,
      prefix: clientId ? `clients/${clientId}` : 'shared',
    });

    const media = await prisma.media.create({
      data: {
        organizationId: orgId(actor),
        clientId: clientId ?? null,
        campaignId: body.campaignId ?? null,
        type: MediaType.IMAGE,
        filename: stored.key,
        originalName: name,
        mimeType,
        sizeBytes: stored.sizeBytes,
        width: meta.width ?? null,
        height: meta.height ?? null,
        url: stored.url,
        thumbnailUrl: stored.url,
        category: body.category ?? null,
        tags: body.tags,
      },
    });

    await recordAudit({ actor, action: 'media.import', entity: 'Media', entityId: media.id, meta: { host: target.host }, ip: req.ip });
    res.status(201).json({ media });
  }),
);

mediaRouter.patch(
  '/:id',
  requireAgency,
  validateParams(idParam),
  validateBody(
    z.object({
      originalName: z.string().trim().min(1).max(200).optional(),
      category: z.string().trim().max(80).nullish(),
      tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
      clientId: z.string().max(40).nullish(),
      campaignId: z.string().max(40).nullish(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);

    const existing = await prisma.media.findFirst({
      where: { id: req.params.id, ...scopeWhere(actor) },
      select: { id: true },
    });
    if (!existing) throw notFound('Media');

    const media = await prisma.media.update({
      where: { id: existing.id },
      data: req.body as Prisma.MediaUpdateInput,
    });
    res.json({ media });
  }),
);

mediaRouter.delete(
  '/:id',
  requireAgency,
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);

    const existing = await prisma.media.findFirst({
      where: { id: req.params.id, ...scopeWhere(actor) },
      select: { id: true, filename: true, originalName: true },
    });
    if (!existing) throw notFound('Media');

    await prisma.media.delete({ where: { id: existing.id } });
    // The row is the source of truth; a leftover blob is tolerable, a broken
    // reference is not, so the file is removed after the record.
    await storage.delete(existing.filename).catch((error) => {
      console.warn('[media] could not delete stored file:', (error as Error).message);
    });

    await recordAudit({
      actor, action: 'media.delete', entity: 'Media', entityId: existing.id,
      meta: { name: existing.originalName }, ip: req.ip,
    });
    res.json({ ok: true });
  }),
);

/** Storage totals for the subscription limits panel. */
mediaRouter.get(
  '/usage/summary',
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const grouped = await prisma.media.groupBy({
      by: ['type'],
      where: scopeWhere(actor),
      _sum: { sizeBytes: true },
      _count: { _all: true },
    });

    const totalBytes = grouped.reduce((sum, row) => sum + (row._sum.sizeBytes ?? 0), 0);
    res.json({
      totalBytes,
      totalMb: Number((totalBytes / (1024 * 1024)).toFixed(2)),
      byType: grouped.map((row) => ({
        type: row.type,
        count: row._count._all,
        bytes: row._sum.sizeBytes ?? 0,
      })),
    });
  }),
);

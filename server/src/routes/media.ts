/** /api/media — upload, browse, retag and delete the media library. */

import { Router } from 'express';
import { MediaType, Prisma } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest, notFound } from '../lib/errors.js';
import { actorOf, requireAuth } from '../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { idParam, pageResult, paginate, paginationQuery } from '../lib/http.js';
import { IMAGE_MIME, VIDEO_MIME, uploadAny, readImageMetadata } from '../middleware/upload.js';
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
      restaurantId: z.string().max(40).optional(),
      campaignId: z.string().max(40).optional(),
      type: z.nativeEnum(MediaType).optional(),
      category: z.string().max(80).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof paginationQuery> & {
      restaurantId?: string; campaignId?: string; type?: MediaType; category?: string;
    };

    const where: Prisma.MediaWhereInput = {
      ...(query.restaurantId ? { restaurantId: query.restaurantId } : {}),
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
        include: { restaurant: { select: { id: true, name: true } } },
      }),
      prisma.media.count({ where }),
    ]);

    res.json(pageResult(items, total, query));
  }),
);

mediaRouter.post(
  '/',
  uploadAny.array('files', 10),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) throw badRequest('No files uploaded. Send them as multipart field "files".');

    const restaurantId = typeof req.body.restaurantId === 'string' && req.body.restaurantId ? req.body.restaurantId : undefined;
    const campaignId = typeof req.body.campaignId === 'string' && req.body.campaignId ? req.body.campaignId : undefined;
    const category = typeof req.body.category === 'string' ? req.body.category.slice(0, 80) : undefined;

    // Both references must resolve before anything is written to storage.
    if (restaurantId) {
      const restaurant = await prisma.restaurant.findUnique({ where: { id: restaurantId }, select: { id: true } });
      if (!restaurant) throw notFound('Restaurant');
    }
    if (campaignId) {
      const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { id: true } });
      if (!campaign) throw notFound('Campaign');
    }

    const created = [];
    for (const file of files) {
      const isImage = IMAGE_MIME.has(file.mimetype);

      // A claimed image must actually decode, not merely start with the right
      // magic number — otherwise a corrupt file is stored and breaks on display.
      let width: number | null = null;
      let height: number | null = null;
      if (isImage) {
        try {
          ({ width, height } = await readImageMetadata(file.buffer));
        } catch {
          throw badRequest(`${file.originalname} is not a readable image`);
        }
      }

      const stored = await storage.save(file.buffer, {
        filename: file.originalname,
        mimeType: file.mimetype,
        prefix: restaurantId ? `restaurants/${restaurantId}` : 'shared',
      });

      created.push(
        await prisma.media.create({
          data: {
            restaurantId: restaurantId ?? null,
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

mediaRouter.patch(
  '/:id',
  validateParams(idParam),
  validateBody(
    z.object({
      originalName: z.string().trim().min(1).max(200).optional(),
      category: z.string().trim().max(80).nullish(),
      tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
      restaurantId: z.string().max(40).nullish(),
      campaignId: z.string().max(40).nullish(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const existing = await prisma.media.findUnique({ where: { id: req.params.id }, select: { id: true } });
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
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);

    const existing = await prisma.media.findUnique({
      where: { id: req.params.id },
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

/** Storage totals, shown in settings so the operator can see what is on disk. */
mediaRouter.get(
  '/usage/summary',
  asyncHandler(async (_req, res) => {
    const grouped = await prisma.media.groupBy({
      by: ['type'],
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

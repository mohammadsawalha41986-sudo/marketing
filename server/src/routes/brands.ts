/** /api/brands — Brand DNA, logo upload, and the suggested-identity workflow. */

import { Router } from 'express';
import { BrandAssetKind, Language, MediaType, Prisma } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest, notFound } from '../lib/errors.js';
import { actorOf, requireAuth } from '../middleware/auth.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import { hexColor } from '../lib/http.js';
import { readImageMetadata, uploadImage } from '../middleware/upload.js';
import { storage } from '../services/storage/index.js';
import { contrastRatio, extractPalette, readableTextOn } from '../services/palette.js';
import { recordAudit } from '../services/audit.js';

export const brandsRouter: Router = Router();
brandsRouter.use(requireAuth);

const restaurantParam = z.object({ restaurantId: z.string().min(1).max(40) });

/** Loads a restaurant's brand, or 404s. */
async function loadBrand(restaurantId: string) {
  const brand = await prisma.brand.findUnique({
    where: { restaurantId },
    include: { assets: true, restaurant: { select: { id: true, name: true, businessName: true } } },
  });
  if (!brand) throw notFound('Brand');
  return brand;
}

const stringList = z.array(z.string().trim().min(1).max(120)).max(40);

const brandSchema = z.object({
  businessName: z.string().trim().min(1).max(160),
  cuisine: z.string().trim().max(120).nullish(),
  description: z.string().trim().max(4000).nullish(),
  targetAudience: z.string().trim().max(2000).nullish(),
  location: z.string().trim().max(200).nullish(),
  personality: stringList,
  toneOfVoice: z.string().trim().max(200).nullish(),
  values: stringList,
  products: stringList,
  services: stringList,
  usps: stringList,
  offers: stringList,
  keywords: stringList,
  forbiddenWords: stringList,
  ctaStyle: z.string().trim().max(120).nullish(),
  visualStyle: z.string().trim().max(200).nullish(),
  preferredLanguage: z.nativeEnum(Language),
  fontFamily: z.string().trim().max(80),
  headingFont: z.string().trim().max(80).nullish(),
  bodyFont: z.string().trim().max(80).nullish(),
});

brandsRouter.get(
  '/:restaurantId',
  validateParams(restaurantParam),
  asyncHandler(async (req, res) => {
    const brand = await loadBrand(req.params.restaurantId as string);
    res.json({ brand });
  }),
);

brandsRouter.patch(
  '/:restaurantId',
  validateParams(restaurantParam),
  validateBody(brandSchema.partial()),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const existing = await loadBrand(req.params.restaurantId as string);

    const brand = await prisma.brand.update({
      where: { id: existing.id },
      data: req.body as Prisma.BrandUpdateInput,
      include: { assets: true },
    });

    await recordAudit({ actor, action: 'brand.update', entity: 'Brand', entityId: brand.id, ip: req.ip });
    res.json({ brand });
  }),
);

/**
 * Logo upload. The image is stored, a palette is *suggested* from it, and the
 * suggestion is parked in `suggestedPalette` — the live brand colours do not
 * change until someone approves them at `/palette`.
 */
brandsRouter.post(
  '/:restaurantId/logo',
  validateParams(restaurantParam),
  uploadImage.single('file'),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const brand = await loadBrand(req.params.restaurantId as string);

    const file = req.file;
    if (!file) throw badRequest('No file uploaded. Send it as multipart field "file".');

    // Validates and reads dimensions together, so a corrupt file is refused
    // before anything is written to storage.
    const meta = await readImageMetadata(file.buffer);

    const stored = await storage.save(file.buffer, {
      filename: file.originalname,
      mimeType: file.mimetype,
      prefix: `brands/${brand.restaurantId}`,
    });

    const palette = await extractPalette(file.buffer);

    const [updated] = await prisma.$transaction([
      prisma.brand.update({
        where: { id: brand.id },
        data: {
          logoUrl: stored.url,
          suggestedPalette: palette as unknown as Prisma.InputJsonValue,
          paletteApproved: false,
        },
        include: { assets: true },
      }),
      prisma.brandAsset.create({
        data: {
          brandId: brand.id,
          kind: BrandAssetKind.LOGO,
          url: stored.url,
          meta: { width: meta.width, height: meta.height } as Prisma.InputJsonValue,
        },
      }),
      prisma.restaurant.update({ where: { id: brand.restaurantId }, data: { logoUrl: stored.url } }),
      prisma.media.create({
        data: {
          restaurantId: brand.restaurantId,
          type: MediaType.LOGO,
          filename: stored.key,
          originalName: file.originalname.slice(0, 200),
          mimeType: file.mimetype,
          sizeBytes: stored.sizeBytes,
          width: meta.width,
          height: meta.height,
          url: stored.url,
          category: 'brand',
          tags: ['logo'],
        },
      }),
    ]);

    await recordAudit({ actor, action: 'brand.logo_upload', entity: 'Brand', entityId: brand.id, ip: req.ip });
    res.status(201).json({
      brand: updated,
      suggested: palette,
      message: 'Logo uploaded. Review the suggested identity, then approve it to apply.',
    });
  }),
);

const paletteSchema = z.object({
  primaryColor: hexColor,
  secondaryColor: hexColor,
  accentColor: hexColor,
  backgroundColor: hexColor,
  textColor: hexColor.optional(),
  fontFamily: z.string().trim().min(1).max(80).optional(),
});

/** Approve (and optionally edit) the identity. This is what goes live. */
brandsRouter.post(
  '/:restaurantId/palette',
  validateParams(restaurantParam),
  validateBody(paletteSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const brand = await loadBrand(req.params.restaurantId as string);
    const body = req.body as z.infer<typeof paletteSchema>;

    const textColor = body.textColor ?? readableTextOn(body.backgroundColor);
    const contrast = contrastRatio(textColor, body.backgroundColor);

    const updated = await prisma.brand.update({
      where: { id: brand.id },
      data: { ...body, textColor, paletteApproved: true },
      include: { assets: true },
    });

    await recordAudit({
      actor, action: 'brand.palette_approved', entity: 'Brand', entityId: brand.id,
      meta: { contrast: Number(contrast.toFixed(2)) }, ip: req.ip,
    });

    res.json({
      brand: updated,
      contrast: Number(contrast.toFixed(2)),
      // Surfaced rather than blocked: the operator may have a reason.
      warning: contrast < 4.5 ? `Text contrast is ${contrast.toFixed(1)}:1, below the 4.5:1 WCAG AA minimum.` : undefined,
    });
  }),
);

/** Re-run extraction against the logo already on file. */
brandsRouter.post(
  '/:restaurantId/palette/suggest',
  validateParams(restaurantParam),
  asyncHandler(async (req, res) => {
    const brand = await loadBrand(req.params.restaurantId as string);

    if (!brand.logoUrl) throw badRequest('Upload a logo first');

    const key = brand.logoUrl.replace(/^\/uploads\//, '');
    const path = storage.localPath(key);
    if (!path) throw badRequest('The current storage driver cannot re-read this logo');

    const { readFile } = await import('node:fs/promises');
    const palette = await extractPalette(await readFile(path));

    const updated = await prisma.brand.update({
      where: { id: brand.id },
      data: { suggestedPalette: palette as unknown as Prisma.InputJsonValue },
      include: { assets: true },
    });

    res.json({ brand: updated, suggested: palette });
  }),
);

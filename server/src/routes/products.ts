/**
 * /api/products — the head of the pipeline: a merchant URL becomes something
 * advertisable.
 *
 * Two rules shape this file.
 *
 * Nothing is invented. The extractor reports what the page stated and what it
 * did not; a missing price stays missing all the way to the operator's screen.
 * Ad copy is generated downstream from these fields, so a guess made here would
 * end up in a paid advertisement.
 *
 * Nothing is hotlinked. Product imagery is fetched and stored in our own object
 * storage, because a creative that depends on the merchant's CDN still serving
 * the same file is a creative that breaks silently, months later, in a campaign
 * somebody is paying for.
 */

import { Router } from 'express';
import { MediaType, Platform, Prisma } from '@prisma/client';
import { z } from 'zod';
import sharp from 'sharp';

import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest, notFound } from '../lib/errors.js';
import { actorOf, requireAgency, requireAuth } from '../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { idParam } from '../lib/http.js';
import { assertWritable, orgId, resolveClientId, scopeWhere } from '../lib/scope.js';
import { safeFetch } from '../lib/safe-fetch.js';
import { storage } from '../services/storage/index.js';
import { createMedia } from '../services/storage/objects.js';
import { extractProduct, type ExtractedProduct } from '../services/product/extract.js';
import { generateAllCopy, generateCopy, type ProductForCopy } from '../services/product/copy.js';
import { recordAudit } from '../services/audit.js';
import { sniffImage } from '../middleware/upload.js';

export const productsRouter: Router = Router();
productsRouter.use(requireAuth);

/** How much of a product page we are willing to read. */
const PAGE_LIMIT_BYTES = 3 * 1024 * 1024;
const IMAGE_LIMIT_BYTES = 12 * 1024 * 1024;

/**
 * Pull one image into our own storage.
 *
 * Failures are returned, not thrown: a gallery image that 404s should not lose
 * the operator the whole import. The main image is the caller's decision to
 * treat as fatal or not.
 */
async function importImage(input: {
  url: string;
  organizationId: string;
  clientId: string;
  productName: string;
}): Promise<{ id: string; url: string } | null> {
  try {
    const fetched = await safeFetch(input.url, { maxBytes: IMAGE_LIMIT_BYTES, accept: 'image/*' });

    // The bytes decide what this is, not the content-type header.
    const sniffed = sniffImage(fetched.body);
    if (!sniffed) return null;
    const mimeType = sniffed === 'jpeg' ? 'image/jpeg' : `image/${sniffed}`;

    const meta = await sharp(fetched.body).metadata().catch(() => null);
    if (!meta?.width || !meta.height) return null;

    // Icons and tracking pixels are not product photography.
    if (meta.width < 200 || meta.height < 200) return null;

    const stored = await storage.save(fetched.body, {
      filename: `${input.productName.slice(0, 60)}.${sniffed === 'jpeg' ? 'jpg' : sniffed}`,
      mimeType,
      prefix: `clients/${input.clientId}/assets`,
    });

    const media = await createMedia({
      organizationId: input.organizationId,
      clientId: input.clientId,
      type: MediaType.IMAGE,
      filename: stored.key,
      originalName: `${input.productName.slice(0, 120)} (imported)`,
      mimeType,
      sizeBytes: stored.sizeBytes,
      width: meta.width,
      height: meta.height,
      url: stored.url,
      thumbnailUrl: stored.url,
      category: 'product',
      tags: ['imported'],
    });

    return { id: media.id, url: media.url };
  } catch {
    return null;
  }
}

/** Shape the extractor's output for the review screen. */
function draftFrom(extracted: ExtractedProduct) {
  const value = <T>(field: { value: T } | null) => (field ? field.value : null);

  return {
    name: value(extracted.name),
    brand: value(extracted.brand),
    description: value(extracted.description),
    price: value(extracted.price),
    salePrice: value(extracted.salePrice),
    currency: value(extracted.currency),
    sku: value(extracted.sku),
    category: value(extracted.category),
    availability: value(extracted.availability),
    features: extracted.features,
    videoUrl: value(extracted.videoUrl),
  };
}

/** Which source each field came from, so a reviewer can weigh it. */
function provenanceOf(extracted: ExtractedProduct): Record<string, string> {
  const entries: Array<[string, { source: string } | null]> = [
    ['name', extracted.name],
    ['brand', extracted.brand],
    ['description', extracted.description],
    ['price', extracted.price],
    ['salePrice', extracted.salePrice],
    ['currency', extracted.currency],
    ['sku', extracted.sku],
    ['category', extracted.category],
    ['availability', extracted.availability],
    ['mainImage', extracted.mainImage],
  ];

  return Object.fromEntries(
    entries.filter(([, field]) => field !== null).map(([key, field]) => [key, field!.source]),
  );
}

const importSchema = z.object({
  url: z.string().url().max(2000),
  clientId: z.string().max(40).optional(),
  /** Import the imagery too. Off makes the call a cheap dry run. */
  importImages: z.boolean().default(true),
});

/**
 * Import a product from its page.
 *
 * The fetch goes through `safeFetch`, which validates the destination IP on
 * every redirect hop — a URL box that reaches arbitrary addresses from inside
 * the production network is a server-side request forgery, and this endpoint is
 * exactly the shape attackers look for.
 */
productsRouter.post(
  '/import',
  requireAgency,
  validateBody(importSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);
    const body = req.body as z.infer<typeof importSchema>;

    const clientId = resolveClientId(actor, body.clientId);
    if (!clientId) throw badRequest('Choose the client this product belongs to');

    const client = await prisma.client.findFirst({
      where: { id: clientId, organizationId: orgId(actor) },
      select: { id: true },
    });
    if (!client) throw notFound('Client');

    const page = await safeFetch(body.url, {
      maxBytes: PAGE_LIMIT_BYTES,
      accept: 'text/html,application/xhtml+xml',
    });

    if (page.contentType && !/^text\/html|^application\/xhtml/.test(page.contentType)) {
      throw badRequest(`That URL returned ${page.contentType}, not a web page`);
    }

    const extracted = extractProduct(page.body.toString('utf8'), page.finalUrl);

    // A page with no name at all is not a product page, and inventing one from
    // the URL slug is exactly the kind of guess this pipeline must not make.
    if (!extracted.name) {
      throw badRequest(
        'No product could be read from that page. It may be a category or landing page, ' +
          'or the product details may be rendered by JavaScript after load.',
      );
    }

    const draft = draftFrom(extracted);
    const productName = draft.name ?? 'Imported product';

    let mainMediaId: string | null = null;
    const galleryMediaIds: string[] = [];

    if (body.importImages && extracted.mainImage) {
      const main = await importImage({
        url: extracted.mainImage.value,
        organizationId: orgId(actor),
        clientId,
        productName,
      });
      mainMediaId = main?.id ?? null;

      for (const url of extracted.galleryImages.slice(0, 5)) {
        const imported = await importImage({ url, organizationId: orgId(actor), clientId, productName });
        if (imported) galleryMediaIds.push(imported.id);
      }
    }

    const product = await prisma.product.create({
      data: {
        organizationId: orgId(actor),
        clientId,
        sourceUrl: page.finalUrl,
        name: productName,
        brand: draft.brand,
        description: draft.description,
        price: draft.price !== null ? new Prisma.Decimal(draft.price) : null,
        salePrice: draft.salePrice !== null ? new Prisma.Decimal(draft.salePrice) : null,
        currency: draft.currency,
        sku: draft.sku,
        category: draft.category,
        availability: draft.availability,
        features: draft.features,
        mainMediaId,
        galleryMediaIds,
        sourceVideoUrl: draft.videoUrl,
        extraction: {
          provenance: provenanceOf(extracted),
          missing: extracted.missing,
          imagesFound: extracted.galleryImages.length + (extracted.mainImage ? 1 : 0),
          imagesImported: galleryMediaIds.length + (mainMediaId ? 1 : 0),
        } as Prisma.InputJsonValue,
      },
    });

    await recordAudit({
      actor,
      action: 'product.import',
      entity: 'Product',
      entityId: product.id,
      meta: { host: new URL(page.finalUrl).host, missing: extracted.missing },
      ip: req.ip,
    });

    res.status(201).json({
      product,
      /*
       * Reported rather than hidden. These are the fields the page did not
       * state, and the review screen asks for them instead of an advertisement
       * going out with a blank where a price should be.
       */
      missing: extracted.missing,
      provenance: provenanceOf(extracted),
      images: { found: extracted.galleryImages.length + (extracted.mainImage ? 1 : 0), imported: galleryMediaIds.length + (mainMediaId ? 1 : 0) },
    });
  }),
);

productsRouter.get(
  '/',
  validateQuery(z.object({ clientId: z.string().max(40).optional() })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const clientId = resolveClientId(actor, (req.query as { clientId?: string }).clientId);

    const products = await prisma.product.findMany({
      where: { ...scopeWhere(actor), ...(clientId ? { clientId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({ products });
  }),
);

productsRouter.get(
  '/:id',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const product = await prisma.product.findFirst({ where: { id: req.params.id, ...scopeWhere(actor) } });
    if (!product) throw notFound('Product');

    // The imagery comes back resolved, so the review screen can show it without
    // a second round trip per image.
    const mediaIds = [product.mainMediaId, ...product.galleryMediaIds].filter((id): id is string => Boolean(id));
    const media = mediaIds.length
      ? await prisma.media.findMany({
          where: { id: { in: mediaIds }, ...scopeWhere(actor) },
          select: { id: true, url: true, originalName: true, width: true, height: true },
        })
      : [];

    res.json({ product, media });
  }),
);

const updateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  brand: z.string().trim().max(120).nullish(),
  description: z.string().trim().max(4000).nullish(),
  price: z.number().nonnegative().nullish(),
  salePrice: z.number().nonnegative().nullish(),
  currency: z.string().trim().length(3).nullish(),
  sku: z.string().trim().max(80).nullish(),
  category: z.string().trim().max(120).nullish(),
  features: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  mainMediaId: z.string().max(40).nullish(),
});

/** Correct or complete what the import found. Everything here is the operator's. */
productsRouter.patch(
  '/:id',
  requireAgency,
  validateParams(idParam),
  validateBody(updateSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);
    const body = req.body as z.infer<typeof updateSchema>;

    const existing = await prisma.product.findFirst({
      where: { id: req.params.id, ...scopeWhere(actor) },
      select: { id: true },
    });
    if (!existing) throw notFound('Product');

    // A media id supplied by the caller is not an authorisation to use it.
    if (body.mainMediaId) {
      const media = await prisma.media.findFirst({
        where: { id: body.mainMediaId, ...scopeWhere(actor) },
        select: { id: true },
      });
      if (!media) throw notFound('Media');
    }

    const product = await prisma.product.update({
      where: { id: existing.id },
      data: {
        ...body,
        price: body.price === undefined ? undefined : body.price === null ? null : new Prisma.Decimal(body.price),
        salePrice:
          body.salePrice === undefined ? undefined : body.salePrice === null ? null : new Prisma.Decimal(body.salePrice),
        currency: body.currency === undefined ? undefined : body.currency?.toUpperCase() ?? null,
      },
    });

    res.json({ product });
  }),
);

/**
 * Ad copy for this product, shaped per platform.
 *
 * Assembled from the product's own fields — see services/product/copy.ts. The
 * response reports which field each string came from, and what was deliberately
 * left unsaid, so nothing in an advertisement is unattributable.
 */
productsRouter.get(
  '/:id/copy',
  validateParams(idParam),
  validateQuery(z.object({ platform: z.nativeEnum(Platform).optional() })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const product = await prisma.product.findFirst({ where: { id: req.params.id, ...scopeWhere(actor) } });
    if (!product) throw notFound('Product');

    const forCopy: ProductForCopy = {
      name: product.name,
      brand: product.brand,
      description: product.description,
      price: product.price ? Number(product.price) : null,
      salePrice: product.salePrice ? Number(product.salePrice) : null,
      currency: product.currency,
      category: product.category,
      features: product.features,
    };

    const platform = (req.query as { platform?: Platform }).platform;
    res.json({
      productId: product.id,
      copy: platform ? [generateCopy(forCopy, platform)] : generateAllCopy(forCopy),
    });
  }),
);

productsRouter.delete(
  '/:id',
  requireAgency,
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);

    const existing = await prisma.product.findFirst({
      where: { id: req.params.id, ...scopeWhere(actor) },
      select: { id: true },
    });
    if (!existing) throw notFound('Product');

    // The imported imagery is deliberately left in the library: it is a client
    // asset now, and may already be used by a creative.
    await prisma.product.delete({ where: { id: existing.id } });
    await recordAudit({ actor, action: 'product.delete', entity: 'Product', entityId: existing.id, ip: req.ip });
    res.json({ ok: true });
  }),
);

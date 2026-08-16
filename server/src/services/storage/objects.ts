/**
 * The application's view of stored objects: read them, serve them, and delete
 * them without orphaning or over-deleting.
 *
 * Everything above this file works in terms of storage *keys* and never in terms
 * of filesystem paths. That distinction is the whole point of the module — a
 * route that reaches for a path works on a laptop, works in CI, and silently
 * returns nothing on a container whose disk was replaced an hour ago.
 */

import type { Response } from 'express';
import type { Prisma } from '@prisma/client';

import { prisma } from '../../lib/prisma.js';
import { gone, storageReadFailed } from '../../lib/errors.js';
import { storage } from './index.js';

/**
 * Read stored bytes back, whichever driver is mounted.
 *
 * Drivers raise their own typed errors (STORAGE_NOT_CONFIGURED,
 * STORED_OBJECT_MISSING, STORAGE_READ_FAILED), so this only has to deal with a
 * driver that cannot read at all — and with the disk driver's raw ENOENT, which
 * predates `LocalStorage.read`.
 */
export async function readObject(key: string): Promise<Buffer> {
  if (!storage.read) {
    throw storageReadFailed(`The "${storage.name}" storage driver cannot read objects back.`);
  }

  try {
    return await storage.read(key);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw gone('That file is no longer present in storage.');
    }
    throw error;
  }
}

/**
 * Every place a storage key can be referenced from.
 *
 * Keys are content-addressed, so two rows holding identical bytes hold the same
 * key. Deleting the object the moment one of those rows goes away would break
 * the other one — an uploaded logo and its Media row are exactly this case, and
 * so is the same photograph uploaded twice. So a delete is a reference count,
 * not a file removal.
 */
async function referenceCount(key: string): Promise<number> {
  const [media, creatives, videos, brands] = await Promise.all([
    prisma.media.count({ where: { filename: key } }),
    prisma.creative.count({ where: { storageKey: key } }),
    prisma.videoCreative.count({ where: { storageKey: key } }),
    prisma.brand.count({ where: { logoKey: key } }),
  ]);
  return media + creatives + videos + brands;
}

/**
 * Remove the object only once nothing points at it any more.
 *
 * Call this *after* the owning row is deleted, so the count reflects reality.
 * A storage failure is logged rather than thrown: the row is already gone, and
 * failing the request would tell the operator the deletion did not happen when
 * the part they care about did. An object left behind is reclaimable; a
 * dangling reference is not.
 */
export async function deleteObjectIfUnreferenced(key: string): Promise<'deleted' | 'still-referenced' | 'failed'> {
  if (await referenceCount(key) > 0) return 'still-referenced';

  try {
    await storage.delete(key);
    return 'deleted';
  } catch (error) {
    console.warn('[storage] could not delete object %s: %s', key, (error as Error).message);
    return 'failed';
  }
}

/**
 * URLs the browser uses for stored media.
 *
 * These point at this application, not at the bucket. The bucket is private, and
 * keeping the fetch on our own routes means the tenant check runs on every
 * single request for every single byte — where a public or presigned bucket URL
 * is authorised once and then works for whoever holds the link. Media is client
 * data, and one agency's artwork must not be retrievable by guessing another
 * agency's URL.
 */
export const mediaFileUrl = (id: string): string => `/api/media/${id}/file`;
export const creativeFileUrl = (id: string): string => `/api/creatives/${id}/file`;

/**
 * Create a Media row whose `url` already points at the proxy route.
 *
 * The id is needed to build the URL and Prisma generates it during the insert,
 * so the row is written and then completed inside one transaction. The
 * alternative — leaving the driver's own URL in the column and rewriting it in
 * every response — was the arrangement that broke: five separate routes
 * serialize Media, and any route added later would quietly hand the browser a
 * private bucket URL. Storing the right value once makes all of them correct,
 * including the ones nobody remembered to change.
 */
export async function createMedia(data: Prisma.MediaUncheckedCreateInput) {
  return prisma.$transaction(async (tx) => {
    const created = await tx.media.create({ data });
    return tx.media.update({
      where: { id: created.id },
      data: {
        url: mediaFileUrl(created.id),
        thumbnailUrl: created.thumbnailUrl ? mediaFileUrl(created.id) : null,
      },
    });
  });
}

/** Rewrite a Media row's URLs to the proxy route before it goes over the wire. */
export function withMediaUrls<T extends { id: string; url: string; thumbnailUrl?: string | null }>(media: T): T {
  return {
    ...media,
    url: mediaFileUrl(media.id),
    ...(media.thumbnailUrl !== undefined ? { thumbnailUrl: media.thumbnailUrl ? mediaFileUrl(media.id) : null } : {}),
  };
}

/** Headers shared by every route that streams tenant media back. */
export function sendObject(
  res: Response,
  buffer: Buffer,
  opts: { mimeType: string; filename?: string; download?: boolean },
): void {
  res.setHeader('Content-Type', opts.mimeType);
  res.setHeader('Content-Length', String(buffer.byteLength));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Tenant data: cacheable by the one browser that fetched it, never by a proxy.
  res.setHeader('Cache-Control', 'private, max-age=300');
  if (opts.filename) {
    res.setHeader(
      'Content-Disposition',
      `${opts.download ? 'attachment' : 'inline'}; filename="${opts.filename.replace(/["\\]/g, '')}"`,
    );
  }
  res.send(buffer);
}

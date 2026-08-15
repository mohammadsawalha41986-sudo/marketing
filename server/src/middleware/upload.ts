/**
 * Upload handling. Files are buffered in memory, validated, then handed to the
 * storage provider — nothing is written to disk before its type is checked.
 */

import multer from 'multer';
import sharp from 'sharp';
import { env } from '../env.js';
import { badRequest } from '../lib/errors.js';

export const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);
export const VIDEO_MIME = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
export const DOC_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/csv',
]);

export const ALLOWED_MIME = new Set([...IMAGE_MIME, ...VIDEO_MIME, ...DOC_MIME]);

/**
 * SVG is deliberately excluded: it is an executable document and serving it from
 * the same origin as the app is a stored-XSS vector.
 */
const BLOCKED_MIME = new Set(['image/svg+xml', 'text/html', 'application/xhtml+xml']);

const limits = { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 10 };

function filter(allowed: Set<string>) {
  return (_req: unknown, file: Express.Multer.File, cb: multer.FileFilterCallback): void => {
    if (BLOCKED_MIME.has(file.mimetype)) {
      cb(badRequest(`${file.mimetype} uploads are not allowed`));
      return;
    }
    if (!allowed.has(file.mimetype)) {
      cb(badRequest(`Unsupported file type: ${file.mimetype}`));
      return;
    }
    cb(null, true);
  };
}

export const uploadAny = multer({ storage: multer.memoryStorage(), limits, fileFilter: filter(ALLOWED_MIME) });
export const uploadImage = multer({ storage: multer.memoryStorage(), limits, fileFilter: filter(IMAGE_MIME) });

/**
 * Magic-number check. A caller can claim any MIME type in the multipart header,
 * so the bytes get the final say before anything is stored.
 */
export function sniffImage(buffer: Buffer): 'png' | 'jpeg' | 'gif' | 'webp' | 'avif' | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.subarray(0, 3).toString('ascii') === 'GIF') return 'gif';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'webp';
  }
  if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('ascii');
    if (brand.startsWith('avif') || brand.startsWith('avis')) return 'avif';
  }
  return null;
}

export function assertRealImage(buffer: Buffer): void {
  if (!sniffImage(buffer)) {
    throw badRequest('That file is not a readable image');
  }
}

/**
 * Validate an image and read its dimensions in one step.
 *
 * The magic-number check above only proves the first few bytes look like an
 * image; a truncated or corrupt file passes it and then fails inside the
 * decoder. Left unhandled that surfaces as a 500 "Something went wrong", which
 * tells the operator nothing about the file they just picked — so the decode
 * happens here, and a failure becomes the same 400 as any other bad upload.
 */
export async function readImageMetadata(buffer: Buffer): Promise<{ width: number | null; height: number | null }> {
  assertRealImage(buffer);

  try {
    const meta = await sharp(buffer).metadata();
    return { width: meta.width ?? null, height: meta.height ?? null };
  } catch {
    // The decoder's own message names libvips internals, which is noise to the
    // person who just chose a file.
    throw badRequest('That image could not be read. It may be corrupt or incomplete.');
  }
}

/** Disk-backed storage. Files live outside the repo tree and survive restarts. */

import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { uploadDir } from '../../env.js';
import type { StorageProvider, StoredFile } from './index.js';

/** Strips anything that could escape the upload root or confuse a shell. */
function safeExtension(filename: string, mimeType: string): string {
  const raw = extname(filename).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(raw)) return raw;
  const fallback: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
    'video/mp4': '.mp4',
    'application/pdf': '.pdf',
  };
  return fallback[mimeType] ?? '.bin';
}

export class LocalStorage implements StorageProvider {
  readonly name = 'local';

  async save(
    buffer: Buffer,
    opts: { filename: string; mimeType: string; prefix?: string },
  ): Promise<StoredFile> {
    const now = new Date();
    const folder = [
      opts.prefix ?? 'media',
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, '0'),
    ].join('/');

    const name = `${randomBytes(16).toString('hex')}${safeExtension(opts.filename, opts.mimeType)}`;
    const key = `${folder}/${name}`;
    const target = this.resolveKey(key);

    await mkdir(join(uploadDir, folder), { recursive: true });
    await writeFile(target, buffer);

    return { key, url: `/uploads/${key}`, sizeBytes: buffer.byteLength };
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.resolveKey(key));
    } catch (err) {
      // Already gone is success; anything else is worth surfacing.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  localPath(key: string): string {
    return this.resolveKey(key);
  }

  /** Resolves a key inside the upload root, refusing traversal attempts. */
  private resolveKey(key: string): string {
    const cleaned = normalize(key).replace(/^([/\\.]+)/, '');
    const full = resolve(uploadDir, cleaned);
    if (full !== uploadDir && !full.startsWith(uploadDir + sep)) {
      throw new Error(`Refusing to write outside the upload root: ${key}`);
    }
    return full;
  }
}

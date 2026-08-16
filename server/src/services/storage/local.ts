/** Disk-backed storage. Files live outside the repo tree and survive restarts. */

import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, extname, normalize, resolve, sep } from 'node:path';
import { uploadDir } from '../../env.js';
import { gone } from '../../lib/errors.js';
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

  /**
   * The same content-addressed layout the S3 driver uses.
   *
   * Deliberately identical rather than merely similar: the deletion logic above
   * this layer has to reason about two rows sharing one object, and it can only
   * do that if the key for a given set of bytes is the same whichever driver is
   * mounted. A random name in development would make that path untestable
   * without a bucket.
   */
  private keyFor(buffer: Buffer, opts: { filename: string; mimeType: string; prefix?: string }): string {
    const digest = createHash('sha256').update(buffer).digest('hex').slice(0, 32);
    return `${opts.prefix ?? 'media'}/${digest}${safeExtension(opts.filename, opts.mimeType)}`;
  }

  async save(
    buffer: Buffer,
    opts: { filename: string; mimeType: string; prefix?: string },
  ): Promise<StoredFile> {
    const key = this.keyFor(buffer, opts);
    const target = this.resolveKey(key);

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, buffer);

    return { key, url: `/uploads/${key}`, sizeBytes: buffer.byteLength };
  }

  async read(key: string): Promise<Buffer> {
    try {
      return await readFile(this.resolveKey(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw gone(
          'That file is no longer on disk. This deployment is using the local storage driver, ' +
            'so uploaded media does not survive a redeploy.',
        );
      }
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolveKey(key));
      return true;
    } catch {
      return false;
    }
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

/**
 * Storage abstraction. The rest of the app only knows this interface, so an S3
 * or Hostinger-object-storage driver can be added without touching call sites.
 */

import { env } from '../../env.js';
import { LocalStorage } from './local.js';
import { S3Storage, s3ConfigFrom } from './s3.js';

export interface StoredFile {
  /** Key within the provider, e.g. `2026/08/abc123.png`. */
  key: string;
  /** URL the browser can fetch. Relative for local, absolute for remote drivers. */
  url: string;
  sizeBytes: number;
}

export interface StorageProvider {
  readonly name: string;
  save(buffer: Buffer, opts: { filename: string; mimeType: string; prefix?: string }): Promise<StoredFile>;
  delete(key: string): Promise<void>;
  /** Absolute path when the driver is disk-backed; null for remote drivers. */
  localPath(key: string): string | null;
  /** Read the bytes back. Optional on drivers that only ever write. */
  read?(key: string): Promise<Buffer>;
  exists?(key: string): Promise<boolean>;
}

/**
 * Pick the driver.
 *
 * Object storage is selected whenever it is fully configured, because on a host
 * with an ephemeral filesystem the local driver silently loses every upload on
 * the next deploy — a failure nobody notices until an operator goes looking for
 * a file that is no longer there. Local remains the development default and the
 * fallback when S3 is not configured.
 */
function build(): StorageProvider {
  const s3 = s3ConfigFrom();
  if (env.STORAGE_DRIVER === 's3' || (s3 && env.STORAGE_DRIVER !== 'local')) {
    if (!s3) {
      throw new Error(
        'STORAGE_DRIVER=s3 but S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are not all set.',
      );
    }
    return new S3Storage(s3);
  }
  return new LocalStorage();
}

export const storage: StorageProvider = build();

/** True when media survives a redeploy. Surfaced so the UI can warn. */
export function storageIsPersistent(): boolean {
  return storage.name !== 'local';
}

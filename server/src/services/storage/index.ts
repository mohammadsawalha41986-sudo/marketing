/**
 * Storage abstraction. The rest of the app only knows this interface, so an S3
 * or Hostinger-object-storage driver can be added without touching call sites.
 */

import { env } from '../../env.js';
import { LocalStorage } from './local.js';

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
}

function build(): StorageProvider {
  switch (env.STORAGE_DRIVER) {
    case 'local':
    default:
      return new LocalStorage();
  }
}

export const storage: StorageProvider = build();

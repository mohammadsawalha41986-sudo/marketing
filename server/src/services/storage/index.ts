/**
 * Storage abstraction. The rest of the app only knows this interface, so an S3
 * or Hostinger-object-storage driver can be added without touching call sites.
 */

import { isProd } from '../../env.js';
import { storageNotConfigured } from '../../lib/errors.js';
import { LocalStorage } from './local.js';
import { S3Storage, s3ConfigFrom } from './s3.js';

export interface StoredFile {
  /** Key within the provider, e.g. `clients/abc/assets/<digest>.png`. */
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
 * The driver mounted when production has no object storage configured.
 *
 * It refuses every operation with STORAGE_NOT_CONFIGURED rather than writing to
 * a disk that will be discarded on the next deploy. That refusal is the point:
 * the previous behaviour accepted the upload, showed it in the library, rendered
 * creatives from it, and then lost all of it at the next release — with nothing
 * anywhere saying that would happen. An operator who cannot upload asks why; an
 * operator whose uploads evaporate a week later has already built work on top of
 * them.
 *
 * Note that this is a *driver*, not a startup crash. The service still boots and
 * serves campaigns, financials, integrations and every other route; only the
 * media paths are closed, and they say exactly which variables are missing.
 */
export class UnconfiguredStorage implements StorageProvider {
  readonly name = 'unconfigured';

  constructor(readonly reason: string) {}

  private fail(): never {
    throw storageNotConfigured(this.reason);
  }

  async save(): Promise<StoredFile> {
    this.fail();
  }
  async read(): Promise<Buffer> {
    this.fail();
  }
  async exists(): Promise<boolean> {
    this.fail();
  }
  async delete(): Promise<void> {
    this.fail();
  }
  localPath(): string | null {
    return null;
  }
}

const MISSING_VARS = 'S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY';

/**
 * Pick the driver.
 *
 * Object storage is used whenever it is fully configured. Where this got it
 * wrong before was the fallback: on a host with an ephemeral filesystem — which
 * is every container platform, Railway included — the local driver loses every
 * upload on the next deploy, and falling back to it *silently* meant production
 * looked healthy while quietly discarding tenant media.
 *
 * So the rule is asymmetric on purpose. In development, local disk is the
 * sensible default and nothing is lost by it. In production, unconfigured
 * storage is an error state that the application reports, never a mode it
 * quietly operates in.
 */
export function buildStorage(processEnv: NodeJS.ProcessEnv = process.env, production = isProd): StorageProvider {
  const s3 = s3ConfigFrom(processEnv);

  if (s3 && processEnv.STORAGE_DRIVER !== 'local') return new S3Storage(s3);

  if (processEnv.STORAGE_DRIVER === 's3') {
    return new UnconfiguredStorage(
      `STORAGE_DRIVER is set to "s3" but ${MISSING_VARS} are not all set, so there is nowhere to put uploads.`,
    );
  }

  if (production) {
    return new UnconfiguredStorage(
      'Media storage is not configured. This deployment has no persistent object storage, and the ' +
        'container filesystem is replaced on every deploy, so anything written to it would be lost. ' +
        `Set ${MISSING_VARS} (S3_REGION defaults to "auto" for Cloudflare R2) and redeploy.`,
    );
  }

  return new LocalStorage();
}

export const storage: StorageProvider = buildStorage();

/** True when media survives a redeploy. Surfaced so the UI can warn. */
export function storageIsPersistent(): boolean {
  return storage.name !== 'local' && storage.name !== 'unconfigured';
}

/** What the admin panel and health endpoint report about storage. */
export function storageStatus(): { driver: string; persistent: boolean; configured: boolean; reason: string | null } {
  return {
    driver: storage.name,
    persistent: storageIsPersistent(),
    configured: storage.name !== 'unconfigured',
    reason: storage instanceof UnconfiguredStorage ? storage.reason : null,
  };
}

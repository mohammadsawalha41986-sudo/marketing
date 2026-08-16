/**
 * Driver selection — the fix for the production data loss.
 *
 * The failure this pins down was not a crash. Production was configured with no
 * object storage, fell back to the container filesystem, accepted every upload,
 * listed them in the library, rendered creatives from them, and then lost the
 * lot at the next deploy. Nothing anywhere said that would happen: the UI was
 * indistinguishable from a working install right up until the files were gone.
 *
 * So what is asserted here is a refusal. In production, unconfigured storage
 * must not resolve to a disk driver under any code path.
 */

import { describe, expect, it } from 'vitest';

import { UnconfiguredStorage, buildStorage } from '../src/services/storage/index.js';

const R2 = {
  S3_ENDPOINT: 'https://accountid.r2.cloudflarestorage.com',
  S3_BUCKET: 'marketing-os',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
};

describe('choosing a storage driver', () => {
  it('uses object storage whenever it is fully configured', () => {
    expect(buildStorage(R2, true).name).toBe('s3');
    expect(buildStorage(R2, false).name).toBe('s3');
  });

  it('refuses to fall back to local disk in production', () => {
    const storage = buildStorage({}, true);

    expect(storage.name).toBe('unconfigured');
    expect(storage).toBeInstanceOf(UnconfiguredStorage);
  });

  it('still refuses when production explicitly asks for the local driver', () => {
    // An explicit STORAGE_DRIVER=local in production is far more likely to be a
    // leftover from a development environment than a deliberate decision to
    // discard tenant media on every deploy.
    expect(buildStorage({ STORAGE_DRIVER: 'local' }, true).name).toBe('unconfigured');
  });

  it('names the missing variables rather than failing vaguely', async () => {
    const storage = buildStorage({}, true);

    await expect(storage.save(Buffer.from('x'), { filename: 'a.png', mimeType: 'image/png' })).rejects.toMatchObject({
      code: 'STORAGE_NOT_CONFIGURED',
      status: 503,
    });

    const error = await storage.read!('k').catch((e: Error) => e);
    expect(error.message).toContain('S3_ENDPOINT');
    expect(error.message).toContain('S3_BUCKET');
    expect(error.message).toContain('S3_ACCESS_KEY_ID');
    expect(error.message).toContain('S3_SECRET_ACCESS_KEY');
  });

  it('refuses every operation, not merely writes', async () => {
    const storage = buildStorage({}, true);
    const code = { code: 'STORAGE_NOT_CONFIGURED' };

    await expect(storage.read!('k')).rejects.toMatchObject(code);
    await expect(storage.exists!('k')).rejects.toMatchObject(code);
    await expect(storage.delete('k')).rejects.toMatchObject(code);
    expect(storage.localPath('k')).toBeNull();
  });

  it('reports STORAGE_DRIVER=s3 with missing credentials as a configuration error', async () => {
    // Previously this threw at import time and took the whole service down —
    // campaigns, financials and integrations included — over a media setting.
    const storage = buildStorage({ STORAGE_DRIVER: 's3' }, false);

    expect(storage.name).toBe('unconfigured');
    await expect(storage.delete('k')).rejects.toMatchObject({ code: 'STORAGE_NOT_CONFIGURED' });
  });

  it('keeps local disk as the development default', () => {
    expect(buildStorage({}, false).name).toBe('local');
  });
});

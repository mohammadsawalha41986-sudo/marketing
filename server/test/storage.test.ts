/**
 * S3-compatible object storage.
 *
 * Driven against a stub HTTP layer, so the signing, key layout and error
 * handling are all exercised without a bucket or a credential. What matters
 * here is that the signature is actually computed and attached, and that a
 * failed upload throws instead of returning a key nobody can read back.
 */

import { describe, expect, it, vi } from 'vitest';

import { S3Storage, s3ConfigFrom, type S3Config } from '../src/services/storage/s3.js';

const CONFIG: S3Config = {
  endpoint: 'https://accountid.r2.cloudflarestorage.com',
  bucket: 'marketing-os',
  region: 'auto',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret-key-value',
  forcePathStyle: true,
};

function stub(status = 200, body = new Uint8Array()) {
  return vi.fn(async () => ({
    ok: status < 400,
    status,
    arrayBuffer: async () => body.buffer,
    text: async () => '',
  })) as unknown as typeof fetch;
}

describe('S3 configuration', () => {
  it('returns null unless every required variable is present', () => {
    expect(s3ConfigFrom({})).toBeNull();
    expect(s3ConfigFrom({ S3_ENDPOINT: 'https://x', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k' })).toBeNull();
  });

  it('defaults the region to auto, which is what R2 requires', () => {
    const config = s3ConfigFrom({
      S3_ENDPOINT: 'https://accountid.r2.cloudflarestorage.com/',
      S3_BUCKET: 'b',
      S3_ACCESS_KEY_ID: 'k',
      S3_SECRET_ACCESS_KEY: 's',
    });
    expect(config).toMatchObject({ region: 'auto', forcePathStyle: true });
    // Trailing slash stripped, so keys never produce a double slash.
    expect(config?.endpoint).toBe('https://accountid.r2.cloudflarestorage.com');
  });
});

describe('S3 storage', () => {
  it('signs the upload with SigV4 and never leaks the secret', async () => {
    const fetchImpl = stub(200);
    const storage = new S3Storage(CONFIG, fetchImpl);

    const stored = await storage.save(Buffer.from('image-bytes'), {
      filename: 'burger.png',
      mimeType: 'image/png',
      prefix: 'clients/abc/creatives',
    });

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;

    expect(init.method).toBe('PUT');
    expect(headers.Authorization).toContain('AWS4-HMAC-SHA256');
    expect(headers.Authorization).toContain('Credential=AKIAEXAMPLE/');
    expect(headers['x-amz-content-sha256']).toHaveLength(64);
    expect(headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);

    // The signing key must never appear in the request itself.
    expect(JSON.stringify({ url, headers })).not.toContain('secret-key-value');

    expect(url).toContain('/marketing-os/clients/abc/creatives/');
    expect(stored.key).toMatch(/^clients\/abc\/creatives\/\d{4}\/\d{2}\/[0-9a-f]{32}\.png$/);
    expect(stored.sizeBytes).toBe(11);
  });

  it('addresses the same bytes by the same key, so a re-render reuses one object', async () => {
    const storage = new S3Storage(CONFIG, stub(200));
    const bytes = Buffer.from('identical');

    const first = await storage.save(bytes, { filename: 'a.png', mimeType: 'image/png', prefix: 'p' });
    const second = await storage.save(bytes, { filename: 'a.png', mimeType: 'image/png', prefix: 'p' });
    expect(first.key).toBe(second.key);

    const different = await storage.save(Buffer.from('other'), { filename: 'a.png', mimeType: 'image/png', prefix: 'p' });
    expect(different.key).not.toBe(first.key);
  });

  it('throws when the bucket rejects the upload rather than returning an unusable key', async () => {
    const storage = new S3Storage(CONFIG, stub(403));
    await expect(
      storage.save(Buffer.from('x'), { filename: 'a.png', mimeType: 'image/png' }),
    ).rejects.toThrow(/HTTP 403/);
  });

  it('reads bytes back', async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const storage = new S3Storage(CONFIG, stub(200, payload));
    expect(Buffer.from(await storage.read('k/v.png'))).toEqual(Buffer.from(payload));
  });

  it('treats an already-absent object as a successful delete', async () => {
    const storage = new S3Storage(CONFIG, stub(404));
    await expect(storage.delete('gone.png')).resolves.toBeUndefined();
  });

  it('surfaces a real delete failure', async () => {
    const storage = new S3Storage(CONFIG, stub(500));
    await expect(storage.delete('x.png')).rejects.toThrow(/HTTP 500/);
  });

  it('reports no local path, so callers use read() instead of an empty file', () => {
    expect(new S3Storage(CONFIG, stub()).localPath()).toBeNull();
  });

  it('prefers a CDN base URL when one is configured', async () => {
    const storage = new S3Storage({ ...CONFIG, publicBaseUrl: 'https://cdn.example.com' }, stub(200));
    const stored = await storage.save(Buffer.from('x'), { filename: 'a.png', mimeType: 'image/png' });
    expect(stored.url.startsWith('https://cdn.example.com/')).toBe(true);
  });

  it('encodes path segments without destroying separators', async () => {
    const fetchImpl = stub(200);
    const storage = new S3Storage(CONFIG, fetchImpl);
    await storage.save(Buffer.from('x'), { filename: 'a b.png', mimeType: 'image/png', prefix: 'clients/x y' });

    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain('clients/x%20y/');
    expect(url).not.toContain('clients%2Fx');
  });
});

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
    expect(stored.key).toMatch(/^clients\/abc\/creatives\/[0-9a-f]{32}\.png$/);
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
    ).rejects.toMatchObject({ code: 'STORAGE_UPLOAD_FAILED', status: 502 });
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
    await expect(storage.delete('x.png')).rejects.toMatchObject({ code: 'STORAGE_DELETE_FAILED' });
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

describe('reading objects back', () => {
  it('separates "the object is gone" from "the bucket refused us"', async () => {
    // 404: the reference outlived the bytes. Re-uploading fixes it.
    await expect(new S3Storage(CONFIG, stub(404)).read('k.png')).rejects.toMatchObject({
      code: 'STORED_OBJECT_MISSING',
      status: 410,
    });

    // 403: the object may well be there. This is a credentials problem, and
    // telling the operator the file is missing would send them to re-upload
    // something that is already sitting in the bucket.
    await expect(new S3Storage(CONFIG, stub(403)).read('k.png')).rejects.toMatchObject({
      code: 'STORAGE_READ_FAILED',
      status: 502,
    });
  });

  it('reports existence without reading the body', async () => {
    expect(await new S3Storage(CONFIG, stub(200)).exists('k.png')).toBe(true);
    expect(await new S3Storage(CONFIG, stub(404)).exists('k.png')).toBe(false);
  });
});

describe('presigned URLs', () => {
  it('signs a bounded, credential-free GET URL', () => {
    const url = new S3Storage(CONFIG, stub()).presignedUrl('clients/abc/assets/x.png', 120);

    expect(url).toContain('X-Amz-Signature=');
    expect(url).toContain('X-Amz-Expires=120');
    expect(url).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
    // The access key identifies the credential; the secret must never travel.
    expect(url).not.toContain('secret-key-value');
  });

  it('clamps the expiry to what S3 will accept', () => {
    const storage = new S3Storage(CONFIG, stub());
    expect(storage.presignedUrl('k.png', 0)).toContain('X-Amz-Expires=1');
    expect(storage.presignedUrl('k.png', 99_999_999)).toContain('X-Amz-Expires=604800');
  });
});

/**
 * The acceptance criterion for this whole change: media outlives the container.
 *
 * A redeploy replaces the process and its filesystem while the database and the
 * bucket persist. That is simulated here by writing through one driver instance
 * and reading through a completely separate one — a new object, new
 * credentials-derived signing state, nothing carried over — against a bucket
 * that kept the bytes. The read must succeed *without re-uploading*, which is
 * exactly what fails today on the local driver.
 */
describe('surviving a redeploy', () => {
  function bucket() {
    const objects = new Map<string, Buffer>();

    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const key = decodeURIComponent(new URL(String(url)).pathname.replace('/marketing-os/', ''));
      const method = init?.method ?? 'GET';

      if (method === 'PUT') {
        objects.set(key, Buffer.from(init?.body as Uint8Array));
        return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0), text: async () => '' };
      }

      const stored = objects.get(key);
      if (!stored) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0), text: async () => '' };

      if (method === 'DELETE') {
        objects.delete(key);
        return { ok: true, status: 204, arrayBuffer: async () => new ArrayBuffer(0), text: async () => '' };
      }

      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => stored.buffer.slice(stored.byteOffset, stored.byteOffset + stored.byteLength),
        text: async () => '',
      };
    }) as unknown as typeof fetch;

    return { objects, fetchImpl };
  }

  it('reads back what an earlier container wrote, with no re-upload', async () => {
    const { fetchImpl } = bucket();

    // Deploy 1: upload a source and render three placement variants from it.
    const before = new S3Storage(CONFIG, fetchImpl);
    const source = await before.save(Buffer.from('source-photograph'), {
      filename: 'burger.png',
      mimeType: 'image/png',
      prefix: 'clients/abc/assets',
    });
    const variants = await Promise.all(
      ['1080x1350', '1080x1920', '1200x628'].map((size) =>
        before.save(Buffer.from(`rendered-${size}`), {
          filename: `${size}.png`,
          mimeType: 'image/png',
          prefix: 'clients/abc/creatives',
        }),
      ),
    );

    const writesDuringFirstDeploy = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    // Deploy 2: a brand new process. Only the keys survived, in the database.
    const after = new S3Storage(CONFIG, fetchImpl);

    expect(Buffer.from(await after.read(source.key)).toString()).toBe('source-photograph');
    for (const [index, size] of ['1080x1350', '1080x1920', '1200x628'].entries()) {
      expect(Buffer.from(await after.read(variants[index]!.key)).toString()).toBe(`rendered-${size}`);
    }

    // Nothing was written during the second deploy: the reads are genuine reads.
    const writesAfter = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls
      .slice(writesDuringFirstDeploy)
      .filter((call) => (call[1] as RequestInit).method === 'PUT');
    expect(writesAfter).toHaveLength(0);
  });

  it('leaves no orphaned object behind when media is deleted', async () => {
    const { objects, fetchImpl } = bucket();
    const storage = new S3Storage(CONFIG, fetchImpl);

    const stored = await storage.save(Buffer.from('bytes'), {
      filename: 'a.png',
      mimeType: 'image/png',
      prefix: 'clients/abc/assets',
    });
    expect(objects.has(stored.key)).toBe(true);

    await storage.delete(stored.key);
    expect(objects.size).toBe(0);
    // And the reference is now genuinely dead rather than quietly empty.
    await expect(storage.read(stored.key)).rejects.toMatchObject({ code: 'STORED_OBJECT_MISSING' });
  });

  it('keeps one client out of another tenant prefix', async () => {
    const { objects, fetchImpl } = bucket();
    const storage = new S3Storage(CONFIG, fetchImpl);
    const bytes = Buffer.from('identical-bytes');

    const a = await storage.save(bytes, { filename: 'x.png', mimeType: 'image/png', prefix: 'clients/aaa/assets' });
    const b = await storage.save(bytes, { filename: 'x.png', mimeType: 'image/png', prefix: 'clients/bbb/assets' });

    // Identical content, but the tenant is part of the key, so the two clients
    // never share an object — content addressing must not collapse across the
    // boundary it is supposed to respect.
    expect(a.key).not.toBe(b.key);
    expect(a.key.startsWith('clients/aaa/')).toBe(true);
    expect(b.key.startsWith('clients/bbb/')).toBe(true);
    expect(objects.size).toBe(2);
  });
});

/**
 * Transport failures.
 *
 * The first time production met a TLS handshake rejection from R2, the upload
 * came back as HTTP 500 "Something went wrong" — which tells an operator the
 * application is broken when the truth is that it cannot reach the bucket. The
 * fixes for those two situations have nothing in common, so they must not look
 * the same from outside.
 */
describe('unreachable object storage', () => {
  /** What undici actually throws: a TypeError with the reason in `cause`. */
  function failing(cause: { message?: string; code?: string }) {
    return vi.fn(async () => {
      const error = new TypeError('fetch failed');
      (error as unknown as { cause: unknown }).cause = cause;
      throw error;
    }) as unknown as typeof fetch;
  }

  const TLS = {
    message:
      '801C1E9DB87F0000:error:0A000410:SSL routines:ssl3_read_bytes:sslv3 alert handshake failure:../ssl/record/rec_layer_s3.c:1601:SSL alert number 40',
  };

  it('reports a rejected TLS handshake as a storage failure, naming the likely cause', async () => {
    const storage = new S3Storage(CONFIG, failing(TLS));

    const error = await storage
      .save(Buffer.from('x'), { filename: 'a.png', mimeType: 'image/png' })
      .catch((e: Error & { code?: string; status?: number }) => e);

    expect(error.code).toBe('STORAGE_UPLOAD_FAILED');
    expect(error.status).toBe(502);
    // The message has to point at the thing that is actually wrong.
    expect(error.message).toMatch(/TLS handshake was rejected/i);
    expect(error.message).toMatch(/S3_ENDPOINT/);
  });

  it('distinguishes DNS, refusal and timeout from each other', async () => {
    const cases: Array<[{ message?: string; code?: string }, RegExp]> = [
      [{ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND bucket.example' }, /could not be resolved/i],
      [{ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }, /refused/i],
      [{ code: 'UND_ERR_CONNECT_TIMEOUT', message: 'Connect Timeout Error' }, /timed out/i],
    ];

    for (const [cause, expected] of cases) {
      const error = await new S3Storage(CONFIG, failing(cause)).read('k.png').catch((e: Error) => e);
      expect(error.message, String(cause.code)).toMatch(expected);
      expect((error as Error & { code?: string }).code).toBe('STORAGE_READ_FAILED');
    }
  });

  it('does not report an unreachable bucket as an absent object', async () => {
    // The dangerous confusion: "exists: false" would send an operator to
    // re-upload a file that is sitting in the bucket, unreachable.
    await expect(new S3Storage(CONFIG, failing(TLS)).exists('k.png')).rejects.toMatchObject({
      code: 'STORAGE_READ_FAILED',
    });
  });

  it('does not report a refused query as an absent object either', async () => {
    // 403 means the bucket is there and refusing us; only 404 means absent.
    await expect(new S3Storage(CONFIG, stub(403)).exists('k.png')).rejects.toMatchObject({
      code: 'STORAGE_READ_FAILED',
    });
    expect(await new S3Storage(CONFIG, stub(404)).exists('k.png')).toBe(false);
  });

  it('surfaces a transport failure on delete rather than swallowing it', async () => {
    await expect(new S3Storage(CONFIG, failing(TLS)).delete('k.png')).rejects.toMatchObject({
      code: 'STORAGE_DELETE_FAILED',
    });
  });
});

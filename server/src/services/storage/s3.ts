/**
 * S3-compatible object storage (AWS S3, Cloudflare R2, MinIO, Backblaze B2).
 *
 * Written against the S3 REST API with SigV4 signing rather than pulling in the
 * AWS SDK. The SDK is tens of megabytes for four verbs, and the signing is
 * ~40 lines — on a container that already carries sharp and the Prisma engine,
 * that weight is not worth paying.
 *
 * R2 works through the same code: it speaks the S3 API, requires `auto` as the
 * region, and needs the account-specific endpoint. Nothing here is special-cased
 * for a vendor beyond that.
 *
 * The reason this exists at all: rendered creatives and uploads on Railway live
 * on the container filesystem, which is replaced on every deploy. Anything an
 * operator uploaded is gone the next time the service ships.
 */

import { createHash, createHmac } from 'node:crypto';
import { extname } from 'node:path';

import type { StorageProvider, StoredFile } from './index.js';

export interface S3Config {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Public base URL, when the bucket is served through a CDN or custom domain. */
  publicBaseUrl?: string;
  /** R2 and MinIO need path-style addressing. */
  forcePathStyle: boolean;
}

export function s3ConfigFrom(env: NodeJS.ProcessEnv = process.env): S3Config | null {
  const required = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const;
  if (required.some((key) => !env[key])) return null;

  return {
    endpoint: (env.S3_ENDPOINT as string).replace(/\/+$/, ''),
    bucket: env.S3_BUCKET as string,
    // R2 mandates `auto`; it is also a safe default for anything non-AWS.
    region: env.S3_REGION ?? 'auto',
    accessKeyId: env.S3_ACCESS_KEY_ID as string,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY as string,
    publicBaseUrl: env.S3_PUBLIC_BASE_URL?.replace(/\/+$/, ''),
    forcePathStyle: env.S3_FORCE_PATH_STYLE !== 'false',
  };
}

const sha256Hex = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const hmac = (key: Buffer | string, value: string) => createHmac('sha256', key).update(value).digest();

/** Each path segment is encoded individually so `/` stays a separator. */
function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

/**
 * AWS Signature Version 4.
 *
 * Payload is always signed (never UNSIGNED-PAYLOAD): these objects are tenant
 * media, and an unsigned body would let a proxy alter bytes in flight without
 * the signature noticing.
 */
function sign(input: {
  config: S3Config;
  method: string;
  path: string;
  payload: Buffer;
  headers: Record<string, string>;
  now: Date;
}): Record<string, string> {
  const { config, method, path, payload, now } = input;

  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(payload);

  const headers: Record<string, string> = {
    ...input.headers,
    host: new URL(config.endpoint).host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };

  const signedHeaderNames = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${String(headers[Object.keys(headers).find((key) => key.toLowerCase() === name)!]).trim()}\n`)
    .join('');
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalRequest = [method, path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), config.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return {
    ...headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function safeExtension(filename: string, mimeType: string): string {
  const raw = extname(filename).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(raw)) return raw;
  const fallback: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'application/pdf': '.pdf',
  };
  return fallback[mimeType] ?? '.bin';
}

export class S3Storage implements StorageProvider {
  readonly name = 's3';

  constructor(
    private readonly config: S3Config,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private url(key: string): string {
    return this.config.forcePathStyle
      ? `${this.config.endpoint}/${this.config.bucket}/${encodeKey(key)}`
      : `${this.config.endpoint}/${encodeKey(key)}`;
  }

  private path(key: string): string {
    return this.config.forcePathStyle ? `/${this.config.bucket}/${encodeKey(key)}` : `/${encodeKey(key)}`;
  }

  async save(buffer: Buffer, opts: { filename: string; mimeType: string; prefix?: string }): Promise<StoredFile> {
    const now = new Date();
    const folder = [opts.prefix ?? 'media', String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0')].join('/');
    // Content-addressed: the same bytes under the same prefix reuse one object
    // rather than accumulating a new copy on every re-render.
    const digest = createHash('sha256').update(buffer).digest('hex').slice(0, 32);
    const key = `${folder}/${digest}${safeExtension(opts.filename, opts.mimeType)}`;

    const headers = sign({
      config: this.config,
      method: 'PUT',
      path: this.path(key),
      payload: buffer,
      headers: { 'content-type': opts.mimeType, 'content-length': String(buffer.byteLength) },
      now,
    });

    const response = await this.fetchImpl(this.url(key), { method: 'PUT', headers, body: new Uint8Array(buffer) });
    if (!response.ok) {
      throw new Error(`Object storage rejected the upload (HTTP ${response.status})`);
    }

    return { key, url: this.publicUrl(key), sizeBytes: buffer.byteLength };
  }

  async read(key: string): Promise<Buffer> {
    const headers = sign({
      config: this.config,
      method: 'GET',
      path: this.path(key),
      payload: Buffer.alloc(0),
      headers: {},
      now: new Date(),
    });

    const response = await this.fetchImpl(this.url(key), { method: 'GET', headers });
    if (!response.ok) throw new Error(`Object storage could not read ${key} (HTTP ${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  }

  async exists(key: string): Promise<boolean> {
    const headers = sign({
      config: this.config,
      method: 'HEAD',
      path: this.path(key),
      payload: Buffer.alloc(0),
      headers: {},
      now: new Date(),
    });
    const response = await this.fetchImpl(this.url(key), { method: 'HEAD', headers });
    return response.ok;
  }

  async delete(key: string): Promise<void> {
    const headers = sign({
      config: this.config,
      method: 'DELETE',
      path: this.path(key),
      payload: Buffer.alloc(0),
      headers: {},
      now: new Date(),
    });

    const response = await this.fetchImpl(this.url(key), { method: 'DELETE', headers });
    // 404 means the object is already gone, which is the outcome we wanted.
    if (!response.ok && response.status !== 404) {
      throw new Error(`Object storage could not delete ${key} (HTTP ${response.status})`);
    }
  }

  publicUrl(key: string): string {
    return this.config.publicBaseUrl ? `${this.config.publicBaseUrl}/${encodeKey(key)}` : this.url(key);
  }

  /** Remote driver: there is no path on this machine, and pretending otherwise
   *  would make callers read an empty file instead of failing. */
  localPath(): string | null {
    return null;
  }
}

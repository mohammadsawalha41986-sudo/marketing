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

import { AppError, gone, storageDeleteFailed, storageReadFailed, storageUploadFailed } from '../../lib/errors.js';
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
  /** Canonical query string, already sorted by parameter name. */
  query?: string;
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

  const canonicalRequest = [method, path, input.query ?? '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
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

/**
 * Describe a transport-level failure in terms an operator can act on.
 *
 * A request that never reaches the bucket fails as `TypeError: fetch failed`
 * with the real reason buried in `cause`, and unhandled it becomes a 500
 * "Something went wrong" — which says the application is broken when the truth
 * is that it cannot reach object storage. The distinction matters because the
 * fixes are unrelated: a TLS alert means the endpoint hostname is wrong or the
 * account does not exist, a DNS failure means a typo, a refused connection means
 * egress is blocked.
 */
function transportReason(error: unknown): string | null {
  if (error instanceof AppError) return null;

  const cause = (error as { cause?: { message?: string; code?: string } }).cause;
  const detail = cause?.message ?? (error as Error).message ?? '';
  const code = cause?.code;

  if (/handshake failure|sslv3 alert|SSL routines|ERR_TLS/i.test(detail)) {
    return 'the TLS handshake was rejected by the endpoint — check that S3_ENDPOINT is the exact account endpoint (https://<account-id>.r2.cloudflarestorage.com) with no bucket, path or port';
  }
  if (code === 'ENOTFOUND' || /getaddrinfo/i.test(detail)) return 'the endpoint hostname could not be resolved — check S3_ENDPOINT';
  if (code === 'ECONNREFUSED') return 'the connection was refused by the endpoint';
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || /timeout/i.test(detail)) return 'the connection to the endpoint timed out';
  if (/certificate|CERT_/i.test(detail)) return `the endpoint's TLS certificate was rejected: ${detail}`;
  if (/fetch failed/i.test((error as Error).message ?? '')) return `the request never reached object storage: ${detail || 'unknown transport error'}`;

  return null;
}

export class S3Storage implements StorageProvider {
  readonly name = 's3';

  constructor(
    private readonly config: S3Config,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * Issue a signed request, converting a transport failure into a typed storage
   * error rather than letting it escape as an unhandled TypeError.
   */
  private async send(
    key: string,
    init: { method: string; headers: Record<string, string>; body?: Uint8Array },
    wrap: (message: string) => AppError,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(this.url(key), init as RequestInit);
    } catch (error) {
      const reason = transportReason(error);
      if (reason) throw wrap(`Object storage is unreachable: ${reason}.`);
      throw error;
    }
  }

  private url(key: string): string {
    return this.config.forcePathStyle
      ? `${this.config.endpoint}/${this.config.bucket}/${encodeKey(key)}`
      : `${this.config.endpoint}/${encodeKey(key)}`;
  }

  private path(key: string): string {
    return this.config.forcePathStyle ? `/${this.config.bucket}/${encodeKey(key)}` : `/${encodeKey(key)}`;
  }

  /**
   * Object key for these bytes under this prefix.
   *
   * Content-addressed and *stable over time*: there is deliberately no date
   * segment. A date folder would mean the same photograph re-rendered next month
   * lands on a second object, which defeats the deduplication and leaves two
   * lifetimes to manage for one piece of content. The prefix carries the tenant
   * boundary (`clients/<clientId>/...`), so the digest only has to be unique
   * within one client's own material.
   */
  keyFor(buffer: Buffer, opts: { filename: string; mimeType: string; prefix?: string }): string {
    const digest = createHash('sha256').update(buffer).digest('hex').slice(0, 32);
    return `${opts.prefix ?? 'media'}/${digest}${safeExtension(opts.filename, opts.mimeType)}`;
  }

  async save(buffer: Buffer, opts: { filename: string; mimeType: string; prefix?: string }): Promise<StoredFile> {
    const key = this.keyFor(buffer, opts);

    const headers = sign({
      config: this.config,
      method: 'PUT',
      path: this.path(key),
      payload: buffer,
      headers: { 'content-type': opts.mimeType, 'content-length': String(buffer.byteLength) },
      now: new Date(),
    });

    const response = await this.send(
      key,
      { method: 'PUT', headers, body: new Uint8Array(buffer) },
      storageUploadFailed,
    );
    if (!response.ok) {
      throw storageUploadFailed(`Object storage rejected the upload (HTTP ${response.status}).`);
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

    const response = await this.send(key, { method: 'GET', headers }, storageReadFailed);
    if (!response.ok) {
      /*
       * A 404/410 is not the same class of problem as a 403 or a 500. The object
       * being absent means the reference outlived the bytes — actionable by
       * re-uploading. Anything else means the bucket is there and refusing us,
       * which is a credentials or permissions fix, and re-uploading would not
       * help. They get different codes so the UI can say different things.
       */
      if (response.status === 404 || response.status === 410) {
        throw gone('That file is no longer present in object storage.');
      }
      throw storageReadFailed(`Object storage could not read the file (HTTP ${response.status}).`);
    }
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
    const response = await this.send(key, { method: 'HEAD', headers }, storageReadFailed);
    if (response.ok) return true;
    // 404 is the only status that means "not there". A 403 means the bucket is
    // refusing us, and reporting that as "absent" would send an operator to
    // re-upload a file that is already sitting in the bucket.
    if (response.status === 404) return false;
    throw storageReadFailed(`Object storage could not be queried (HTTP ${response.status}).`);
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

    const response = await this.send(key, { method: 'DELETE', headers }, storageDeleteFailed);
    // 404 means the object is already gone, which is the outcome we wanted.
    if (!response.ok && response.status !== 404) {
      throw storageDeleteFailed(`Object storage could not delete the file (HTTP ${response.status}).`);
    }
  }

  /**
   * HeadBucket — does this bucket exist and do these credentials reach it?
   *
   * Non-destructive by construction: HEAD reads nothing and writes nothing. This
   * is the call that separates "the credentials are wrong" from "the bucket name
   * is wrong" from "the endpoint is wrong", which otherwise all present as a
   * failed upload.
   */
  async headBucket(): Promise<{ ok: boolean; status: number }> {
    const now = new Date();
    const path = `/${this.config.bucket}`;
    const headers = sign({ config: this.config, method: 'HEAD', path, payload: Buffer.alloc(0), headers: {}, now });

    try {
      const response = await this.fetchImpl(`${this.config.endpoint}${path}`, { method: 'HEAD', headers });
      return { ok: response.ok, status: response.status };
    } catch (error) {
      const reason = transportReason(error);
      if (reason) throw storageReadFailed(`Object storage is unreachable: ${reason}.`);
      throw error;
    }
  }

  /**
   * ListObjectsV2, capped. Also read-only.
   *
   * Returns keys rather than contents — enough to prove the credentials can
   * enumerate the bucket without this becoming a way to exfiltrate media.
   */
  async listObjects(limit = 5): Promise<{ status: number; keys: string[]; body: string }> {
    const now = new Date();
    const query = `list-type=2&max-keys=${Math.min(Math.max(limit, 1), 100)}`;
    const path = `/${this.config.bucket}`;

    /*
     * The query string is part of the canonical request, and SigV4 requires its
     * parameters sorted by key. `list-type` sorts before `max-keys`, so the
     * literal order above is already canonical.
     */
    const headers = sign({
      config: this.config,
      method: 'GET',
      path,
      query,
      payload: Buffer.alloc(0),
      headers: {},
      now,
    });

    try {
      const response = await this.fetchImpl(`${this.config.endpoint}${path}?${query}`, { method: 'GET', headers });
      const body = await response.text();
      const keys = [...body.matchAll(/<Key>([^<]+)<\/Key>/g)].map((match) => match[1]!);
      return { status: response.status, keys, body: body.slice(0, 600) };
    } catch (error) {
      const reason = transportReason(error);
      if (reason) throw storageReadFailed(`Object storage is unreachable: ${reason}.`);
      throw error;
    }
  }

  publicUrl(key: string): string {
    return this.config.publicBaseUrl ? `${this.config.publicBaseUrl}/${encodeKey(key)}` : this.url(key);
  }

  /**
   * A time-limited URL for one object.
   *
   * Used only where a browser has to fetch bytes directly. The default path in
   * this application is the authenticated proxy route, because that keeps the
   * tenant check on every single fetch; a presigned URL is a bearer token in a
   * query string, and once issued it works for anyone holding it until it
   * expires. Kept short for that reason, and offered rather than assumed.
   */
  presignedUrl(key: string, expiresInSeconds = 300): string {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${this.config.region}/s3/aws4_request`;
    const host = new URL(this.config.endpoint).host;

    const query = [
      ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
      ['X-Amz-Credential', `${this.config.accessKeyId}/${scope}`],
      ['X-Amz-Date', amzDate],
      ['X-Amz-Expires', String(Math.min(Math.max(expiresInSeconds, 1), 604_800))],
      ['X-Amz-SignedHeaders', 'host'],
    ]
      .map(([name, value]) => `${encodeURIComponent(name as string)}=${encodeURIComponent(value as string)}`)
      .sort()
      .join('&');

    const canonicalRequest = [
      'GET',
      this.path(key),
      query,
      `host:${host}\n`,
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');

    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${this.config.secretAccessKey}`, dateStamp), this.config.region), 's3'),
      'aws4_request',
    );
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

    return `${this.url(key)}?${query}&X-Amz-Signature=${signature}`;
  }

  /** Remote driver: there is no path on this machine, and pretending otherwise
   *  would make callers read an empty file instead of failing. */
  localPath(): string | null {
    return null;
  }
}

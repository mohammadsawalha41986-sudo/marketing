/**
 * A publishable copy of one image, for the providers that fetch rather than receive.
 *
 * Most publishers take the bytes: Facebook, TikTok and YouTube all upload the
 * file itself. Instagram's Content Publishing API does not — it takes a URL and
 * Meta's own servers fetch it, which means an authenticated Marketing OS media
 * endpoint can never work. Meta answers such a link with error 9004, "media
 * could not be fetched", which the publisher reports as INVALID_MEDIA.
 *
 * This module makes the one thing Instagram needs and nothing more: a public
 * HTTPS delivery URL for the specific image about to be posted. Everything else
 * about media storage is unchanged — the object of record stays where it was,
 * behind the same authenticated route, and nothing is copied here except at the
 * moment a post genuinely requires a publicly fetchable URL.
 *
 * Cloudinary is the delivery host. The upload is a signed REST call, so there
 * is no SDK and no new dependency: the signature is a SHA-1 over the sorted
 * signed parameters with the API secret appended, which is Cloudinary's
 * documented scheme. The secret is used to compute that hash and is never sent,
 * never logged and never returned.
 *
 * The public id is derived from the storage key, so re-publishing the same
 * asset addresses the same delivery URL instead of accumulating copies.
 */

import { createHash } from 'node:crypto';

/** What the delivery host needs before it can be used. */
const REQUIRED = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'] as const;

/** Where delivered copies live, so they are recognisable in the media library. */
const DEFAULT_FOLDER = 'marketing-os';

export interface DeliveryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  folder: string;
}

export function deliveryConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return REQUIRED.every((key) => Boolean(env[key]?.trim()));
}

/** Which variables are still missing, for a message an operator can act on. */
export function missingDeliveryEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return REQUIRED.filter((key) => !env[key]?.trim());
}

export function deliveryConfig(env: NodeJS.ProcessEnv = process.env): DeliveryConfig | null {
  if (!deliveryConfigured(env)) return null;
  return {
    cloudName: env.CLOUDINARY_CLOUD_NAME!.trim(),
    apiKey: env.CLOUDINARY_API_KEY!.trim(),
    apiSecret: env.CLOUDINARY_API_SECRET!.trim(),
    folder: env.CLOUDINARY_FOLDER?.trim() || DEFAULT_FOLDER,
  };
}

/**
 * Cloudinary's signature: SHA-1 over the signed parameters, sorted by name,
 * joined as a query string, with the API secret appended directly.
 *
 * Exported because a signature computed slightly differently fails as an
 * authentication error that says nothing about which byte was wrong, and that
 * is worth a test of its own.
 */
export function signParams(params: Record<string, string>, apiSecret: string): string {
  const canonical = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
  return createHash('sha1').update(`${canonical}${apiSecret}`).digest('hex');
}

/**
 * A stable public id for one stored object.
 *
 * Derived from the storage key so the same image always addresses the same
 * delivery URL. Cloudinary public ids are path-like, so anything that is not a
 * safe path character is folded away rather than escaped.
 */
export function publicIdFor(storageKey: string, folder: string): string {
  const stem = storageKey
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^a-zA-Z0-9/_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
  return `${folder}/${stem || 'asset'}`;
}

export type DeliveryFetch = (
  url: string,
  init: { method: string; body: FormData },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

export class DeliveryError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'DeliveryError';
    this.status = status;
  }
}

/**
 * Put these bytes where Meta can fetch them, and return the HTTPS URL.
 *
 * `overwrite=false` with a deterministic public id makes a repeat publish
 * idempotent: Cloudinary answers with the existing asset rather than storing a
 * second copy, and the URL is the same one as before.
 */
export async function publishableImageUrl(input: {
  storageKey: string;
  data: Buffer;
  mimeType: string;
  filename: string;
  config: DeliveryConfig;
  fetchImpl?: DeliveryFetch;
}): Promise<string> {
  const { config } = input;
  const fetchImpl = (input.fetchImpl ?? (fetch as unknown as DeliveryFetch));

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const publicId = publicIdFor(input.storageKey, config.folder);

  // Only these are signed, and only these are sent alongside the file. Adding a
  // parameter to the request without adding it to the signature is the classic
  // way to get an "invalid signature" that names nothing.
  const signed: Record<string, string> = { public_id: publicId, overwrite: 'false', timestamp };
  const signature = signParams(signed, config.apiSecret);

  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(input.data)], { type: input.mimeType }), input.filename);
  for (const [key, value] of Object.entries(signed)) form.set(key, value);
  form.set('api_key', config.apiKey);
  form.set('signature', signature);

  const response = await fetchImpl(
    `https://api.cloudinary.com/v1_1/${config.cloudName}/image/upload`,
    { method: 'POST', body: form },
  );

  const payload = (await response.json().catch(() => ({}))) as {
    secure_url?: unknown;
    error?: { message?: string };
  };

  if (!response.ok) {
    // The provider's own reason, which is the only useful part. It cannot
    // contain the secret: the secret is never sent.
    throw new DeliveryError(
      payload.error?.message
        ? `Cloudinary refused the upload: ${payload.error.message}`
        : `Cloudinary returned HTTP ${response.status}`,
      response.status,
    );
  }

  const url = payload.secure_url;
  if (typeof url !== 'string' || !url.startsWith('https://')) {
    throw new DeliveryError('Cloudinary accepted the upload but returned no HTTPS delivery URL.', null);
  }
  return url;
}

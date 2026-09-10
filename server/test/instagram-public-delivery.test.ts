/**
 * The public delivery copy Instagram cannot publish without.
 *
 * The production failure: a connected Instagram account, a real image, and
 * INVALID_MEDIA every time. `loadMedia` read the bytes out of storage and never
 * set `publicUrl`, so the Instagram publisher refused before any API call —
 * correctly, because the only URL this application had for that image was its
 * own authenticated media route, and Meta fetches the image itself.
 *
 * What is asserted here is the whole of the fix and the whole of its safety:
 * that a public HTTPS URL reaches Meta, that it is never a Marketing OS URL,
 * that the copy is made only for the platform that needs it, that the delivery
 * secret is used to sign and never sent, and that an unconfigured deployment
 * refuses with the variable names rather than publishing something broken.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Platform } from '@prisma/client';

import {
  deliveryConfig,
  deliveryConfigured,
  missingDeliveryEnv,
  publicIdFor,
  publishableImageUrl,
  signParams,
  type DeliveryFetch,
} from '../src/services/storage/public-delivery.js';
import { instagramPublisher } from '../src/services/publishing/instagram.js';
import { INSTAGRAM_LOGIN_API } from '../src/services/integrations/instagram.js';
import type { FetchLike } from '../src/services/publishing/contract.js';

const CLOUD = 'noriva';
const API_KEY = '123456789012345';
const API_SECRET = 'cloudinary-secret-that-must-never-be-sent';
const APP_URL = 'https://marketing.norivaglobal.com';
const DELIVERED = 'https://res.cloudinary.com/noriva/image/upload/v1/marketing-os/asset-1.jpg';

/** Cloudinary's upload endpoint, with the request captured for inspection. */
function cloudinaryFetch(overrides: { status?: number; body?: unknown } = {}) {
  const calls: Array<{ url: string; form: FormData }> = [];
  const impl: DeliveryFetch = async (url, init) => {
    calls.push({ url, form: init.body });
    const body = overrides.body ?? { secure_url: DELIVERED, public_id: 'marketing-os/asset-1' };
    return {
      ok: (overrides.status ?? 200) < 400,
      status: overrides.status ?? 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return { impl, calls };
}

describe('public delivery for Instagram', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.CLOUDINARY_CLOUD_NAME = CLOUD;
    process.env.CLOUDINARY_API_KEY = API_KEY;
    process.env.CLOUDINARY_API_SECRET = API_SECRET;
    delete process.env.CLOUDINARY_FOLDER;
  });

  afterEach(() => {
    for (const key of [
      'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'CLOUDINARY_FOLDER',
    ]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  // ------------------------------------------------------------- the upload

  it('uploads to Cloudinary and returns an HTTPS delivery URL', async () => {
    const { impl, calls } = cloudinaryFetch();

    const url = await publishableImageUrl({
      storageKey: 'uploads/asset-1.jpg',
      data: Buffer.from('image-bytes'),
      mimeType: 'image/jpeg',
      filename: 'asset-1.jpg',
      config: deliveryConfig()!,
      fetchImpl: impl,
    });

    expect(url).toBe(DELIVERED);
    expect(url.startsWith('https://')).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://api.cloudinary.com/v1_1/${CLOUD}/image/upload`);
  });

  it('signs the request and never sends the secret', async () => {
    const { impl, calls } = cloudinaryFetch();
    await publishableImageUrl({
      storageKey: 'uploads/asset-1.jpg',
      data: Buffer.from('image-bytes'),
      mimeType: 'image/jpeg',
      filename: 'asset-1.jpg',
      config: deliveryConfig()!,
      fetchImpl: impl,
    });

    const form = calls[0]!.form;
    const timestamp = String(form.get('timestamp'));
    const publicId = String(form.get('public_id'));

    expect(form.get('api_key')).toBe(API_KEY);
    expect(form.get('signature')).toBe(
      signParams({ public_id: publicId, overwrite: 'false', timestamp }, API_SECRET),
    );
    // The secret computes the hash; it is never a field.
    for (const [, value] of form.entries()) {
      if (typeof value === 'string') expect(value).not.toContain(API_SECRET);
    }
    expect(form.get('api_secret')).toBeNull();
  });

  it('addresses the same delivery URL for the same stored object', () => {
    // A repeat publish must not accumulate copies, which is what a deterministic
    // public id plus overwrite=false buys.
    expect(publicIdFor('uploads/asset-1.jpg', 'marketing-os')).toBe('marketing-os/uploads/asset-1');
    expect(publicIdFor('uploads/asset-1.jpg', 'marketing-os'))
      .toBe(publicIdFor('uploads/asset-1.jpg', 'marketing-os'));
    // Characters a public id cannot carry are folded, not escaped.
    expect(publicIdFor('uploads/a b?c.png', 'marketing-os')).toBe('marketing-os/uploads/a-b-c');
  });

  it('reports the provider\'s own reason when the upload is refused', async () => {
    const { impl } = cloudinaryFetch({ status: 401, body: { error: { message: 'Invalid Signature' } } });
    await expect(
      publishableImageUrl({
        storageKey: 'uploads/asset-1.jpg',
        data: Buffer.from('x'),
        mimeType: 'image/jpeg',
        filename: 'a.jpg',
        config: deliveryConfig()!,
        fetchImpl: impl,
      }),
    ).rejects.toThrow(/Invalid Signature/);
  });

  // ----------------------------------------------------------- the publisher

  it('sends Meta the public URL, never a Marketing OS URL', async () => {
    const requested: string[] = [];
    const fetchImpl = (async (url: string, init?: { body?: string }) => {
      requested.push(`${url}?${init?.body ?? ''}`);
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: url.includes('media_publish') ? 'post-1' : 'container-1' }),
        text: async () => '',
      };
    }) as unknown as FetchLike;

    const result = await instagramPublisher.publish({
      caption: 'Lunch is served.',
      media: [{
        kind: 'IMAGE',
        data: Buffer.from('bytes'),
        mimeType: 'image/jpeg',
        filename: 'a.jpg',
        publicUrl: DELIVERED,
      }],
      account: {
        externalId: '17841427409088548',
        name: 'norivaglobal',
        accessToken: 'ig-token',
        metadata: { api: INSTAGRAM_LOGIN_API },
      },
      fetchImpl,
    });

    expect(result.success).toBe(true);
    const container = requested.find((entry) => entry.includes('/media?')) ?? requested[0]!;
    expect(decodeURIComponent(container)).toContain(DELIVERED);
    // The authenticated host never appears in anything sent to Meta.
    expect(requested.join(' ')).not.toContain(APP_URL);
    // Instagram Login is preserved: the direct connection posts to its own host.
    expect(requested.join(' ')).toContain('graph.instagram.com');
  });

  it('refuses with the variable names when no delivery host is configured', async () => {
    delete process.env.CLOUDINARY_API_KEY;

    const result = await instagramPublisher.publish({
      caption: 'Lunch is served.',
      media: [{ kind: 'IMAGE', data: Buffer.from('bytes'), mimeType: 'image/jpeg', filename: 'a.jpg' }],
      account: { externalId: '178414', name: 'norivaglobal', accessToken: 'ig-token' },
      fetchImpl: (async () => {
        throw new Error('the publisher must refuse before calling Meta');
      }) as unknown as FetchLike,
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.kind).toBe('INVALID_MEDIA');
    expect(result.error.message).toMatch(/CLOUDINARY_API_KEY/);
    expect(missingDeliveryEnv()).toEqual(['CLOUDINARY_API_KEY']);
  });

  // ------------------------------------------------------------ configuration

  it('is off until every variable is present', () => {
    expect(deliveryConfigured()).toBe(true);
    expect(missingDeliveryEnv()).toEqual([]);

    delete process.env.CLOUDINARY_CLOUD_NAME;
    expect(deliveryConfigured()).toBe(false);
    expect(deliveryConfig()).toBeNull();
    expect(missingDeliveryEnv()).toContain('CLOUDINARY_CLOUD_NAME');
  });

  it('files copies under a folder that can be renamed', () => {
    expect(deliveryConfig()!.folder).toBe('marketing-os');
    process.env.CLOUDINARY_FOLDER = 'noriva-live';
    expect(deliveryConfig()!.folder).toBe('noriva-live');
  });

  it('makes a copy for Instagram only', async () => {
    // Facebook, TikTok and YouTube upload the bytes themselves. A public copy
    // made for them would put private media on a public host for no reason.
    const { publishablePlatforms } = await import('../src/services/publishing/registry.js');
    expect(publishablePlatforms()).toContain(Platform.FACEBOOK);
    // The gate lives in the publish path; this asserts the intent it encodes.
    const service = await import('fs/promises').then((fs) =>
      fs.readFile(new URL('../src/services/publishing/service.ts', import.meta.url), 'utf8'));
    expect(service).toContain('const NEEDS_PUBLIC_URL: Platform[] = [Platform.INSTAGRAM]');
  });
});

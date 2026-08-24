/**
 * The Instagram adapter, and the two things it refuses to fake.
 *
 * Instagram's Content Publishing API is a container then a publish, and the mock
 * here answers both in sequence with the shapes Meta returns. The tests prove
 * the sequence is correct and prove nothing about App Review — that is external,
 * and no test can stand in for it.
 *
 * The two refusals are the honest edges of a READY-but-blocked integration:
 * without a public media URL, and without the publishing permission, the adapter
 * says so precisely rather than sending Meta a request it will reject.
 */

import { describe, expect, it } from 'vitest';
import { Platform } from '@prisma/client';

import { instagramPublisher } from '../src/services/publishing/instagram.js';
import type { FetchLike, PublishMedia } from '../src/services/publishing/contract.js';

const IG_USER = '17841400000000000';

/** A fetch that answers /media then /media_publish from a script. */
function fetchScript(steps: Array<{ match: string; body: unknown; status?: number }>): {
  fetchImpl: FetchLike; urls: string[];
} {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    const step = steps.find((s) => url.includes(s.match));
    if (!step) throw new Error(`No stub for ${url}`);
    return {
      ok: (step.status ?? 200) < 400,
      status: step.status ?? 200,
      json: async () => step.body,
      text: async () => JSON.stringify(step.body),
    };
  }) as FetchLike;
  return { fetchImpl, urls };
}

const image = (over: Partial<PublishMedia> = {}): PublishMedia => ({
  kind: 'IMAGE',
  data: Buffer.from('bytes'),
  mimeType: 'image/jpeg',
  filename: 'creative.jpg',
  publicUrl: 'https://cdn.example.test/creative.jpg',
  ...over,
});

const request = (media: PublishMedia[], fetchImpl: FetchLike) => ({
  caption: 'Less mess, happier dog.',
  media,
  account: { externalId: IG_USER, name: 'PawEase', accessToken: 'token' },
  fetchImpl,
});

describe('Instagram publisher', () => {
  it('runs the container then the publish, and returns the post id', async () => {
    const { fetchImpl, urls } = fetchScript([
      { match: '/media_publish', body: { id: '17900000000000000' } },
      { match: '/media', body: { id: 'container-1' } },
    ]);

    const result = await instagramPublisher.publish(request([image()], fetchImpl));

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.platform).toBe(Platform.INSTAGRAM);
    expect(result.externalPostId).toBe('17900000000000000');

    // The order is the API's, and it must be honoured: container first.
    expect(urls[0]).toContain(`/${IG_USER}/media`);
    expect(urls[1]).toContain(`/${IG_USER}/media_publish`);
  });

  it('refuses when the image has no public URL', async () => {
    // The architectural constraint: Meta fetches the image, so an authenticated
    // endpoint is useless to it. The adapter must not send the request at all.
    const { fetchImpl, urls } = fetchScript([]);

    const result = await instagramPublisher.publish(
      request([image({ publicUrl: null })], fetchImpl),
    );

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.kind).toBe('INVALID_MEDIA');
    expect(result.error.message).toMatch(/publicly reachable/i);
    // Nothing was sent to Meta.
    expect(urls).toHaveLength(0);
  });

  it('refuses a post with no image', async () => {
    const { fetchImpl } = fetchScript([]);
    const result = await instagramPublisher.publish(request([], fetchImpl));

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.message).toMatch(/requires an image/i);
  });

  it('maps a missing publishing permission to a permanent, readable error', async () => {
    const { fetchImpl } = fetchScript([
      {
        match: '/media',
        body: { error: { message: 'requires instagram_content_publish', type: 'OAuthException', code: 200 } },
        status: 403,
      },
    ]);

    const result = await instagramPublisher.publish(request([image()], fetchImpl));

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.kind).toBe('MISSING_PERMISSION');
    expect(result.error.message).toMatch(/instagram_content_publish/);
  });

  it('maps an unfetchable image to INVALID_MEDIA', async () => {
    const { fetchImpl } = fetchScript([
      { match: '/media', body: { error: { message: 'media could not be fetched', code: 9004 } }, status: 400 },
    ]);

    const result = await instagramPublisher.publish(request([image()], fetchImpl));

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.kind).toBe('INVALID_MEDIA');
  });

  it('does not publish when the container step returns no id', async () => {
    const { fetchImpl, urls } = fetchScript([
      { match: '/media', body: { status: 'ok' } },
    ]);

    const result = await instagramPublisher.publish(request([image()], fetchImpl));

    expect(result.success).toBe(false);
    // The publish step must never run without a container id.
    expect(urls.some((u) => u.includes('media_publish'))).toBe(false);
  });
});

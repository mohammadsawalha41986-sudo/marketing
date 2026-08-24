import { describe, expect, it } from 'vitest';

import { googleBusinessPublisher } from '../src/services/publishing/google-business.js';
import type { FetchLike, PublishMedia } from '../src/services/publishing/contract.js';

const ACCOUNT_ID = '123456789';

function fetchOnce(body: unknown, status = 200): { fetchImpl: FetchLike; seen: Array<{ url: string; init: unknown }> } {
  const seen: Array<{ url: string; init: unknown }> = [];
  const fetchImpl = (async (url: string, init?: unknown) => {
    seen.push({ url, init });
    return {
      ok: status < 400,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }) as FetchLike;
  return { fetchImpl, seen };
}

const request = (media: PublishMedia[], fetchImpl: FetchLike, config?: Record<string, unknown>) => ({
  caption: 'Visit us today!',
  media,
  account: { externalId: ACCOUNT_ID, name: 'PawEase Vet', accessToken: 'token' },
  fetchImpl,
  ...(config ? { config } : {}),
});

describe('Google Business publisher', () => {
  it('publishes a text update and returns the post name', async () => {
    const postName = 'accounts/123456789/locations/LOC1/localPosts/POST1';
    const { fetchImpl, seen } = fetchOnce({ name: postName, searchUrl: 'https://posts.google.com/POST1' });

    const result = await googleBusinessPublisher.publish(request([], fetchImpl));

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.externalPostId).toBe(postName);
    expect(result.permalink).toBe('https://posts.google.com/POST1');

    const body = JSON.parse((seen[0]?.init as { body: string }).body);
    expect(body.summary).toBe('Visit us today!');
    expect(body.topicType).toBe('STANDARD');
    expect(body.languageCode).toBe('en');
  });

  it('publishes an image when publicUrl is provided', async () => {
    const { fetchImpl, seen } = fetchOnce({
      name: 'accounts/123/locations/L/localPosts/P',
      searchUrl: null,
    });
    const image: PublishMedia = {
      kind: 'IMAGE', data: Buffer.from('x'), mimeType: 'image/jpeg', filename: 'a.jpg',
      publicUrl: 'https://cdn.example.com/a.jpg',
    };

    const result = await googleBusinessPublisher.publish(request([image], fetchImpl));

    expect(result.success).toBe(true);
    const body = JSON.parse((seen[0]?.init as { body: string }).body);
    expect(body.media).toEqual([{ mediaFormat: 'PHOTO', sourceUrl: 'https://cdn.example.com/a.jpg' }]);
  });

  it('refuses an image without publicUrl', async () => {
    const { fetchImpl, seen } = fetchOnce({ name: 'x' });
    const image: PublishMedia = {
      kind: 'IMAGE', data: Buffer.from('x'), mimeType: 'image/jpeg', filename: 'a.jpg',
    };

    const result = await googleBusinessPublisher.publish(request([image], fetchImpl));

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.kind).toBe('INVALID_MEDIA');
    expect(seen).toHaveLength(0);
  });

  it('maps a 401 to an expired token', async () => {
    const { fetchImpl } = fetchOnce({ error: { message: 'Invalid credentials' } }, 401);
    const result = await googleBusinessPublisher.publish(request([], fetchImpl));

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.kind).toBe('INVALID_TOKEN');
  });

  it('maps a 403 to a missing permission', async () => {
    const { fetchImpl } = fetchOnce({ error: { message: 'Forbidden' } }, 403);
    const result = await googleBusinessPublisher.publish(request([], fetchImpl));

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.kind).toBe('MISSING_PERMISSION');
    expect(result.error.message).toMatch(/business\.manage/);
  });

  it('maps a 404 to an invalid account', async () => {
    const { fetchImpl } = fetchOnce({ error: { message: 'Not found' } }, 404);
    const result = await googleBusinessPublisher.publish(request([], fetchImpl));

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.kind).toBe('INVALID_ACCOUNT');
  });

  it('does not claim success on a 200 with no name', async () => {
    const { fetchImpl } = fetchOnce({}, 200);
    const result = await googleBusinessPublisher.publish(request([], fetchImpl));

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.message).toMatch(/no post name/i);
  });

  it('builds an EVENT post when config specifies it', async () => {
    const { fetchImpl, seen } = fetchOnce({
      name: 'accounts/123/locations/L/localPosts/E',
    });
    const config = {
      locationId: 'LOC1',
      postType: 'EVENT',
      eventTitle: 'Pet Adoption Day',
      eventStartDate: '2026-09-01',
      eventEndDate: '2026-09-02',
    };

    const result = await googleBusinessPublisher.publish(request([], fetchImpl, config));

    expect(result.success).toBe(true);
    const body = JSON.parse((seen[0]?.init as { body: string }).body);
    expect(body.topicType).toBe('EVENT');
    expect(body.event.title).toBe('Pet Adoption Day');
    expect(body.event.schedule.startDate).toEqual({ year: 2026, month: 9, day: 1 });
  });

  it('builds an OFFER post with coupon code', async () => {
    const { fetchImpl, seen } = fetchOnce({
      name: 'accounts/123/locations/L/localPosts/O',
    });
    const config = {
      locationId: 'LOC1',
      postType: 'OFFER',
      couponCode: 'SAVE20',
      redeemOnlineUrl: 'https://example.com/offer',
    };

    const result = await googleBusinessPublisher.publish(request([], fetchImpl, config));

    expect(result.success).toBe(true);
    const body = JSON.parse((seen[0]?.init as { body: string }).body);
    expect(body.topicType).toBe('OFFER');
    expect(body.offer.couponCode).toBe('SAVE20');
  });

  it('uses locationId from config when provided', async () => {
    const { fetchImpl, seen } = fetchOnce({
      name: 'accounts/123/locations/CUSTOM/localPosts/X',
    });
    const config = { locationId: 'CUSTOM_LOC' };

    await googleBusinessPublisher.publish(request([], fetchImpl, config));

    expect(seen[0]?.url).toContain('/locations/CUSTOM_LOC/');
  });
});

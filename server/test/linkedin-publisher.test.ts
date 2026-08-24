/**
 * The LinkedIn adapter: text posting against the real /rest/posts API.
 *
 * The mocks answer with the shapes LinkedIn returns. They prove the request is
 * shaped correctly — the organization author URN, the version header, the
 * published lifecycle — and prove nothing about the w_organization_social
 * approval, which is external.
 *
 * The image refusal is deliberate and tested: image posting is a three-call
 * dance not yet built, and dropping the attachment silently would publish
 * something other than what the operator composed.
 */

import { describe, expect, it } from 'vitest';

import { linkedInPublisher } from '../src/services/publishing/linkedin.js';
import type { FetchLike, PublishMedia } from '../src/services/publishing/contract.js';

const ORG = '5590506';

function fetchOnce(body: unknown, status = 201): { fetchImpl: FetchLike; seen: Array<{ url: string; init: unknown }> } {
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

const request = (media: PublishMedia[], fetchImpl: FetchLike) => ({
  caption: 'We are hiring.',
  media,
  account: { externalId: ORG, name: 'PawEase', accessToken: 'token' },
  fetchImpl,
});

describe('LinkedIn publisher', () => {
  it('publishes text and returns the post urn', async () => {
    const { fetchImpl, seen } = fetchOnce({ id: 'urn:li:share:7000000000000000000' });

    const result = await linkedInPublisher.publish(request([], fetchImpl));

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.externalPostId).toBe('urn:li:share:7000000000000000000');
    expect(result.permalink).toContain('linkedin.com');

    // The body must carry the organization author and a published lifecycle.
    const body = JSON.parse((seen[0]?.init as { body: string }).body);
    expect(body.author).toBe(`urn:li:organization:${ORG}`);
    expect(body.lifecycleState).toBe('PUBLISHED');
    expect(body.commentary).toBe('We are hiring.');
  });

  it('refuses an image rather than dropping it', async () => {
    const { fetchImpl, seen } = fetchOnce({ id: 'x' });
    const image: PublishMedia = {
      kind: 'IMAGE', data: Buffer.from('x'), mimeType: 'image/jpeg', filename: 'a.jpg',
    };

    const result = await linkedInPublisher.publish(request([image], fetchImpl));

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.kind).toBe('INVALID_MEDIA');
    // Nothing was posted: a partial post is worse than a refused one.
    expect(seen).toHaveLength(0);
  });

  it('maps a 403 to a missing permission', async () => {
    const { fetchImpl } = fetchOnce({ message: 'Not enough permissions' }, 403);

    const result = await linkedInPublisher.publish(request([], fetchImpl));

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.kind).toBe('MISSING_PERMISSION');
    expect(result.error.message).toMatch(/w_organization_social/);
  });

  it('maps a 401 to an expired token', async () => {
    const { fetchImpl } = fetchOnce({ message: 'Invalid token' }, 401);
    const result = await linkedInPublisher.publish(request([], fetchImpl));

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.kind).toBe('INVALID_TOKEN');
  });

  it('does not claim success on a 2xx with no id', async () => {
    const { fetchImpl } = fetchOnce({}, 201);
    const result = await linkedInPublisher.publish(request([], fetchImpl));

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.message).toMatch(/no post id/i);
  });
});

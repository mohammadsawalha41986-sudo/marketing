import { describe, expect, it } from 'vitest';

import { youtubePublisher } from '../src/services/publishing/youtube.js';
import type { FetchLike, PublishMedia } from '../src/services/publishing/contract.js';

function fetchSequence(
  responses: Array<{ body: unknown; status?: number; headers?: Record<string, string> }>,
): { fetchImpl: FetchLike; seen: Array<{ url: string; init: unknown }> } {
  const seen: Array<{ url: string; init: unknown }> = [];
  let call = 0;
  const fetchImpl = (async (url: string, init?: unknown) => {
    seen.push({ url, init });
    const resp = responses[call++] ?? { body: {}, status: 500 };
    const status = resp.status ?? 200;
    return {
      ok: status < 400,
      status,
      json: async () => resp.body,
      text: async () => JSON.stringify(resp.body),
      headers: {
        get: (key: string) => resp.headers?.[key.toLowerCase()] ?? null,
      },
    };
  }) as FetchLike;
  return { fetchImpl, seen };
}

const video: PublishMedia = {
  kind: 'VIDEO', data: Buffer.from('fake-video-data'), mimeType: 'video/mp4', filename: 'clip.mp4',
};

const request = (media: PublishMedia[], fetchImpl: FetchLike, config?: Record<string, unknown>) => ({
  caption: 'Check out our latest video!',
  media,
  account: { externalId: 'UC123', name: 'PawEase Channel', accessToken: 'token' },
  fetchImpl,
  ...(config ? { config } : {}),
});

describe('YouTube publisher', () => {
  it('uploads a video via resumable upload and returns the video id', async () => {
    const { fetchImpl, seen } = fetchSequence([
      { body: {}, status: 200, headers: { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=ABC' } },
      { body: { id: 'dQw4w9WgXcQ' }, status: 200 },
    ]);

    const result = await youtubePublisher.publish(request([video], fetchImpl));

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.externalPostId).toBe('dQw4w9WgXcQ');
    expect(result.permalink).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');

    expect(seen).toHaveLength(2);
    const initBody = JSON.parse((seen[0]?.init as { body: string }).body);
    expect(initBody.snippet.title).toBe('Check out our latest video!'.slice(0, 100));
    expect(initBody.status.privacyStatus).toBe('public');

    expect(seen[1]?.url).toContain('upload_id=ABC');
  });

  it('refuses when no video is provided', async () => {
    const { fetchImpl, seen } = fetchSequence([]);

    const result = await youtubePublisher.publish(request([], fetchImpl));

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.kind).toBe('INVALID_MEDIA');
    expect(seen).toHaveLength(0);
  });

  it('maps a 401 to an expired token', async () => {
    const { fetchImpl } = fetchSequence([
      { body: { error: { message: 'Invalid Credentials' } }, status: 401 },
    ]);
    const result = await youtubePublisher.publish(request([video], fetchImpl));

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.kind).toBe('INVALID_TOKEN');
  });

  it('maps a 403 to a missing permission', async () => {
    const { fetchImpl } = fetchSequence([
      { body: { error: { message: 'Insufficient Permission' } }, status: 403 },
    ]);
    const result = await youtubePublisher.publish(request([video], fetchImpl));

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.kind).toBe('MISSING_PERMISSION');
    expect(result.error.message).toMatch(/youtube\.upload/);
  });

  it('does not claim success if upload returns no video id', async () => {
    const { fetchImpl } = fetchSequence([
      { body: {}, status: 200, headers: { location: 'https://example.com/upload' } },
      { body: {}, status: 200 },
    ]);
    const result = await youtubePublisher.publish(request([video], fetchImpl));

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.message).toMatch(/no video id/i);
  });

  it('uses config overrides for title, privacy, and tags', async () => {
    const { fetchImpl, seen } = fetchSequence([
      { body: {}, status: 200, headers: { location: 'https://example.com/upload' } },
      { body: { id: 'xyz' }, status: 200 },
    ]);
    const config = {
      title: 'Custom Title',
      description: 'Custom desc',
      tags: ['pets', 'vet'],
      privacyStatus: 'unlisted',
      madeForKids: true,
    };

    const result = await youtubePublisher.publish(request([video], fetchImpl, config));

    expect(result.success).toBe(true);
    const initBody = JSON.parse((seen[0]?.init as { body: string }).body);
    expect(initBody.snippet.title).toBe('Custom Title');
    expect(initBody.snippet.description).toBe('Custom desc');
    expect(initBody.snippet.tags).toEqual(['pets', 'vet']);
    expect(initBody.status.privacyStatus).toBe('unlisted');
    expect(initBody.status.selfDeclaredMadeForKids).toBe(true);
  });

  it('handles upload failure after successful init', async () => {
    const { fetchImpl } = fetchSequence([
      { body: {}, status: 200, headers: { location: 'https://example.com/upload' } },
      { body: { error: { message: 'Upload failed' } }, status: 500 },
    ]);
    const result = await youtubePublisher.publish(request([video], fetchImpl));

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.kind).toBe('PROVIDER_UNAVAILABLE');
  });

  it('succeeds when init returns video id directly (no upload needed)', async () => {
    const { fetchImpl } = fetchSequence([
      { body: { id: 'direct123' }, status: 200 },
    ]);
    const result = await youtubePublisher.publish(request([video], fetchImpl));

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.externalPostId).toBe('direct123');
  });
});

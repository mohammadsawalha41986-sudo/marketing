import { describe, expect, it, vi } from 'vitest';

import { tiktokPublisher } from '../src/services/publishing/tiktok.js';
import { publisherFor } from '../src/services/publishing/registry.js';
import type { FetchLike, PublishMedia } from '../src/services/publishing/contract.js';
import {
  authorizationUrl, creatorInfo, discoverAccounts, exchangeCode, tiktokConfig,
  tiktokConfigured, validateToken,
} from '../src/services/integrations/tiktok.js';
import type { FetchLike as ProviderFetch } from '../src/services/integrations/meta.js';

/**
 * The publisher and the OAuth adapter both take their fetch as a parameter, so
 * every path below runs the real code against TikTok's own response shapes.
 * That matters more here than for most providers: TikTok answers a great many
 * failures with HTTP 200 and an `error` object, and a test that only exercised
 * status codes would pass while the adapter treated refusals as successes.
 */
function fetchSequence(responses: Array<{ body: unknown; status?: number }>) {
  const seen: Array<{ url: string; init: { method?: string; body?: unknown; headers?: Record<string, string> } }> = [];
  let call = 0;
  const fetchImpl = (async (url: string, init?: unknown) => {
    seen.push({ url, init: (init ?? {}) as { method?: string; body?: unknown } });
    const resp = responses[call++] ?? { body: {}, status: 500 };
    const status = resp.status ?? 200;
    return {
      ok: status < 400,
      status,
      json: async () => resp.body,
      text: async () => JSON.stringify(resp.body),
    };
  }) as FetchLike;
  return { fetchImpl, seen };
}

const video: PublishMedia = {
  kind: 'VIDEO', data: Buffer.from('fake-video-bytes'), mimeType: 'video/mp4', filename: 'clip.mp4',
};

const request = (
  media: PublishMedia[],
  fetchImpl: FetchLike,
  config?: Record<string, unknown>,
) => ({
  caption: 'Weekend brunch is back\n\n#brunch',
  media,
  account: { externalId: 'open-id-1', name: 'testkitchen', accessToken: 'tok' },
  fetchImpl,
  ...(config ? { config } : {}),
});

/** The creator_info body TikTok returns for an audited app. */
const creatorOk = {
  data: {
    creator_nickname: 'Test Kitchen',
    privacy_level_options: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'],
    comment_disabled: false,
    duet_disabled: false,
    stitch_disabled: false,
    max_video_post_duration_sec: 600,
  },
  error: { code: 'ok' },
};

const initOk = {
  data: { publish_id: 'pub-1', upload_url: 'https://upload.tiktokapis.com/upload/pub-1' },
  error: { code: 'ok' },
};

describe('TikTok publisher — the four-step direct post', () => {
  it('queries creator info, uploads the bytes, and returns the real post id', async () => {
    const { fetchImpl, seen } = fetchSequence([
      { body: creatorOk },
      { body: initOk },
      { body: {} },
      { body: { data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: ['7300000000000000000'] }, error: { code: 'ok' } } },
    ]);

    const result = await tiktokPublisher.publish(
      request([video], fetchImpl, { privacyLevel: 'PUBLIC_TO_EVERYONE' }),
    );

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    // The provider's own post id, never the publish_id.
    expect(result.externalPostId).toBe('7300000000000000000');
    expect(result.permalink).toBe('https://www.tiktok.com/@testkitchen/video/7300000000000000000');

    expect(seen.map((entry) => entry.url)).toEqual([
      'https://open.tiktokapis.com/v2/post/publish/creator_info/query/',
      'https://open.tiktokapis.com/v2/post/publish/video/init/',
      'https://upload.tiktokapis.com/upload/pub-1',
      'https://open.tiktokapis.com/v2/post/publish/status/fetch/',
    ]);

    const initBody = JSON.parse(String(seen[1]!.init.body));
    expect(initBody.post_info.privacy_level).toBe('PUBLIC_TO_EVERYONE');
    expect(initBody.source_info.source).toBe('FILE_UPLOAD');
    expect(initBody.source_info.video_size).toBe(video.data.length);

    // A single-chunk upload still has to declare its range.
    expect(seen[2]!.init.headers?.['content-range']).toBe(`bytes 0-${video.data.length - 1}/${video.data.length}`);
  });

  it('records the publish id and no permalink for a private post', async () => {
    // SELF_ONLY posts have no publicly available id. That is what private
    // means, not a failure — but a fabricated URL would 404 forever.
    const { fetchImpl } = fetchSequence([
      { body: { ...creatorOk, data: { ...creatorOk.data, privacy_level_options: ['SELF_ONLY'] } } },
      { body: initOk },
      { body: {} },
      { body: { data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [] }, error: { code: 'ok' } } },
    ]);

    const result = await tiktokPublisher.publish(request([video], fetchImpl));

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.externalPostId).toBe('pub-1');
    expect(result.permalink).toBeNull();
  });

  it('defaults to the creator\'s first available privacy level rather than public', async () => {
    const { fetchImpl, seen } = fetchSequence([
      { body: { ...creatorOk, data: { ...creatorOk.data, privacy_level_options: ['SELF_ONLY'] } } },
      { body: initOk },
      { body: {} },
      { body: { data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [] }, error: { code: 'ok' } } },
    ]);

    await tiktokPublisher.publish(request([video], fetchImpl));

    const initBody = JSON.parse(String(seen[1]!.init.body));
    expect(initBody.post_info.privacy_level).toBe('SELF_ONLY');
  });

  it('refuses a privacy level the creator cannot use, before uploading anything', async () => {
    const { fetchImpl, seen } = fetchSequence([
      { body: { ...creatorOk, data: { ...creatorOk.data, privacy_level_options: ['SELF_ONLY'] } } },
    ]);

    const result = await tiktokPublisher.publish(
      request([video], fetchImpl, { privacyLevel: 'PUBLIC_TO_EVERYONE' }),
    );

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.kind).toBe('INVALID_REQUEST');
    expect(result.error.message).toContain('SELF_ONLY');
    // The whole point: no bytes moved.
    expect(seen).toHaveLength(1);
  });

  it('lets the creator\'s own interaction settings win over ours', async () => {
    const { fetchImpl, seen } = fetchSequence([
      { body: { ...creatorOk, data: { ...creatorOk.data, comment_disabled: true } } },
      { body: initOk },
      { body: {} },
      { body: { data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: ['1'] }, error: { code: 'ok' } } },
    ]);

    await tiktokPublisher.publish(request([video], fetchImpl, { disableComment: false }));

    const initBody = JSON.parse(String(seen[1]!.init.body));
    expect(initBody.post_info.disable_comment).toBe(true);
  });
});

describe('TikTok publisher — refusals that never reach the network', () => {
  it('refuses a post with no video', async () => {
    const { fetchImpl, seen } = fetchSequence([]);
    const result = await tiktokPublisher.publish(request([], fetchImpl));

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.kind).toBe('INVALID_MEDIA');
    expect(result.error.message).toContain('no video');
    expect(seen).toHaveLength(0);
  });

  it('refuses an image, rather than uploading something TikTok will reject', async () => {
    const { fetchImpl, seen } = fetchSequence([]);
    const image: PublishMedia = {
      kind: 'IMAGE', data: Buffer.from('png'), mimeType: 'image/png', filename: 'a.png',
    };

    const result = await tiktokPublisher.publish(request([image], fetchImpl));

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.kind).toBe('INVALID_MEDIA');
    expect(seen).toHaveLength(0);
  });

  it('refuses an unsupported video container', async () => {
    const { fetchImpl } = fetchSequence([]);
    const avi: PublishMedia = {
      kind: 'VIDEO', data: Buffer.from('x'), mimeType: 'video/x-msvideo', filename: 'a.avi',
    };

    const result = await tiktokPublisher.publish(request([avi], fetchImpl));

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.message).toContain('MP4');
  });
});

describe('TikTok publisher — error classification decides retry or a person', () => {
  const cases: Array<{ code: string; kind: string; retryable: boolean }> = [
    { code: 'access_token_invalid', kind: 'INVALID_TOKEN', retryable: false },
    { code: 'scope_not_authorized', kind: 'MISSING_PERMISSION', retryable: false },
    { code: 'rate_limit_exceeded', kind: 'RATE_LIMITED', retryable: true },
    { code: 'spam_risk_too_many_posts', kind: 'RATE_LIMITED', retryable: true },
    { code: 'file_format_check_failed', kind: 'INVALID_MEDIA', retryable: false },
    { code: 'duration_check_failed', kind: 'INVALID_MEDIA', retryable: false },
    { code: 'internal_error', kind: 'PROVIDER_UNAVAILABLE', retryable: true },
  ];

  for (const entry of cases) {
    it(`maps ${entry.code} to ${entry.kind}`, async () => {
      // TikTok reports these on HTTP 200, which is the trap this asserts against.
      const { fetchImpl } = fetchSequence([
        { body: { error: { code: entry.code, message: 'provider text' } }, status: 200 },
      ]);

      const result = await tiktokPublisher.publish(request([video], fetchImpl));

      expect(result.success).toBe(false);
      if (result.success) throw new Error('unreachable');
      expect(result.error.kind).toBe(entry.kind);
      expect(result.error.code).toBe(entry.code);
      // The provider's own words reach the operator; the token never does.
      expect(result.error.message).toContain('provider text');
      expect(result.error.message).not.toContain('tok');
    });
  }

  it('treats a failed publish status as a failure with TikTok\'s reason', async () => {
    const { fetchImpl } = fetchSequence([
      { body: creatorOk },
      { body: initOk },
      { body: {} },
      { body: { data: { status: 'FAILED', fail_reason: 'duration_check_failed' }, error: { code: 'ok' } } },
    ]);

    const result = await tiktokPublisher.publish(request([video], fetchImpl));

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.kind).toBe('INVALID_MEDIA');
  });

  it('reports still-processing as retryable rather than failed', async () => {
    vi.useFakeTimers();
    try {
      const responses = [
        { body: creatorOk },
        { body: initOk },
        { body: {} },
        ...Array.from({ length: 10 }, () => ({
          body: { data: { status: 'PROCESSING_UPLOAD' }, error: { code: 'ok' } },
        })),
      ];
      const { fetchImpl } = fetchSequence(responses);

      const promise = tiktokPublisher.publish(request([video], fetchImpl));
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.success).toBe(false);
      if (result.success) throw new Error('unreachable');
      // Retryable on purpose: the post may be moments from going live, and the
      // service's idempotency guard stops a retry from double-posting.
      expect(result.error.kind).toBe('PROVIDER_UNAVAILABLE');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a missing upload URL rather than claiming success', async () => {
    const { fetchImpl } = fetchSequence([
      { body: creatorOk },
      { body: { data: { publish_id: 'pub-1' }, error: { code: 'ok' } } },
    ]);

    const result = await tiktokPublisher.publish(request([video], fetchImpl));

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.kind).toBe('INVALID_REQUEST');
  });

  it('reports a network failure as retryable', async () => {
    const fetchImpl = (async () => {
      throw new Error('socket hang up');
    }) as unknown as FetchLike;

    const result = await tiktokPublisher.publish(request([video], fetchImpl));

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.kind).toBe('NETWORK');
  });
});

describe('TikTok is registered as a real publisher', () => {
  it('replaces the not-implemented stub', () => {
    const publisher = publisherFor('TIKTOK' as never);
    expect(publisher?.canPublish).toBe(true);
    expect(publisher?.label).toBe('TikTok');
  });

  it('leaves the other platforms alone', () => {
    for (const platform of ['FACEBOOK', 'INSTAGRAM', 'YOUTUBE', 'LINKEDIN'] as const) {
      expect(publisherFor(platform as never)?.canPublish).toBe(true);
    }
    // X still has no adapter, and still says so.
    expect(publisherFor('X' as never)?.canPublish).toBe(false);
  });
});

describe('TikTok OAuth adapter', () => {
  const env = {
    TIKTOK_CLIENT_KEY: 'key-1',
    TIKTOK_CLIENT_SECRET: 'secret-1',
    TIKTOK_REDIRECT_URI: 'https://app.example.com/api/integrations/tiktok/callback',
  } as NodeJS.ProcessEnv;

  it('reports missing configuration by variable name', () => {
    expect(tiktokConfigured({} as NodeJS.ProcessEnv)).toBe(false);
    expect(() => tiktokConfig({} as NodeJS.ProcessEnv)).toThrowError(/TIKTOK_CLIENT_KEY/);
  });

  it('trims values pasted with trailing whitespace', () => {
    const config = tiktokConfig({ ...env, TIKTOK_CLIENT_KEY: 'key-1\n' } as NodeJS.ProcessEnv);
    expect(config.clientKey).toBe('key-1');
  });

  it('builds a Login Kit URL with client_key, not client_id', () => {
    const url = new URL(authorizationUrl({ config: tiktokConfig(env), state: 'state-1' }));

    expect(url.origin + url.pathname).toBe('https://www.tiktok.com/v2/auth/authorize/');
    expect(url.searchParams.get('client_key')).toBe('key-1');
    expect(url.searchParams.get('client_id')).toBeNull();
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('scope')).toContain('video.publish');
  });

  it('exchanges a code and records the granted scopes, not the requested ones', async () => {
    const { fetchImpl, seen } = fetchSequence([
      {
        body: {
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 86_400,
          // The login granted everything except publishing.
          scope: 'user.info.basic,video.upload',
        },
      },
    ]);

    const tokens = await exchangeCode({
      config: tiktokConfig(env),
      code: 'code-1',
      fetchImpl: fetchImpl as unknown as ProviderFetch,
      now: new Date('2026-01-01T00:00:00Z'),
    });

    expect(tokens.accessToken).toBe('access-1');
    expect(tokens.refreshToken).toBe('refresh-1');
    expect(tokens.expiresAt?.toISOString()).toBe('2026-01-02T00:00:00.000Z');
    expect(tokens.scopes).toEqual(['user.info.basic', 'video.upload']);
    expect(tokens.scopes).not.toContain('video.publish');

    // Form-encoded, not JSON — TikTok's token endpoint rejects a JSON body.
    expect(seen[0]!.init.headers?.['content-type']).toBe('application/x-www-form-urlencoded');
  });

  it('treats an in-band error on HTTP 200 as a failure', async () => {
    const { fetchImpl } = fetchSequence([
      { body: { error: { code: 'invalid_grant', message: 'Authorization code expired' } }, status: 200 },
    ]);

    await expect(
      exchangeCode({
        config: tiktokConfig(env), code: 'stale', fetchImpl: fetchImpl as unknown as ProviderFetch,
      }),
    ).rejects.toThrowError(/Authorization code expired/);
  });

  it('validates the token against TikTok before the connection is trusted', async () => {
    const { fetchImpl } = fetchSequence([
      { body: { data: { user: { open_id: 'open-1', display_name: 'Test Kitchen', username: 'testkitchen' } }, error: { code: 'ok' } } },
    ]);

    const identity = await validateToken({
      accessToken: 'access-1', fetchImpl: fetchImpl as unknown as ProviderFetch,
    });

    expect(identity.id).toBe('open-1');
    expect(identity.name).toBe('Test Kitchen');
  });

  it('discovers exactly one creator account, carrying the same token', async () => {
    const { fetchImpl } = fetchSequence([
      { body: { data: { user: { open_id: 'open-1', display_name: 'Test Kitchen' } }, error: { code: 'ok' } } },
    ]);

    const accounts = await discoverAccounts({
      accessToken: 'access-1', fetchImpl: fetchImpl as unknown as ProviderFetch,
    });

    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.kind).toBe('PROFILE');
    expect(accounts[0]!.externalId).toBe('open-1');
    // connect-flow encrypts this before it reaches the database.
    expect(accounts[0]!.accessToken).toBe('access-1');
  });

  it('reads the creator\'s real privacy options rather than assuming them', async () => {
    const { fetchImpl } = fetchSequence([{ body: creatorOk }]);

    const info = await creatorInfo({
      accessToken: 'access-1', fetchImpl: fetchImpl as unknown as ProviderFetch,
    });

    expect(info.privacyOptions).toContain('SELF_ONLY');
    expect(info.maxVideoPostDurationSec).toBe(600);
  });
});

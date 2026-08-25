/**
 * Publishing a video to YouTube via the YouTube Data API v3.
 *
 * YouTube's upload path is a resumable upload:
 *   1. POST https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable
 *      with snippet/status JSON → returns a Location header with the upload URI
 *   2. PUT the video bytes to that URI
 *
 * For text-only "community posts", the YouTube API does not expose a public
 * endpoint — community posts are only available through YouTube Studio. This
 * adapter therefore only supports video uploads and refuses text-only posts
 * honestly.
 *
 * The adapter requires OAuth2 with `https://www.googleapis.com/auth/youtube.upload`
 * scope, which is an external approval requirement (Google Cloud project must
 * have the YouTube Data API enabled and the OAuth consent screen approved).
 */

import { Platform } from '@prisma/client';

import type {
  PlatformPublisher, PublishError, PublishErrorKind, PublishRequest, PublishResult,
} from './contract.js';

const API = 'https://www.googleapis.com/upload/youtube/v3';
const DEFAULT_TIMEOUT_MS = 120_000;

export interface YouTubeConfig {
  title?: string;
  description?: string;
  tags?: string[];
  categoryId?: string;
  privacyStatus?: 'public' | 'unlisted' | 'private';
  madeForKids?: boolean;
}

const EXPLANATION: Record<PublishErrorKind, string> = {
  NETWORK: 'Could not reach YouTube.',
  TIMEOUT: 'YouTube did not respond in time.',
  RATE_LIMITED: 'YouTube is rate limiting this app; the upload will be retried.',
  PROVIDER_UNAVAILABLE: 'YouTube is temporarily unavailable; the upload will be retried.',
  INVALID_TOKEN: 'The YouTube connection has expired. Reconnect the channel to upload.',
  MISSING_PERMISSION:
    'The connected Google account cannot upload to YouTube (youtube.upload scope required).',
  INVALID_ACCOUNT: 'YouTube does not recognise this channel for the connected account.',
  INVALID_MEDIA: 'YouTube requires a video file. Text-only posts are not supported via the API.',
  INVALID_REQUEST: 'YouTube rejected the upload.',
  NOT_CONFIGURED: 'YouTube publishing is not configured on this deployment.',
};

function classify(status: number): PublishErrorKind {
  if (status === 401) return 'INVALID_TOKEN';
  if (status === 403) return 'MISSING_PERMISSION';
  if (status === 404) return 'INVALID_ACCOUNT';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'PROVIDER_UNAVAILABLE';
  return 'INVALID_REQUEST';
}

function toPublishError(payload: unknown, status: number): PublishError {
  const error = (payload as { error?: { message?: string; errors?: Array<{ reason?: string }> } } | undefined)?.error;
  const message = error?.message ?? `YouTube returned HTTP ${status}`;
  const kind = classify(status);
  return { kind, code: String(status), message: `${EXPLANATION[kind]} YouTube said: ${message}`, httpStatus: status };
}

export const youtubePublisher: PlatformPublisher = {
  platform: Platform.YOUTUBE,
  label: 'YouTube Channel',
  canPublish: true,

  async publish(request: PublishRequest): Promise<PublishResult> {
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const video = request.media.find((m) => m.kind === 'VIDEO');
    if (!video) {
      return {
        success: false,
        platform: Platform.YOUTUBE,
        error: { kind: 'INVALID_MEDIA', code: null, message: EXPLANATION.INVALID_MEDIA, httpStatus: null },
      };
    }

    const config = request.config as YouTubeConfig | undefined;
    const title = config?.title ?? (request.caption.slice(0, 100) || 'Untitled');
    const description = config?.description ?? request.caption;
    const privacyStatus = config?.privacyStatus ?? 'public';

    const metadata = {
      snippet: {
        title,
        description,
        tags: config?.tags ?? [],
        categoryId: config?.categoryId ?? '22',
      },
      status: {
        privacyStatus,
        selfDeclaredMadeForKids: config?.madeForKids ?? false,
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const initResponse = await request.fetchImpl(
        `${API}/videos?uploadType=resumable&part=snippet,status`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${request.account.accessToken}`,
            'content-type': 'application/json',
            'x-upload-content-length': String(video.data.length),
            'x-upload-content-type': video.mimeType,
          },
          body: JSON.stringify(metadata),
          signal: controller.signal,
        },
      );

      if (!initResponse.ok) {
        const payload = (await initResponse.json().catch(() => ({}))) as Record<string, unknown>;
        return { success: false, platform: Platform.YOUTUBE, error: toPublishError(payload, initResponse.status) };
      }

      const uploadUrl = (initResponse as unknown as { headers?: { get?: (k: string) => string | null } })
        .headers?.get?.('location');

      if (!uploadUrl) {
        const payload = (await initResponse.json().catch(() => ({}))) as Record<string, unknown>;
        const videoId = (payload as { id?: string }).id;
        if (videoId) {
          return {
            success: true,
            platform: Platform.YOUTUBE,
            externalPostId: videoId,
            permalink: `https://www.youtube.com/watch?v=${videoId}`,
            publishedAt: new Date(),
          };
        }
        return {
          success: false,
          platform: Platform.YOUTUBE,
          error: {
            kind: 'INVALID_REQUEST', code: null,
            message: 'YouTube accepted the metadata but returned no upload URL or video id.',
            httpStatus: 200,
          },
        };
      }

      const uploadResponse = await request.fetchImpl(uploadUrl, {
        method: 'PUT',
        headers: {
          'content-type': video.mimeType,
          'content-length': String(video.data.length),
        },
        body: video.data,
        signal: controller.signal,
      });

      if (!uploadResponse.ok) {
        const payload = (await uploadResponse.json().catch(() => ({}))) as Record<string, unknown>;
        return { success: false, platform: Platform.YOUTUBE, error: toPublishError(payload, uploadResponse.status) };
      }

      const payload = (await uploadResponse.json().catch(() => ({}))) as Record<string, unknown>;
      const videoId = payload.id as string | undefined;
      if (!videoId) {
        return {
          success: false,
          platform: Platform.YOUTUBE,
          error: {
            kind: 'INVALID_REQUEST', code: null,
            message: 'YouTube accepted the upload but returned no video id, so it cannot be confirmed.',
            httpStatus: 200,
          },
        };
      }

      return {
        success: true,
        platform: Platform.YOUTUBE,
        externalPostId: videoId,
        permalink: `https://www.youtube.com/watch?v=${videoId}`,
        publishedAt: new Date(),
      };
    } catch (cause) {
      const aborted = (cause as { name?: string }).name === 'AbortError';
      const kind: PublishErrorKind = aborted ? 'TIMEOUT' : 'NETWORK';
      return {
        success: false,
        platform: Platform.YOUTUBE,
        error: { kind, code: null, message: EXPLANATION[kind], httpStatus: null },
      };
    } finally {
      clearTimeout(timer);
    }
  },
};

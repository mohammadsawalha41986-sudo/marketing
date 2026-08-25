/**
 * Publishing a video to TikTok via the Content Posting API (direct post).
 *
 * The flow TikTok actually requires, in the order it requires it:
 *
 *   1. POST /v2/post/publish/creator_info/query/   what this creator may do
 *   2. POST /v2/post/publish/video/init/           declare the post, get an upload URL
 *   3. PUT  <upload_url>                           the bytes, with a Content-Range
 *   4. POST /v2/post/publish/status/fetch/         poll until TikTok commits it
 *
 * Step 1 is not optional and not a formality. TikTok rejects a post whose
 * `privacy_level` the creator cannot use, and which levels those are depends on
 * the creator's own account *and* on whether this app has passed TikTok's
 * audit — an unaudited client sees only SELF_ONLY. Skipping the query and
 * sending PUBLIC_TO_EVERYONE means uploading the whole video and being refused
 * at the last step. So the adapter asks first and refuses locally, before any
 * bytes move, with a message naming what the creator can actually pick.
 *
 * Step 4 exists because `init` returns a `publish_id`, which is not a post id.
 * The post does not exist until TikTok finishes processing, and the id we must
 * persist only appears then. Returning the publish_id as though it were the
 * post would put a value in `externalPostId` that no TikTok URL will ever
 * resolve — and the pipeline treats a present externalPostId as proof the post
 * is live, which is what makes that particular shortcut unsafe rather than
 * merely untidy.
 *
 * Idempotency is the service's, not this adapter's: `publishPlatformPost`
 * refuses to run at all when `externalPostId` is already set, and counts
 * attempts and schedules retries around a failure's `kind`. This file performs
 * one publish and reports what happened, like every other adapter.
 */

import { Platform } from '@prisma/client';

import type {
  PlatformPublisher, PublishError, PublishErrorKind, PublishRequest, PublishResult,
} from './contract.js';

const API = 'https://open.tiktokapis.com/v2';
const DEFAULT_TIMEOUT_MS = 180_000;

/** How long to wait for TikTok to finish processing before giving up politely. */
const STATUS_POLL_ATTEMPTS = 10;
const STATUS_POLL_INTERVAL_MS = 3_000;

/** TikTok's own hard limits for a direct post. */
const MAX_CAPTION_CHARS = 2_200;
const MAX_VIDEO_BYTES = 4 * 1024 * 1024 * 1024;
const ACCEPTED_MIME = new Set(['video/mp4', 'video/quicktime', 'video/webm']);

export interface TikTokPostConfig {
  /** One of the creator's own `privacyOptions`. Never assumed. */
  privacyLevel?: string;
  disableComment?: boolean;
  disableDuet?: boolean;
  disableStitch?: boolean;
}

const EXPLANATION: Record<PublishErrorKind, string> = {
  NETWORK: 'Could not reach TikTok.',
  TIMEOUT: 'TikTok did not respond in time.',
  RATE_LIMITED: 'TikTok is rate limiting this app; the post will be retried.',
  PROVIDER_UNAVAILABLE: 'TikTok is temporarily unavailable; the post will be retried.',
  INVALID_TOKEN: 'The TikTok connection has expired. Reconnect the account to post.',
  MISSING_PERMISSION:
    'The connected TikTok account has not granted video.publish, so this app cannot post for it. Reconnect and accept the posting permission.',
  INVALID_ACCOUNT: 'TikTok does not recognise this creator account for the connected app.',
  INVALID_MEDIA: 'TikTok requires a video file.',
  INVALID_REQUEST: 'TikTok rejected the post.',
  NOT_CONFIGURED: 'TikTok publishing is not configured on this deployment.',
};

/**
 * TikTok's own error codes, mapped to the retry decision.
 *
 * Codes rather than HTTP status where TikTok gives one, because it answers a
 * great many failures with HTTP 200 and an error object — classifying on status
 * alone would file a permanent permission failure as a success.
 */
function classifyCode(code: string | null, status: number): PublishErrorKind {
  switch (code) {
    case 'access_token_invalid':
    case 'token_expired':
      return 'INVALID_TOKEN';
    case 'scope_not_authorized':
    case 'scope_permission_missed':
      return 'MISSING_PERMISSION';
    case 'rate_limit_exceeded':
    case 'spam_risk_too_many_posts':
    case 'spam_risk_user_banned_from_posting':
      return 'RATE_LIMITED';
    case 'file_format_check_failed':
    case 'duration_check_failed':
    case 'frame_rate_check_failed':
    case 'picture_size_check_failed':
    case 'video_pull_failed':
      return 'INVALID_MEDIA';
    case 'privacy_level_option_mismatch':
    case 'invalid_params':
      return 'INVALID_REQUEST';
    case 'internal_error':
      return 'PROVIDER_UNAVAILABLE';
    default:
      break;
  }

  if (status === 401) return 'INVALID_TOKEN';
  if (status === 403) return 'MISSING_PERMISSION';
  if (status === 404) return 'INVALID_ACCOUNT';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'PROVIDER_UNAVAILABLE';
  return 'INVALID_REQUEST';
}

function fail(kind: PublishErrorKind, detail?: string, code: string | null = null, status: number | null = null): PublishResult {
  const message = detail ? `${EXPLANATION[kind]} ${detail}` : EXPLANATION[kind];
  return {
    success: false,
    platform: Platform.TIKTOK,
    error: { kind, code, message, httpStatus: status } satisfies PublishError,
  };
}

/** TikTok's envelope: `{ data, error: { code, message } }`, error even on 200. */
function envelopeError(payload: unknown): { code: string | null; message: string | null } {
  const error = (payload as { error?: { code?: string; message?: string } } | undefined)?.error;
  if (!error?.code || error.code === 'ok') return { code: null, message: null };
  return { code: error.code, message: error.message ?? null };
}

export const tiktokPublisher: PlatformPublisher = {
  platform: Platform.TIKTOK,
  label: 'TikTok',
  canPublish: true,

  async publish(request: PublishRequest): Promise<PublishResult> {
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const config = (request.config ?? {}) as TikTokPostConfig;

    // ---- local validation, before any bytes move -------------------------
    const video = request.media.find((item) => item.kind === 'VIDEO');
    if (!video) {
      return fail(
        'INVALID_MEDIA',
        'This post has no video attached. TikTok has no image or text-only post through its API.',
      );
    }
    if (!ACCEPTED_MIME.has(video.mimeType)) {
      return fail(
        'INVALID_MEDIA',
        `TikTok does not accept ${video.mimeType}. Use MP4, MOV or WebM.`,
      );
    }
    if (video.data.length > MAX_VIDEO_BYTES) {
      return fail('INVALID_MEDIA', 'The video is larger than TikTok\'s 4GB limit.');
    }

    const caption = request.caption.slice(0, MAX_CAPTION_CHARS);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const authHeaders = {
      authorization: `Bearer ${request.account.accessToken}`,
      'content-type': 'application/json; charset=UTF-8',
    };

    try {
      // ---- 1. what this creator may actually do --------------------------
      const infoResponse = await request.fetchImpl(`${API}/post/publish/creator_info/query/`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({}),
        signal: controller.signal,
      });
      const infoPayload = (await infoResponse.json().catch(() => ({}))) as Record<string, unknown>;
      const infoError = envelopeError(infoPayload);

      if (infoError.code || !infoResponse.ok) {
        const kind = classifyCode(infoError.code, infoResponse.status);
        return fail(kind, infoError.message ? `TikTok said: ${infoError.message}` : undefined, infoError.code, infoResponse.status);
      }

      const info = (infoPayload.data ?? {}) as Record<string, unknown>;
      const privacyOptions = Array.isArray(info.privacy_level_options)
        ? (info.privacy_level_options as unknown[]).map(String)
        : [];

      if (privacyOptions.length === 0) {
        return fail(
          'MISSING_PERMISSION',
          'TikTok returned no available privacy levels for this creator, which means this app cannot post on their behalf yet.',
        );
      }

      /*
       * The requested level must be one the creator actually has. Defaulting to
       * the first option rather than to PUBLIC_TO_EVERYONE is deliberate: on an
       * unaudited app the only option is SELF_ONLY, and silently upgrading that
       * to public is the one mistake here that cannot be undone by the operator.
       */
      const requested = config.privacyLevel;
      if (requested && !privacyOptions.includes(requested)) {
        return fail(
          'INVALID_REQUEST',
          `This TikTok account cannot post as ${requested}. It allows: ${privacyOptions.join(', ')}.`,
          'privacy_level_option_mismatch',
        );
      }
      const privacyLevel = requested ?? privacyOptions[0];

      const maxDuration = typeof info.max_video_post_duration_sec === 'number'
        ? info.max_video_post_duration_sec
        : null;

      // ---- 2. declare the post, get an upload URL ------------------------
      const initResponse = await request.fetchImpl(`${API}/post/publish/video/init/`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          post_info: {
            title: caption,
            privacy_level: privacyLevel,
            // TikTok inverts these against the creator's own settings: an
            // account with comments off cannot be overridden into having them
            // on, so the creator's value wins over ours.
            disable_comment: Boolean(info.comment_disabled) || Boolean(config.disableComment),
            disable_duet: Boolean(info.duet_disabled) || Boolean(config.disableDuet),
            disable_stitch: Boolean(info.stitch_disabled) || Boolean(config.disableStitch),
          },
          source_info: {
            /*
             * FILE_UPLOAD rather than PULL_FROM_URL. The alternative hands
             * TikTok a link and lets it fetch — but this application serves
             * media from an authenticated endpoint, so TikTok would receive a
             * login page. Making PULL_FROM_URL work would mean publishing every
             * customer's creative at an unauthenticated URL.
             */
            source: 'FILE_UPLOAD',
            video_size: video.data.length,
            chunk_size: video.data.length,
            total_chunk_count: 1,
          },
        }),
        signal: controller.signal,
      });

      const initPayload = (await initResponse.json().catch(() => ({}))) as Record<string, unknown>;
      const initError = envelopeError(initPayload);

      if (initError.code || !initResponse.ok) {
        const kind = classifyCode(initError.code, initResponse.status);
        const hint = kind === 'INVALID_MEDIA' && maxDuration
          ? ` This account's maximum video length is ${maxDuration}s.`
          : '';
        return fail(
          kind,
          `${initError.message ? `TikTok said: ${initError.message}` : ''}${hint}`.trim() || undefined,
          initError.code,
          initResponse.status,
        );
      }

      const initData = (initPayload.data ?? {}) as Record<string, unknown>;
      const publishId = initData.publish_id as string | undefined;
      const uploadUrl = initData.upload_url as string | undefined;

      if (!publishId || !uploadUrl) {
        return fail(
          'INVALID_REQUEST',
          'TikTok accepted the post but returned no upload URL, so the video cannot be sent.',
          null,
          initResponse.status,
        );
      }

      // ---- 3. the bytes --------------------------------------------------
      const uploadResponse = await request.fetchImpl(uploadUrl, {
        method: 'PUT',
        headers: {
          'content-type': video.mimeType,
          'content-length': String(video.data.length),
          // Single chunk, so the range is the whole file. TikTok requires this
          // header even when there is only one chunk.
          'content-range': `bytes 0-${video.data.length - 1}/${video.data.length}`,
        },
        body: video.data,
        signal: controller.signal,
      });

      if (!uploadResponse.ok) {
        const kind = classifyCode(null, uploadResponse.status);
        return fail(kind, 'The video upload to TikTok did not complete.', null, uploadResponse.status);
      }

      // ---- 4. wait for TikTok to commit it -------------------------------
      const settled = await awaitPublish({
        request, publishId, headers: authHeaders, signal: controller.signal,
      });
      return settled;
    } catch (cause) {
      const aborted = (cause as { name?: string }).name === 'AbortError';
      const kind: PublishErrorKind = aborted ? 'TIMEOUT' : 'NETWORK';
      return fail(kind);
    } finally {
      clearTimeout(timer);
    }
  },
};

/**
 * Poll until TikTok publishes, fails, or we run out of patience.
 *
 * Running out of patience is reported as PROVIDER_UNAVAILABLE — a retryable
 * kind — and that is the right answer rather than a failure: the post may well
 * be moments from going live, and the service's idempotency guard means a retry
 * that finds it published will not post it twice.
 */
async function awaitPublish(input: {
  request: PublishRequest;
  publishId: string;
  headers: Record<string, string>;
  signal: AbortSignal;
}): Promise<PublishResult> {
  const { request, publishId, headers, signal } = input;

  for (let attempt = 0; attempt < STATUS_POLL_ATTEMPTS; attempt += 1) {
    const response = await request.fetchImpl(`${API}/post/publish/status/fetch/`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ publish_id: publishId }),
      signal,
    });

    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const error = envelopeError(payload);

    if (error.code || !response.ok) {
      const kind = classifyCode(error.code, response.status);
      return fail(kind, error.message ? `TikTok said: ${error.message}` : undefined, error.code, response.status);
    }

    const data = (payload.data ?? {}) as Record<string, unknown>;
    const status = String(data.status ?? '');

    if (status === 'PUBLISH_COMPLETE') {
      const ids = Array.isArray(data.publicaly_available_post_id)
        ? (data.publicaly_available_post_id as unknown[]).map(String)
        : [];
      /*
       * A post published SELF_ONLY has no publicly available id — that is not a
       * failure, it is what private means. The publish_id is then the only
       * durable handle TikTok gives us, so it is recorded as the external id
       * and the permalink is null rather than a URL that would 404.
       */
      const postId = ids[0] ?? publishId;
      return {
        success: true,
        platform: Platform.TIKTOK,
        externalPostId: postId,
        permalink: ids[0] ? `https://www.tiktok.com/@${request.account.name}/video/${ids[0]}` : null,
        publishedAt: new Date(),
      };
    }

    if (status === 'FAILED') {
      const reason = String(data.fail_reason ?? '') || null;
      const kind = classifyCode(reason, response.status);
      return fail(kind, reason ? `TikTok said: ${reason}` : undefined, reason, response.status);
    }

    // PROCESSING_UPLOAD / PROCESSING_DOWNLOAD / SEND_TO_USER_INBOX — keep waiting.
    if (attempt < STATUS_POLL_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_INTERVAL_MS));
    }
  }

  return fail(
    'PROVIDER_UNAVAILABLE',
    'TikTok is still processing the video. It will be checked again on the next attempt.',
    null,
  );
}

/**
 * Publishing a post to an Instagram Professional account.
 *
 * Instagram's Content Publishing API is two calls, not one:
 *
 *   1. POST /{ig-user-id}/media          image_url + caption  → a creation id
 *   2. POST /{ig-user-id}/media_publish  creation_id          → the published id
 *
 * The container is Meta ingesting the image; the publish turns it into a post.
 * Splitting it is not our choice — it is the API — and a publisher that tried to
 * collapse it into one call would simply fail.
 *
 * The hard constraint, and the reason this is not a drop-in copy of the Facebook
 * adapter: step 1 takes an `image_url`, which Meta fetches itself. It must be a
 * public, un-authenticated URL. This application serves media from an
 * authenticated endpoint, so until there is a public delivery URL for a
 * creative, Instagram publishing cannot complete — and this adapter says so with
 * INVALID_MEDIA rather than sending Meta a link it will fail to fetch. That is
 * an honest READY-but-blocked state, not a broken one: the flow is correct and
 * proven against mocks; what is missing is public media delivery and App Review
 * for `instagram_content_publish`.
 */

import { Platform } from '@prisma/client';

import { GRAPH_VERSION } from '../integrations/meta.js';
import type {
  FetchLike, PlatformPublisher, PublishError, PublishErrorKind, PublishRequest, PublishResult,
} from './contract.js';

const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const DEFAULT_TIMEOUT_MS = 60_000;

/** Meta's error codes, mapped the same way the Facebook adapter maps them. */
function classify(code: number | null, subcode: number | null, status: number): PublishErrorKind {
  if (code === 190) return 'INVALID_TOKEN';
  if (code === 10 || (code !== null && code >= 200 && code <= 299)) return 'MISSING_PERMISSION';
  if (code === 4 || code === 17 || code === 613 || status === 429) return 'RATE_LIMITED';
  if (code === 1 || code === 2 || status >= 500) return 'PROVIDER_UNAVAILABLE';
  if (code === 100 && subcode === 33) return 'INVALID_ACCOUNT';
  // 9004 is Instagram's "media could not be fetched" — the exact failure a
  // non-public URL produces.
  if (code === 9004 || code === 2207052) return 'INVALID_MEDIA';
  return 'INVALID_REQUEST';
}

interface GraphError { message?: string; code?: number; error_subcode?: number; error_user_msg?: string }

function toPublishError(payload: unknown, status: number): PublishError {
  const error = (payload as { error?: GraphError } | undefined)?.error;
  const code = typeof error?.code === 'number' ? error.code : null;
  const subcode = typeof error?.error_subcode === 'number' ? error.error_subcode : null;
  const kind = classify(code, subcode, status);
  const providerText = error?.error_user_msg ?? error?.message ?? `Instagram returned HTTP ${status}`;

  return {
    kind,
    code: code === null ? null : String(code),
    message: `${EXPLANATION[kind]} Instagram said: ${providerText}`,
    httpStatus: status,
  };
}

const EXPLANATION: Record<PublishErrorKind, string> = {
  NETWORK: 'Could not reach Instagram.',
  TIMEOUT: 'Instagram did not respond in time.',
  RATE_LIMITED: 'Instagram is rate limiting this app; the post will be retried.',
  PROVIDER_UNAVAILABLE: 'Instagram is temporarily unavailable; the post will be retried.',
  INVALID_TOKEN: 'The Instagram connection has expired. Reconnect the account to publish.',
  MISSING_PERMISSION:
    'The connected Meta app cannot publish to this Instagram account (instagram_content_publish).',
  INVALID_ACCOUNT: 'Instagram does not recognise this professional account for the connected app.',
  INVALID_MEDIA: 'Instagram could not fetch the image. It must be a publicly reachable URL.',
  INVALID_REQUEST: 'Instagram rejected the post.',
  NOT_CONFIGURED: 'Instagram publishing is not configured on this deployment.',
};

async function post(
  url: string,
  body: Record<string, string>,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; error: PublishError }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) return { ok: false, error: toPublishError(payload, response.status) };
    return { ok: true, payload };
  } catch (cause) {
    const aborted = (cause as { name?: string }).name === 'AbortError';
    const kind: PublishErrorKind = aborted ? 'TIMEOUT' : 'NETWORK';
    return { ok: false, error: { kind, code: null, message: EXPLANATION[kind], httpStatus: null } };
  } finally {
    clearTimeout(timer);
  }
}

export const instagramPublisher: PlatformPublisher = {
  platform: Platform.INSTAGRAM,
  label: 'Instagram Professional',
  canPublish: true,

  async publish(request: PublishRequest): Promise<PublishResult> {
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const igUserId = request.account.externalId;
    const image = request.media.find((item) => item.kind === 'IMAGE');

    // A feed post needs an image, and that image needs a public URL Meta can
    // fetch. Both are hard requirements of the API, checked before any call so
    // the failure is one clear message rather than a confusing 400 from Meta.
    if (!image) {
      return refuse('Instagram requires an image. Attach one to this post.');
    }
    if (!image.publicUrl) {
      return refuse(
        'Instagram fetches the image itself, so it needs a publicly reachable URL. ' +
        'This creative is served from an authenticated endpoint and has no public URL yet.',
      );
    }

    // Step 1 — the container.
    const container = await post(
      `${GRAPH}/${igUserId}/media`,
      { image_url: image.publicUrl, caption: request.caption, access_token: request.account.accessToken },
      request.fetchImpl,
      timeoutMs,
    );
    if (!container.ok) return { success: false, platform: Platform.INSTAGRAM, error: container.error };

    const creationId = container.payload.id as string | undefined;
    if (!creationId) {
      return refuse('Instagram accepted the image but returned no container id, so it cannot be published.');
    }

    // Step 2 — publish the container.
    const published = await post(
      `${GRAPH}/${igUserId}/media_publish`,
      { creation_id: creationId, access_token: request.account.accessToken },
      request.fetchImpl,
      timeoutMs,
    );
    if (!published.ok) return { success: false, platform: Platform.INSTAGRAM, error: published.error };

    const postId = published.payload.id as string | undefined;
    if (!postId) {
      return refuse('Instagram published the container but returned no post id, so the post cannot be confirmed.');
    }

    return {
      success: true,
      platform: Platform.INSTAGRAM,
      externalPostId: postId,
      // Instagram permalinks need a second lookup; the id is enough to confirm.
      permalink: null,
      publishedAt: new Date(),
    };
  },
};

function refuse(message: string): PublishResult {
  return {
    success: false,
    platform: Platform.INSTAGRAM,
    error: { kind: 'INVALID_MEDIA', code: null, message, httpStatus: null },
  };
}

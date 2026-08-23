/**
 * Publishing a post to a Facebook Page.
 *
 * Two endpoints, chosen by whether there is an image:
 *
 *   text          POST /{page-id}/feed      message
 *   single image  POST /{page-id}/photos    url + caption
 *
 * Both are called with the **Page** access token. The user token that discovered
 * the Page cannot post as it — Meta treats them as different actors, and using
 * the wrong one fails with a permissions error that reads as though the app were
 * missing a scope. `IntegrationAccount.accessTokenEnc` holds the right one.
 *
 * `/photos` takes a `url` and Meta fetches the image itself, which is why the
 * media URL has to be absolute and reachable from outside this network. A
 * localhost URL, a signed URL that has expired, or a path relative to the SPA
 * all fail here — in production, at the moment of publication.
 *
 * Multi-image posts are deliberately not implemented: they need each photo
 * uploaded unpublished and then attached to a feed post, which is a different
 * enough sequence that pretending one image is the general case would be a lie
 * the caller acts on. The service refuses them up front instead.
 */

import { Platform } from '@prisma/client';

import { GRAPH_VERSION } from '../integrations/meta.js';
import type {
  FetchLike, PlatformPublisher, PublishError, PublishErrorKind, PublishRequest, PublishResult,
} from './contract.js';

const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Meta's error codes, mapped to what an operator should do about them.
 *
 * Meta reports almost everything as an OAuthException with a numeric `code` and
 * a `error_subcode`, so the type alone says nothing useful. These are the codes
 * that actually occur on a publish path, and the mapping decides retry versus
 * human — see `contract.ts` for why that distinction earns its own type.
 */
function classify(code: number | null, subcode: number | null, status: number): PublishErrorKind {
  // 190 is the whole family of "this token will not work": expired, revoked,
  // password changed, session invalidated.
  if (code === 190) return 'INVALID_TOKEN';
  // 10 and the 200s are permission problems. 200 specifically is what a Page
  // publish returns when pages_manage_posts was never granted.
  if (code === 10 || (code !== null && code >= 200 && code <= 299)) return 'MISSING_PERMISSION';
  // 4 and 17 are app- and user-level rate limits; 613 is a custom-rate limit.
  if (code === 4 || code === 17 || code === 613 || status === 429) return 'RATE_LIMITED';
  // 1 and 2 are Meta's own "unknown" and "service temporarily unavailable".
  if (code === 1 || code === 2 || status >= 500) return 'PROVIDER_UNAVAILABLE';
  // 100 with subcode 33 is the shape an unreachable or non-existent object takes
  // — including a Page id the token cannot see.
  if (code === 100 && subcode === 33) return 'INVALID_ACCOUNT';
  if (code === 324 || code === 324_00) return 'INVALID_MEDIA';
  return 'INVALID_REQUEST';
}

/** Meta's error envelope, as it actually arrives. */
interface GraphError {
  message?: string;
  code?: number;
  error_subcode?: number;
  error_user_msg?: string;
}

function toPublishError(payload: unknown, status: number): PublishError {
  const error = (payload as { error?: GraphError } | undefined)?.error;
  const code = typeof error?.code === 'number' ? error.code : null;
  const subcode = typeof error?.error_subcode === 'number' ? error.error_subcode : null;
  const kind = classify(code, subcode, status);

  /*
   * `error_user_msg` is Meta's own text written for an end user and is better
   * than `message` when present. Neither is trusted to be actionable, so the
   * kind carries the meaning and the provider's words are appended as evidence.
   */
  const providerText = error?.error_user_msg ?? error?.message ?? `Meta returned HTTP ${status}`;

  return {
    kind,
    code: code === null ? null : String(code),
    message: `${EXPLANATION[kind]} Meta said: ${providerText}`,
    httpStatus: status,
  };
}

/** What each failure means for the person who has to fix it. */
const EXPLANATION: Record<PublishErrorKind, string> = {
  NETWORK: 'Could not reach Facebook.',
  TIMEOUT: 'Facebook did not respond in time.',
  RATE_LIMITED: 'Facebook is rate limiting this app; the post will be retried.',
  PROVIDER_UNAVAILABLE: 'Facebook is temporarily unavailable; the post will be retried.',
  INVALID_TOKEN: 'The Facebook Page connection has expired. Reconnect the Page to publish.',
  MISSING_PERMISSION:
    'The connected Meta app does not have permission to publish to this Page (pages_manage_posts).',
  INVALID_ACCOUNT: 'Facebook does not recognise this Page for the connected account.',
  INVALID_MEDIA: 'Facebook rejected the image.',
  INVALID_REQUEST: 'Facebook rejected the post.',
  NOT_CONFIGURED: 'Facebook publishing is not configured on this deployment.',
};

async function post(
  url: string,
  body: URLSearchParams | FormData,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; error: PublishError }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      // FormData sets its own multipart boundary; setting content-type by hand
      // would omit it and the upload would be unparseable.
      headers:
        body instanceof URLSearchParams
          ? { 'content-type': 'application/x-www-form-urlencoded' }
          : {},
      body,
      signal: controller.signal,
    });

    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) return { ok: false, error: toPublishError(payload, response.status) };
    return { ok: true, payload };
  } catch (cause) {
    // An abort is our timeout, not Facebook's refusal — and it is retryable,
    // whereas most things that throw here are not distinguishable from one.
    const aborted = (cause as { name?: string }).name === 'AbortError';
    const kind: PublishErrorKind = aborted ? 'TIMEOUT' : 'NETWORK';
    return {
      ok: false,
      error: {
        kind,
        code: null,
        // The thrown message can carry a URL with the token in its query string.
        // Only the classification crosses this boundary.
        message: EXPLANATION[kind],
        httpStatus: null,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

export const facebookPublisher: PlatformPublisher = {
  platform: Platform.FACEBOOK,
  label: 'Facebook Page',
  canPublish: true,

  async publish(request: PublishRequest): Promise<PublishResult> {
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pageId = request.account.externalId;
    const image = request.media.find((item) => item.kind === 'IMAGE');

    let target: string;
    let body: URLSearchParams | FormData;

    if (image) {
      /*
       * `source` uploads the bytes. The alternative parameter, `url`, asks Meta
       * to fetch the image itself — which cannot work here, because this
       * application serves media from an authenticated endpoint.
       */
      target = `${GRAPH}/${pageId}/photos`;
      const form = new FormData();
      form.append('caption', request.caption);
      form.append('access_token', request.account.accessToken);
      form.append(
        'source',
        new Blob([new Uint8Array(image.data)], { type: image.mimeType }),
        image.filename,
      );
      body = form;
    } else {
      target = `${GRAPH}/${pageId}/feed`;
      body = new URLSearchParams({
        message: request.caption,
        access_token: request.account.accessToken,
      });
    }

    const result = await post(target, body, request.fetchImpl, timeoutMs);
    if (!result.ok) return { success: false, platform: Platform.FACEBOOK, error: result.error };

    /*
     * `/photos` answers with the photo id and a `post_id` for the feed story it
     * created; `/feed` answers with the post id as `id`. The feed story is the
     * thing a person can open, so it wins when both are present.
     */
    const postId =
      (result.payload.post_id as string | undefined) ?? (result.payload.id as string | undefined);

    if (!postId) {
      // A 200 with no id is not a success. Reporting one would record a post
      // that cannot be found, linked to, or measured.
      return {
        success: false,
        platform: Platform.FACEBOOK,
        error: {
          kind: 'INVALID_REQUEST',
          code: null,
          message: 'Facebook accepted the request but returned no post id, so the post cannot be confirmed.',
          httpStatus: 200,
        },
      };
    }

    return {
      success: true,
      platform: Platform.FACEBOOK,
      externalPostId: postId,
      permalink: `https://www.facebook.com/${postId}`,
      publishedAt: new Date(),
    };
  },
};

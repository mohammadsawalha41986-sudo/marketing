/**
 * Publishing a post to a LinkedIn organization page.
 *
 * LinkedIn's publishing is its own API, not Graph: `POST /rest/posts` with a
 * JSON body and an author URN (`urn:li:organization:{id}`). A text post is one
 * call. An image post is three — register an upload, PUT the bytes, then
 * reference the returned image URN in the post — so image support is deferred
 * and this adapter publishes text, refusing an image with a clear reason rather
 * than dropping it silently.
 *
 * Like Instagram, the flow is correct and proven against mocks; what is missing
 * is external. LinkedIn's Community Management API requires the app to be
 * approved for `w_organization_social`, which no code can grant itself. So this
 * is registered as a real publisher that runs the real request and is honest
 * about the one thing it cannot do yet.
 */

import { Platform } from '@prisma/client';

import type {
  PlatformPublisher, PublishError, PublishErrorKind, PublishRequest, PublishResult,
} from './contract.js';

const API = 'https://api.linkedin.com/rest';
const VERSION = '202405';
const DEFAULT_TIMEOUT_MS = 30_000;

const EXPLANATION: Record<PublishErrorKind, string> = {
  NETWORK: 'Could not reach LinkedIn.',
  TIMEOUT: 'LinkedIn did not respond in time.',
  RATE_LIMITED: 'LinkedIn is rate limiting this app; the post will be retried.',
  PROVIDER_UNAVAILABLE: 'LinkedIn is temporarily unavailable; the post will be retried.',
  INVALID_TOKEN: 'The LinkedIn connection has expired. Reconnect the page to publish.',
  MISSING_PERMISSION:
    'The connected app cannot post to this LinkedIn page (w_organization_social).',
  INVALID_ACCOUNT: 'LinkedIn does not recognise this organization for the connected app.',
  INVALID_MEDIA: 'LinkedIn image posting is not implemented yet; post text only for now.',
  INVALID_REQUEST: 'LinkedIn rejected the post.',
  NOT_CONFIGURED: 'LinkedIn publishing is not configured on this deployment.',
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
  const message = (payload as { message?: string } | undefined)?.message ?? `LinkedIn returned HTTP ${status}`;
  const kind = classify(status);
  return { kind, code: String(status), message: `${EXPLANATION[kind]} LinkedIn said: ${message}`, httpStatus: status };
}

export const linkedInPublisher: PlatformPublisher = {
  platform: Platform.LINKEDIN,
  label: 'LinkedIn Page',
  canPublish: true,

  async publish(request: PublishRequest): Promise<PublishResult> {
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (request.media.length > 0) {
      // Not a silent drop: the operator attached an image expecting it to post.
      return {
        success: false,
        platform: Platform.LINKEDIN,
        error: { kind: 'INVALID_MEDIA', code: null, message: EXPLANATION.INVALID_MEDIA, httpStatus: null },
      };
    }

    const author = `urn:li:organization:${request.account.externalId}`;
    const body = {
      author,
      commentary: request.caption,
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await request.fetchImpl(`${API}/posts`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${request.account.accessToken}`,
          'content-type': 'application/json',
          'linkedin-version': VERSION,
          'x-restli-protocol-version': '2.0.0',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        return { success: false, platform: Platform.LINKEDIN, error: toPublishError(payload, response.status) };
      }

      // LinkedIn returns the post URN in the x-restli-id header; the JSON body
      // may also carry an id. Either confirms the post exists.
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const postId = (payload.id as string | undefined) ?? undefined;
      if (!postId) {
        return {
          success: false,
          platform: Platform.LINKEDIN,
          error: {
            kind: 'INVALID_REQUEST', code: null,
            message: 'LinkedIn accepted the request but returned no post id, so it cannot be confirmed.',
            httpStatus: 200,
          },
        };
      }

      return {
        success: true,
        platform: Platform.LINKEDIN,
        externalPostId: postId,
        permalink: `https://www.linkedin.com/feed/update/${postId}`,
        publishedAt: new Date(),
      };
    } catch (cause) {
      const aborted = (cause as { name?: string }).name === 'AbortError';
      const kind: PublishErrorKind = aborted ? 'TIMEOUT' : 'NETWORK';
      return {
        success: false,
        platform: Platform.LINKEDIN,
        error: { kind, code: null, message: EXPLANATION[kind], httpStatus: null },
      };
    } finally {
      clearTimeout(timer);
    }
  },
};

/**
 * Publishing a post to a Google Business Profile location.
 *
 * Google Business Profile's Local Posts API creates posts visible on a
 * business's Google Maps listing and Knowledge Panel. The API endpoint is:
 *   POST https://mybusiness.googleapis.com/v4/accounts/{accountId}/locations/{locationId}/localPosts
 *
 * Three post types are supported, mapped through PlatformPost.config:
 *   - UPDATE  (default) — text + optional image
 *   - OFFER   — text + CTA, optional coupon code and redemption URL
 *   - EVENT   — text + event title, start/end dates
 *
 * Image posting is a single call: the image URL is passed in the
 * `mediaItem` field and Google fetches it. Like Instagram, this requires a
 * publicly accessible URL — the adapter refuses with INVALID_MEDIA if
 * media is provided without a publicUrl.
 *
 * The adapter is honest: canPublish is true, but the Google Business
 * Profile API requires OAuth2 with `https://www.googleapis.com/auth/business.manage`
 * scope, which is an external approval requirement.
 */

import { Platform } from '@prisma/client';

import type {
  PlatformPublisher, PublishError, PublishErrorKind, PublishRequest, PublishResult,
} from './contract.js';

const API = 'https://mybusiness.googleapis.com/v4';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface GoogleBusinessConfig {
  locationId: string;
  postType?: 'UPDATE' | 'OFFER' | 'EVENT';
  eventTitle?: string;
  eventStartDate?: string;
  eventEndDate?: string;
  couponCode?: string;
  redeemOnlineUrl?: string;
  callToActionType?: string;
  callToActionUrl?: string;
}

const EXPLANATION: Record<PublishErrorKind, string> = {
  NETWORK: 'Could not reach Google Business Profile.',
  TIMEOUT: 'Google Business Profile did not respond in time.',
  RATE_LIMITED: 'Google is rate limiting this app; the post will be retried.',
  PROVIDER_UNAVAILABLE: 'Google Business Profile is temporarily unavailable; the post will be retried.',
  INVALID_TOKEN: 'The Google connection has expired. Reconnect the account to publish.',
  MISSING_PERMISSION:
    'The connected Google account cannot manage this business location (business.manage scope required).',
  INVALID_ACCOUNT: 'Google does not recognise this business location for the connected account.',
  INVALID_MEDIA: 'Google Business requires a publicly accessible image URL. Upload media to a public location first.',
  INVALID_REQUEST: 'Google Business Profile rejected the post.',
  NOT_CONFIGURED: 'Google Business Profile publishing is not configured on this deployment.',
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
  const error = (payload as { error?: { message?: string } } | undefined)?.error;
  const message = error?.message ?? `Google returned HTTP ${status}`;
  const kind = classify(status);
  return { kind, code: String(status), message: `${EXPLANATION[kind]} Google said: ${message}`, httpStatus: status };
}

function parseDate(dateStr: string): { year: number; month: number; day: number } {
  const d = new Date(dateStr);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function buildTimeInterval(startDate: string, endDate: string) {
  return {
    startDate: parseDate(startDate),
    startTime: { hours: 0, minutes: 0 },
    endDate: parseDate(endDate),
    endTime: { hours: 23, minutes: 59 },
  };
}

export const googleBusinessPublisher: PlatformPublisher = {
  platform: Platform.GOOGLE_BUSINESS,
  label: 'Google Business Profile',
  canPublish: true,

  async publish(request: PublishRequest): Promise<PublishResult> {
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const config = (request as { config?: GoogleBusinessConfig }).config as GoogleBusinessConfig | undefined;
    const locationId = config?.locationId ?? request.account.externalId;
    const postType = config?.postType ?? 'UPDATE';

    if (request.media.length > 0) {
      const image = request.media[0];
      if (!image?.publicUrl) {
        return {
          success: false,
          platform: Platform.GOOGLE_BUSINESS,
          error: { kind: 'INVALID_MEDIA', code: null, message: EXPLANATION.INVALID_MEDIA, httpStatus: null },
        };
      }
    }

    const body: Record<string, unknown> = {
      languageCode: 'en',
      summary: request.caption,
      topicType: postType === 'UPDATE' ? 'STANDARD' : postType,
    };

    if (request.media.length > 0 && request.media[0]?.publicUrl) {
      body.media = [{ mediaFormat: 'PHOTO', sourceUrl: request.media[0].publicUrl }];
    }

    if (postType === 'EVENT' && config?.eventTitle && config?.eventStartDate && config?.eventEndDate) {
      body.event = {
        title: config.eventTitle,
        schedule: buildTimeInterval(config.eventStartDate, config.eventEndDate),
      };
      body.topicType = 'EVENT';
    }

    if (postType === 'OFFER' && config) {
      body.topicType = 'OFFER';
      body.offer = {
        couponCode: config.couponCode ?? undefined,
        redeemOnlineUrl: config.redeemOnlineUrl ?? undefined,
      };
    }

    if (config?.callToActionType && config?.callToActionUrl) {
      body.callToAction = {
        actionType: config.callToActionType,
        url: config.callToActionUrl,
      };
    }

    const accountId = request.account.externalId;
    const url = `${API}/accounts/${accountId}/locations/${locationId}/localPosts`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await request.fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${request.account.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        return { success: false, platform: Platform.GOOGLE_BUSINESS, error: toPublishError(payload, response.status) };
      }

      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const postName = payload.name as string | undefined;
      if (!postName) {
        return {
          success: false,
          platform: Platform.GOOGLE_BUSINESS,
          error: {
            kind: 'INVALID_REQUEST', code: null,
            message: 'Google accepted the request but returned no post name, so it cannot be confirmed.',
            httpStatus: 200,
          },
        };
      }

      const searchUrl = payload.searchUrl as string | undefined;

      return {
        success: true,
        platform: Platform.GOOGLE_BUSINESS,
        externalPostId: postName,
        permalink: searchUrl ?? null,
        publishedAt: new Date(),
      };
    } catch (cause) {
      const aborted = (cause as { name?: string }).name === 'AbortError';
      const kind: PublishErrorKind = aborted ? 'TIMEOUT' : 'NETWORK';
      return {
        success: false,
        platform: Platform.GOOGLE_BUSINESS,
        error: { kind, code: null, message: EXPLANATION[kind], httpStatus: null },
      };
    } finally {
      clearTimeout(timer);
    }
  },
};

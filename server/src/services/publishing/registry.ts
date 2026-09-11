/**
 * Which platforms can actually publish, and which only have a seat reserved.
 *
 * Every platform the product names appears here. The ones without an adapter
 * are present as explicit refusals rather than absent, because "TikTok is not
 * built" and "TikTok was forgotten" look identical from a missing map entry —
 * and the first is something the UI can tell an operator honestly.
 *
 * Adding a platform is: write an adapter against `PlatformPublisher`, swap its
 * entry here. Nothing in the service, scheduler, worker or state machine
 * changes, which is the property this indirection exists to buy.
 */

import { Platform } from '@prisma/client';

import { routablePlatforms } from '../integrations/upload-post.js';

import type { PlatformPublisher, PublishRequest, PublishResult } from './contract.js';
import { facebookPublisher } from './facebook.js';
import { googleBusinessPublisher } from './google-business.js';
import { instagramPublisher } from './instagram.js';
import { linkedInPublisher } from './linkedin.js';
import { tiktokPublisher } from './tiktok.js';
import { youtubePublisher } from './youtube.js';
import { uploadPostPublisher } from './upload-post.js';
import type { PublishRoute } from './route.js';

/** A publisher that refuses, and says why, for a platform with no adapter yet. */
function notImplemented(platform: Platform, label: string): PlatformPublisher {
  return {
    platform,
    label,
    canPublish: false,
    async publish(_request: PublishRequest): Promise<PublishResult> {
      return {
        success: false,
        platform,
        error: {
          kind: 'NOT_CONFIGURED',
          code: null,
          message: `${label} publishing is not implemented yet.`,
          httpStatus: null,
        },
      };
    },
  };
}

const PUBLISHERS: Partial<Record<Platform, PlatformPublisher>> = {
  [Platform.FACEBOOK]: facebookPublisher,

  // The two-step container/publish flow is implemented and proven against mocks.
  // It stays gated on two external requirements it cannot satisfy itself: App
  // Review for instagram_content_publish, and a public delivery URL for media
  // (the adapter refuses rather than send Meta an authenticated link).
  [Platform.INSTAGRAM]: instagramPublisher,
  /*
   * Direct post through the Content Posting API. The adapter reads the
   * creator's own privacy options before uploading rather than assuming them,
   * because an unaudited TikTok app may only post SELF_ONLY and sending a
   * public level would be refused after the whole video had been sent.
   */
  [Platform.TIKTOK]: tiktokPublisher,
  // Text posting implemented against the real /rest/posts API; image posting
  // and the w_organization_social approval are the outstanding work.
  [Platform.LINKEDIN]: linkedInPublisher,
  [Platform.GOOGLE_BUSINESS]: googleBusinessPublisher,
  [Platform.YOUTUBE]: youtubePublisher,
  [Platform.X]: notImplemented(Platform.X, 'X'),
};

/**
 * The Upload-Post route's publisher for each network, built once.
 *
 * Bound per platform for the same reason the direct table is keyed by one:
 * everything downstream takes a `PlatformPublisher` for a single network, and a
 * publisher that had to be told which network at call time would be one more
 * thing the service could get wrong.
 */
const UPLOAD_POST_PUBLISHERS = new Map<Platform, PlatformPublisher>(
  routablePlatforms().map((platform) => [platform, uploadPostPublisher(platform)]),
);

/**
 * The publisher for one network, on one route.
 *
 * `route` defaults to DIRECT so every existing caller keeps its exact previous
 * behaviour: the direct table is consulted, and Upload-Post is reachable only
 * by asking for it. A caller that resolves a route passes it; one that does not
 * is asking the question it always asked.
 */
export function publisherFor(platform: Platform, route: PublishRoute = 'DIRECT'): PlatformPublisher | null {
  if (route === 'UPLOAD_POST') return UPLOAD_POST_PUBLISHERS.get(platform) ?? null;
  return PUBLISHERS[platform] ?? null;
}

/**
 * The platforms an operator can actually schedule organic content to today.
 *
 * Direct adapters *and* the networks Upload-Post can route to when it is
 * configured: from the operator's side "can I schedule a post to X" has one
 * answer, and which connection carries it is the route resolver's business. A
 * deployment with no Upload-Post key contributes nothing here, because
 * `canPublish` on those publishers answers for the deployment.
 */
export function publishablePlatforms(): Platform[] {
  const direct = Object.values(PUBLISHERS)
    .filter((publisher): publisher is PlatformPublisher => Boolean(publisher?.canPublish))
    .map((publisher) => publisher.platform);

  const routed = [...UPLOAD_POST_PUBLISHERS.values()]
    .filter((publisher) => publisher.canPublish)
    .map((publisher) => publisher.platform);

  return [...new Set([...direct, ...routed])];
}

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

import type { PlatformPublisher, PublishRequest, PublishResult } from './contract.js';
import { facebookPublisher } from './facebook.js';
import { instagramPublisher } from './instagram.js';

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
  [Platform.TIKTOK]: notImplemented(Platform.TIKTOK, 'TikTok'),
  [Platform.LINKEDIN]: notImplemented(Platform.LINKEDIN, 'LinkedIn'),
  [Platform.X]: notImplemented(Platform.X, 'X'),
};

export function publisherFor(platform: Platform): PlatformPublisher | null {
  return PUBLISHERS[platform] ?? null;
}

/** The platforms an operator can actually schedule organic content to today. */
export function publishablePlatforms(): Platform[] {
  return Object.values(PUBLISHERS)
    .filter((publisher): publisher is PlatformPublisher => Boolean(publisher?.canPublish))
    .map((publisher) => publisher.platform);
}

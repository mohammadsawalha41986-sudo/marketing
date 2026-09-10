/**
 * What a post is published to, per platform and per connection.
 *
 * This is one question asked in two places — the content publisher and the
 * test-publish route — and until now each answered it with the same hard-coded
 * guess: a Facebook Page. That guess is right for exactly one platform. It is
 * why an Instagram account connected through Instagram Login, discovered
 * correctly, attached correctly and stored correctly, still could not publish:
 * the lookup asked for a PAGE, found none, and reported "No Page is attached to
 * this connection" to a connection that will never have one.
 *
 * The target is decided by two facts:
 *
 *   the platform      Facebook posts to a Page. Instagram posts to an Instagram
 *                     Professional account. TikTok and YouTube post as the
 *                     creator's own profile. Google Business posts to a
 *                     location. LinkedIn posts as an organization page.
 *
 *   the connection    Instagram is reachable two ways. Through the Meta
 *                     connection its account is discovered under the FACEBOOK
 *                     integration, as an asset of a Page. Through Instagram
 *                     Login it is the login itself, under the INSTAGRAM
 *                     integration. Both store an INSTAGRAM-kind account; they
 *                     differ only in which integration owns it and which Graph
 *                     host issued its token — and the publisher already reads
 *                     the host from the account's own metadata.
 *
 * Nothing here fabricates a Page id from an Instagram id. A direct Instagram
 * connection has no Page, is not given one, and is never asked for one.
 */

import { AccountTokenStatus, ExternalAccountKind, Platform, type PrismaClient } from '@prisma/client';

import { PAGE_PUBLISH_PERMISSION } from '../integrations/meta.js';
import { PUBLISH_SCOPE as INSTAGRAM_PUBLISH_SCOPE, isInstagramLoginAccount } from '../integrations/instagram.js';
import { PUBLISH_SCOPE as TIKTOK_PUBLISH_SCOPE } from '../integrations/tiktok.js';
import { PUBLISH_SCOPE as LINKEDIN_PUBLISH_SCOPE } from '../integrations/linkedin.js';
import { UPLOAD_SCOPE as YOUTUBE_UPLOAD_SCOPE } from '../integrations/youtube.js';

/** The account kind a post on this platform is delivered to. */
const TARGET_KIND: Record<Platform, ExternalAccountKind> = {
  [Platform.FACEBOOK]: ExternalAccountKind.PAGE,
  [Platform.INSTAGRAM]: ExternalAccountKind.INSTAGRAM,
  [Platform.TIKTOK]: ExternalAccountKind.PROFILE,
  [Platform.YOUTUBE]: ExternalAccountKind.PROFILE,
  [Platform.LINKEDIN]: ExternalAccountKind.PAGE,
  [Platform.GOOGLE_BUSINESS]: ExternalAccountKind.LOCATION,
  [Platform.GOOGLE_ADS]: ExternalAccountKind.AD_ACCOUNT,
  [Platform.SNAPCHAT]: ExternalAccountKind.AD_ACCOUNT,
  [Platform.X]: ExternalAccountKind.PROFILE,
};

/**
 * Which integrations can hold a publishing target for this platform.
 *
 * One entry has two, and it is the point of this module: an Instagram post can
 * be delivered by the direct Instagram connection or by the Meta connection
 * that discovered the account through its Page. Order is preference — the
 * connection made *for* Instagram is tried first, because an operator who
 * connected Instagram directly chose that account deliberately.
 */
const SOURCE_PLATFORMS: Partial<Record<Platform, Platform[]>> = {
  [Platform.INSTAGRAM]: [Platform.INSTAGRAM, Platform.FACEBOOK],
};

/** What to call the target when telling an operator one is missing. */
const TARGET_NOUN: Record<Platform, string> = {
  [Platform.FACEBOOK]: 'Facebook Page',
  [Platform.INSTAGRAM]: 'Instagram account',
  [Platform.TIKTOK]: 'TikTok account',
  [Platform.YOUTUBE]: 'YouTube channel',
  [Platform.LINKEDIN]: 'LinkedIn page',
  [Platform.GOOGLE_BUSINESS]: 'business location',
  [Platform.GOOGLE_ADS]: 'Google Ads account',
  [Platform.SNAPCHAT]: 'Snapchat ad account',
  [Platform.X]: 'X account',
};

export function targetKindFor(platform: Platform): ExternalAccountKind {
  return TARGET_KIND[platform];
}

export function targetNounFor(platform: Platform): string {
  return TARGET_NOUN[platform];
}

/** The sentence an operator gets when nothing is attached to publish to. */
export function noTargetMessage(platform: Platform): string {
  return `No ${TARGET_NOUN[platform]} is attached to this connection. Choose one first.`;
}

export interface PublishingTarget {
  id: string;
  externalId: string;
  name: string;
  kind: ExternalAccountKind;
  accessTokenEnc: string | null;
  tokenStatus: string | null;
  /** Provider-shaped facts, never credentials. Says which API issued the token. */
  metadata: Record<string, unknown>;
}

const TARGET_SELECT = {
  id: true,
  externalId: true,
  name: true,
  kind: true,
  accessTokenEnc: true,
  tokenStatus: true,
  metadata: true,
} as const;

const shape = (row: {
  id: string; externalId: string; name: string; kind: ExternalAccountKind;
  accessTokenEnc: string | null; tokenStatus: string | null; metadata: unknown;
}): PublishingTarget => ({
  id: row.id,
  externalId: row.externalId,
  name: row.name,
  kind: row.kind,
  accessTokenEnc: row.accessTokenEnc,
  tokenStatus: row.tokenStatus,
  metadata: (row.metadata ?? {}) as Record<string, unknown>,
});

/**
 * The account a piece of content for this platform publishes to.
 *
 * Scoped by organization *and* client on every branch: a publishing target is
 * tenant data like anything else, and a lookup that reached across clients
 * would put one restaurant's post on another's account.
 */
export async function resolvePublishingTarget(input: {
  prisma: PrismaClient;
  organizationId: string;
  clientId: string;
  platform: Platform;
}): Promise<PublishingTarget | null> {
  const kind = targetKindFor(input.platform);
  const sources = SOURCE_PLATFORMS[input.platform] ?? [input.platform];

  // In preference order, so a direct connection wins over an inherited one.
  for (const source of sources) {
    const row = await input.prisma.integrationAccount.findFirst({
      where: {
        clientId: input.clientId,
        selected: true,
        kind,
        integration: { organizationId: input.organizationId, platform: source },
      },
      select: TARGET_SELECT,
    });
    if (row) return shape(row);
  }
  return null;
}

/**
 * The account one specific connection publishes to.
 *
 * Used where the caller already holds an integration — the test-publish route —
 * and the connection therefore names its own platform. A Meta connection's
 * target is its Page even though the same connection also carries Instagram
 * accounts: a test publish proves the credential works, and the Page post is
 * the one that needs no image.
 */
export async function resolveTargetForIntegration(input: {
  prisma: PrismaClient;
  integrationId: string;
  platform: Platform;
}): Promise<PublishingTarget | null> {
  const row = await input.prisma.integrationAccount.findFirst({
    where: {
      integrationId: input.integrationId,
      selected: true,
      kind: targetKindFor(input.platform),
    },
    select: TARGET_SELECT,
  });
  return row ? shape(row) : null;
}

/**
 * The permission that decides whether this target can be posted to.
 *
 * Instagram has two answers because it is two products: a direct Instagram
 * Login connection needs `instagram_business_content_publish`, and an Instagram
 * account reached through the Facebook connection needs the Facebook app's
 * `instagram_content_publish`. Naming the wrong one sends an operator to
 * request a permission their app does not use.
 *
 * Read from each provider module rather than restated, so the permission named
 * in an error is the one the authorization actually asked for.
 */
export function publishGrantFor(platform: Platform, metadata?: unknown): string | null {
  switch (platform) {
    case Platform.FACEBOOK:
      return PAGE_PUBLISH_PERMISSION;
    case Platform.INSTAGRAM:
      return isInstagramLoginAccount(metadata) ? INSTAGRAM_PUBLISH_SCOPE : 'instagram_content_publish';
    case Platform.TIKTOK:
      return TIKTOK_PUBLISH_SCOPE;
    case Platform.LINKEDIN:
      return LINKEDIN_PUBLISH_SCOPE;
    case Platform.YOUTUBE:
      return YOUTUBE_UPLOAD_SCOPE;
    default:
      return null;
  }
}

/**
 * Whether the connection itself already says this cannot publish.
 *
 * The grant was recorded when the account was attached — providers grant
 * per-permission, so a login can succeed with publishing declined — which means
 * this is knowable before a request is sent. Returning the exact permission
 * here is the difference between "the platform refused the post" and a sentence
 * naming what to go and ask for.
 */
export function missingPublishGrant(
  platform: Platform,
  target: Pick<PublishingTarget, 'tokenStatus' | 'metadata'>,
): string | null {
  if (target.tokenStatus !== AccountTokenStatus.MISSING_PERMISSION) return null;
  const grant = publishGrantFor(platform, target.metadata);
  return grant
    ? `This connection was authorised without ${grant}, so it cannot publish. `
      + 'Reconnect it and grant that permission.'
    : 'This connection was authorised without the permission publishing needs. Reconnect it.';
}

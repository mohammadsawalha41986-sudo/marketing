/**
 * Which connection a post goes out through, when a restaurant has more than one.
 *
 * Until Upload-Post there was exactly one answer per platform: the direct
 * integration, or nothing. Upload-Post makes the same network reachable a
 * second way, and that is the entire risk this module exists to remove — a
 * restaurant with both a direct Instagram connection and an Upload-Post profile
 * carrying Instagram has two working paths to the same account, and a system
 * that takes both publishes the post twice.
 *
 * So the route is *resolved*, once, per (client, platform), and both publishing
 * paths ask this one question:
 *
 *   DIRECT        a direct connection for this platform has an attached
 *                 account. Always preferred, unconditionally.
 *   UPLOAD_POST   no direct account is attached, and the restaurant's
 *                 Upload-Post profile has this network linked and attached.
 *   null          neither. Nothing publishes.
 *
 * Direct wins for a reason beyond precedence: a direct connection is a
 * credential this application holds for that exact account, with the grant
 * recorded against it, and its failures name the network itself. Routing
 * through a third party when we hold the credential adds a hop, a vendor, and
 * an error vocabulary, and buys nothing.
 *
 * The preference is not configurable, and that is deliberate. A switch would
 * mean the answer depends on when it was last flipped — and the one moment it
 * matters is a retry, where a route that changed between attempts is exactly
 * how the same post goes out on both paths.
 */

import { Platform, type PrismaClient } from '@prisma/client';

import { uploadPostPlatform } from '../integrations/upload-post.js';
import { resolvePublishingTarget, type PublishingTarget } from './target.js';

export type PublishRoute = 'DIRECT' | 'UPLOAD_POST';

export interface ResolvedRoute {
  route: PublishRoute;
  target: PublishingTarget;
}

/**
 * Whether this route's credential belongs to the account or to the deployment.
 *
 * A direct account publishes with its own stored token, so no token means no
 * publish. An Upload-Post account has none by design — the deployment's API key
 * authorises the call and the account is addressed by name under a profile — so
 * demanding one would refuse every Upload-Post post as needing reauthorisation,
 * which is both false and unfixable.
 */
export function routeNeedsAccountCredential(route: PublishRoute): boolean {
  return route === 'DIRECT';
}

/** The route an integration's accounts publish through. */
export function routeForIntegrationPlatform(platform: Platform): PublishRoute {
  return platform === Platform.UPLOAD_POST ? 'UPLOAD_POST' : 'DIRECT';
}

/**
 * The one account this restaurant's post for this platform publishes to.
 *
 * Scoped by organisation *and* client on both branches, like every other
 * publishing lookup: a route is tenant data, and one that reached across
 * clients would put one restaurant's post on another's account.
 */
export async function resolveRoute(input: {
  prisma: PrismaClient;
  organizationId: string;
  clientId: string;
  platform: Platform;
}): Promise<ResolvedRoute | null> {
  // Direct first, always — see the header. `resolvePublishingTarget` already
  // knows each platform's own preference order among direct connections.
  const direct = await resolvePublishingTarget(input);
  if (direct) return { route: 'DIRECT', target: direct };

  const uploadPost = await resolveUploadPostTarget(input);
  return uploadPost ? { route: 'UPLOAD_POST', target: uploadPost } : null;
}

/**
 * The attached Upload-Post account for one network, if there is one.
 *
 * Matched on the network recorded in the account's own metadata, never on
 * `kind`. Three of the networks Upload-Post reaches — TikTok, YouTube and X —
 * all map to a PROFILE-kind account, so they sit under one integration as three
 * indistinguishable rows by kind alone, and a lookup by kind would return
 * whichever the database happened to order first. That is a post published to
 * the wrong network, which is worse than not publishing at all.
 */
export async function resolveUploadPostTarget(input: {
  prisma: PrismaClient;
  organizationId: string;
  clientId: string;
  platform: Platform;
}): Promise<PublishingTarget | null> {
  const slug = uploadPostPlatform(input.platform);
  // A network Upload-Post does not reach, or that this product does not model
  // as an organic surface. There is no route, rather than a guessed one.
  if (!slug) return null;

  const row = await input.prisma.integrationAccount.findFirst({
    where: {
      clientId: input.clientId,
      selected: true,
      integration: { organizationId: input.organizationId, platform: Platform.UPLOAD_POST },
      metadata: { path: ['uploadPostPlatform'], equals: slug },
    },
    select: {
      id: true,
      externalId: true,
      name: true,
      kind: true,
      accessTokenEnc: true,
      tokenStatus: true,
      metadata: true,
    },
  });
  if (!row) return null;

  return {
    id: row.id,
    externalId: row.externalId,
    name: row.name,
    kind: row.kind,
    accessTokenEnc: row.accessTokenEnc,
    tokenStatus: row.tokenStatus,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  };
}

/**
 * Every platform this restaurant could publish to, and how.
 *
 * Used by the Integrations screen to show an operator which networks are
 * covered and by which connection — the question "will this post actually go
 * out, and through what" has until now been answerable only by publishing.
 */
export async function routeCoverage(input: {
  prisma: PrismaClient;
  organizationId: string;
  clientId: string;
  platforms: Platform[];
}): Promise<Array<{ platform: Platform; route: PublishRoute | null; accountName: string | null }>> {
  const rows: Array<{ platform: Platform; route: PublishRoute | null; accountName: string | null }> = [];

  for (const platform of input.platforms) {
    const resolved = await resolveRoute({ ...input, platform });
    rows.push({
      platform,
      route: resolved?.route ?? null,
      accountName: resolved?.target.name ?? null,
    });
  }

  return rows;
}

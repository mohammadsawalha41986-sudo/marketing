/**
 * "What is happening right now" — the counters the dashboard and each platform
 * workspace open on, and the connection health beside them.
 *
 * Two things this deliberately does not do.
 *
 * **It does not invent a day.** "Scheduled today" depends on whose today, and
 * the server's UTC midnight is nobody's. The window is supplied by the caller,
 * which is the only party that knows the operator's clock, and every count is
 * computed against that window rather than against a boundary guessed here.
 *
 * **It does not roll unlike things into one number.** "Needs attention" is
 * three different problems — a post the platform refused, an advertisement that
 * failed, an authorisation that has run out — and an operator seeing `7` needs
 * to know which. The count is returned with its parts, so the card can say what
 * it is made of instead of sending someone hunting.
 *
 * Counts only. Nothing here reads a metric, so nothing here can misreport one:
 * the four-state metric semantics live in Phase 14 and are not touched.
 */

import {
  IntegrationStatus, Platform, PlatformPostStatus, PublicationStatus,
  type PrismaClient,
} from '@prisma/client';

import { orgId, scopeWhere, type Actor } from '../../lib/scope.js';

/** Waiting to go out: approved or scheduled, and dated inside the window. */
const PENDING: PlatformPostStatus[] = [
  PlatformPostStatus.APPROVED,
  PlatformPostStatus.SCHEDULED,
];

/** In flight right now. Not window-bounded — "in flight" is a present tense. */
const IN_FLIGHT: PlatformPostStatus[] = [
  PlatformPostStatus.QUEUED,
  PlatformPostStatus.PUBLISHING,
];

/** An authorisation that cannot currently be used to publish anything. */
const UNUSABLE: IntegrationStatus[] = [
  IntegrationStatus.TOKEN_EXPIRED,
  IntegrationStatus.REAUTH_REQUIRED,
  IntegrationStatus.EXPIRED,
  IntegrationStatus.ERROR,
];

export interface PulseCounts {
  scheduled: number;
  publishing: number;
  published: number;
  needsAttention: number;
  /** What `needsAttention` is made of. Never collapsed into the total alone. */
  attention: {
    failedPosts: number;
    failedAds: number;
    brokenConnections: number;
  };
}

export interface ConnectionHealth {
  /**
   * Which project this connection belongs to.
   *
   * An `Integration` is per project, not per deployment: four projects each
   * connect their own Facebook Page. Without this the roll-up view rendered
   * four identical "Facebook — Not connected" cards with nothing to tell them
   * apart, which is a list that cannot be acted on.
   */
  clientId: string;
  clientName: string;
  platform: Platform;
  /**
   * The integration's own state, or DISCONNECTED where no row exists. The
   * capability matrix separately says whether this deployment could connect at
   * all; the two are different questions and the UI shows both.
   */
  status: IntegrationStatus;
  accountName: string | null;
  accountId: string | null;
  lastSyncAt: Date | null;
  /** Provider text, shown verbatim. Never replaced with a generic apology. */
  lastError: string | null;
  accounts: Array<{
    id: string;
    name: string;
    username: string | null;
    kind: string;
    selected: boolean;
  }>;
}

export interface PulseInput {
  prisma: PrismaClient;
  actor: Actor;
  clientId?: string;
  /** Restrict to one workspace's platforms. Omitted means every platform. */
  platforms?: Platform[];
  /** The operator's own day, as an absolute window. Required — see above. */
  from: Date;
  to: Date;
}

export async function pulse(input: PulseInput): Promise<{
  counts: PulseCounts;
  connections: ConnectionHealth[];
}> {
  const organizationId = orgId(input.actor);
  const platformFilter = input.platforms && input.platforms.length > 0
    ? { platform: { in: input.platforms } }
    : {};

  /*
   * Posts are scoped through their group, which is the row that carries the
   * organisation and the client. `scopeWhere` pins both, so a client user
   * counting their own pipeline cannot count anybody else's.
   */
  const groupScope = {
    postGroup: {
      ...scopeWhere(input.actor),
      ...(input.clientId ? { clientId: input.clientId } : {}),
    },
  };

  const adScope = {
    ...scopeWhere(input.actor),
    ...(input.clientId ? { clientId: input.clientId } : {}),
  };

  const [
    scheduled, publishing, published, failedPosts, failedAds, integrations,
  ] = await Promise.all([
    input.prisma.platformPost.count({
      where: {
        ...groupScope,
        ...platformFilter,
        status: { in: PENDING },
        scheduledAt: { gte: input.from, lte: input.to },
      },
    }),
    input.prisma.platformPost.count({
      where: { ...groupScope, ...platformFilter, status: { in: IN_FLIGHT } },
    }),
    input.prisma.platformPost.count({
      where: {
        ...groupScope,
        ...platformFilter,
        status: PlatformPostStatus.PUBLISHED,
        publishedAt: { gte: input.from, lte: input.to },
      },
    }),
    /*
     * A failure stays on the list until somebody deals with it, so this one is
     * not window-bounded: yesterday's failed post is still today's problem, and
     * dropping it at midnight is how it gets forgotten.
     */
    input.prisma.platformPost.count({
      where: { ...groupScope, ...platformFilter, status: PlatformPostStatus.FAILED },
    }),
    input.prisma.adPublication.count({
      where: {
        ...adScope,
        ...platformFilter,
        status: { in: [PublicationStatus.FAILED, PublicationStatus.REQUIRES_REAUTH] },
      },
    }),
    input.prisma.integration.findMany({
      where: { organizationId, ...(input.clientId ? { clientId: input.clientId } : {}), ...platformFilter },
      // Grouped by project, then platform, which is how the cards are read
      // when the roll-up view spans several projects.
      orderBy: [{ clientId: 'asc' }, { platform: 'asc' }],
      // `credentials` and every *Enc column are absent by construction: this
      // projection is an allowlist, so a token cannot leak by being added to
      // the model later.
      select: {
        clientId: true, platform: true, status: true, accountName: true, accountId: true,
        lastSyncAt: true, lastError: true,
        client: { select: { businessName: true } },
        accounts: {
          orderBy: { name: 'asc' },
          select: {
            id: true, name: true, username: true, kind: true, selected: true,
          },
        },
      },
    }),
  ]);

  const brokenConnections = integrations.filter(
    (row) => UNUSABLE.includes(row.status),
  ).length;

  return {
    counts: {
      scheduled,
      publishing,
      published,
      needsAttention: failedPosts + failedAds + brokenConnections,
      attention: { failedPosts, failedAds, brokenConnections },
    },
    connections: integrations.map((row) => ({
      clientId: row.clientId,
      clientName: row.client.businessName,
      platform: row.platform,
      status: row.status,
      accountName: row.accountName,
      accountId: row.accountId,
      lastSyncAt: row.lastSyncAt,
      lastError: row.lastError,
      accounts: row.accounts,
    })),
  };
}

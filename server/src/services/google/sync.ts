/**
 * Pulling Business Profile data in, and keeping the credential alive.
 *
 * Google access tokens last an hour, so every call here starts by making sure
 * the one it is about to use is valid — refreshing from the stored refresh
 * token and writing the new one back encrypted. That is why sync goes through a
 * service rather than being inlined in a route: a refresh that is not persisted
 * works once and then the next request pays for it again, and a refresh that is
 * persisted in three places will eventually be persisted wrongly in one.
 *
 * Analysis runs as part of the sync rather than on read. Sentiment and category
 * are cheap and deterministic, and computing them once at write time means the
 * review list can filter and count by them in the database instead of loading
 * every row to sort it in memory.
 */

import {
  IntegrationStatus, NotificationType, Platform, Prisma, type PrismaClient,
} from '@prisma/client';

import { decryptSecret, encryptSecret } from '../../lib/crypto.js';
import { googleConfig, refreshAccessToken, listLocations } from '../integrations/google.js';
import type { FetchLike } from '../integrations/meta.js';
import { listReviews, persistReviews } from './reviews.js';
import { analyzeReview, clusterComplaints, REPEAT_THRESHOLD } from './analyze.js';
import { notify } from '../notify.js';

export class GoogleNotConnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleNotConnectedError';
  }
}

/**
 * A usable access token for this client's Google connection.
 *
 * Refreshes when the stored one is within a minute of expiry — a token that
 * expires mid-call fails the call, and the clock skew between us and Google is
 * not worth cutting fine.
 */
export async function accessTokenFor(input: {
  prisma: PrismaClient;
  organizationId: string;
  clientId: string;
  fetchImpl: FetchLike;
  now?: Date;
}): Promise<{ accessToken: string; integrationId: string }> {
  const now = input.now ?? new Date();

  const integration = await input.prisma.integration.findFirst({
    where: {
      organizationId: input.organizationId,
      clientId: input.clientId,
      platform: Platform.GOOGLE_BUSINESS,
    },
    select: {
      id: true, status: true, accessTokenEnc: true, refreshTokenEnc: true, tokenExpiresAt: true,
    },
  });

  if (!integration || !integration.accessTokenEnc) {
    throw new GoogleNotConnectedError(
      'This restaurant is not connected to Google Business Profile. Connect it under Integrations first.',
    );
  }

  const expiresAt = integration.tokenExpiresAt;
  const stale = !expiresAt || expiresAt.getTime() - now.getTime() < 60_000;

  if (!stale) {
    return { accessToken: decryptSecret(integration.accessTokenEnc), integrationId: integration.id };
  }

  if (!integration.refreshTokenEnc) {
    throw new GoogleNotConnectedError(
      'The Google connection has expired and has no refresh token. Reconnect it under Integrations.',
    );
  }

  const refreshed = await refreshAccessToken({
    config: googleConfig(),
    refreshToken: decryptSecret(integration.refreshTokenEnc),
    fetchImpl: input.fetchImpl,
    now,
  });

  await input.prisma.integration.update({
    where: { id: integration.id },
    data: {
      accessTokenEnc: encryptSecret(refreshed.accessToken),
      tokenExpiresAt: refreshed.expiresAt,
      status: IntegrationStatus.CONNECTED,
      lastError: null,
    },
  });

  return { accessToken: refreshed.accessToken, integrationId: integration.id };
}

/**
 * Sync the branches under every Business Profile account the operator attached.
 *
 * Upsert on (integration, externalName): re-running after a branch is renamed
 * updates it rather than leaving the old row beside the new one, which is how a
 * location list slowly fills with ghosts.
 */
export async function syncLocations(input: {
  prisma: PrismaClient;
  organizationId: string;
  clientId: string;
  fetchImpl: FetchLike;
}): Promise<{ synced: number }> {
  const { accessToken, integrationId } = await accessTokenFor(input);

  const accounts = await input.prisma.integrationAccount.findMany({
    where: { integrationId, selected: true },
    select: { externalId: true },
  });

  if (accounts.length === 0) {
    throw new GoogleNotConnectedError(
      'No Google Business account is selected for this restaurant. Choose one under Integrations.',
    );
  }

  let synced = 0;

  for (const account of accounts) {
    const locations = await listLocations({
      accessToken,
      accountName: account.externalId,
      fetchImpl: input.fetchImpl,
    });

    for (const location of locations) {
      const fields = {
        accountName: account.externalId,
        title: location.title,
        storeCode: location.storeCode ?? null,
        addressLines: location.addressLines,
        locality: location.locality ?? null,
        region: location.region ?? null,
        postalCode: location.postalCode ?? null,
        country: location.country ?? null,
        phone: location.phone ?? null,
        websiteUri: location.websiteUri ?? null,
        mapsUri: location.mapsUri ?? null,
        primaryCategory: location.primaryCategory ?? null,
        metadata: location.raw as Prisma.InputJsonValue,
        syncedAt: new Date(),
      };

      await input.prisma.googleLocation.upsert({
        where: { integrationId_externalName: { integrationId, externalName: location.name } },
        create: {
          organizationId: input.organizationId,
          clientId: input.clientId,
          integrationId,
          externalName: location.name,
          ...fields,
        },
        update: fields,
      });
      synced += 1;
    }
  }

  return { synced };
}

export interface ReviewSyncResult {
  created: number;
  updated: number;
  analyzed: number;
  /** Complaint clusters that crossed the repeat threshold during this sync. */
  repeated: Array<{ key: string; count: number }>;
}

/**
 * Sync reviews for one location, analyse what arrived, and raise the alerts
 * that are worth an operator's attention.
 *
 * Two alerts, and both are about things a person must act on rather than
 * merely know: a new one-or-two-star review, and a complaint that has now
 * recurred enough times to be a pattern. Notifying on every five-star review
 * would train everyone to ignore the channel.
 */
export async function syncReviews(input: {
  prisma: PrismaClient;
  organizationId: string;
  clientId: string;
  locationId: string;
  fetchImpl: FetchLike;
  /** Suppressed during tests and backfills so a first sync is not a siren. */
  alert?: boolean;
}): Promise<ReviewSyncResult> {
  const location = await input.prisma.googleLocation.findFirst({
    where: { id: input.locationId, organizationId: input.organizationId },
    select: { id: true, clientId: true, title: true, externalName: true, accountName: true },
  });
  if (!location) throw new GoogleNotConnectedError('Location not found.');
  if (!location.accountName) {
    throw new GoogleNotConnectedError(
      'This location has no Google account reference. Re-sync locations before reading reviews.',
    );
  }

  const { accessToken } = await accessTokenFor({
    prisma: input.prisma,
    organizationId: input.organizationId,
    clientId: location.clientId,
    fetchImpl: input.fetchImpl,
  });

  const fetched = await listReviews({
    accessToken,
    accountName: location.accountName,
    locationName: location.externalName,
    fetchImpl: input.fetchImpl,
  });

  // Which ones are new, decided before the write so the alert is about arrivals
  // rather than about everything the location has ever received.
  const known = await input.prisma.googleReview.findMany({
    where: { locationId: location.id },
    select: { externalId: true },
  });
  const knownIds = new Set(known.map((row) => row.externalId));
  const arrivals = fetched.filter((review) => !knownIds.has(review.externalId));

  const { created, updated } = await persistReviews({
    prisma: input.prisma,
    organizationId: input.organizationId,
    clientId: location.clientId,
    locationId: location.id,
    reviews: fetched,
  });

  // Analyse anything not yet analysed, including rows whose text Google changed.
  const pending = await input.prisma.googleReview.findMany({
    where: { locationId: location.id, analyzedAt: null },
    select: { id: true, rating: true, comment: true },
  });

  for (const review of pending) {
    const analysis = analyzeReview({ rating: review.rating, comment: review.comment });
    await input.prisma.googleReview.update({
      where: { id: review.id },
      data: { ...analysis, analyzedAt: new Date() },
    });
  }

  const all = await input.prisma.googleReview.findMany({
    where: { locationId: location.id },
    select: { id: true, complaintKey: true, category: true, createTime: true },
  });
  const clusters = clusterComplaints(all);

  if (input.alert !== false) {
    const negatives = arrivals.filter((review) => review.rating <= 2);
    if (negatives.length > 0) {
      await notify({
        organizationId: input.organizationId,
        clientId: location.clientId,
        type: NotificationType.AI_ALERT,
        title: `${negatives.length} new negative review${negatives.length === 1 ? '' : 's'} — ${location.title}`,
        body: negatives
          .map((review) => `${review.rating}★ ${review.comment?.slice(0, 120) ?? 'No text'}`)
          .join('\n'),
        link: '/app/google/reviews',
      });
    }

    for (const cluster of clusters) {
      // Only when this sync is what pushed it over the line, so the same
      // pattern does not re-alert on every subsequent sync.
      const before = cluster.count - arrivals.filter((review) => {
        const analysis = analyzeReview({ rating: review.rating, comment: review.comment });
        return analysis.complaintKey === cluster.key;
      }).length;

      if (before < REPEAT_THRESHOLD && cluster.count >= REPEAT_THRESHOLD) {
        await notify({
          organizationId: input.organizationId,
          clientId: location.clientId,
          type: NotificationType.AI_ALERT,
          title: `Repeated complaint at ${location.title}: ${cluster.key.toLowerCase()}`,
          body: `${cluster.count} reviews now mention this. It is a pattern rather than a one-off.`,
          link: '/app/google/reviews',
        });
      }
    }
  }

  return {
    created,
    updated,
    analyzed: pending.length,
    repeated: clusters.map((cluster) => ({ key: cluster.key, count: cluster.count })),
  };
}

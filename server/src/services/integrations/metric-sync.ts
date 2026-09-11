/**
 * Bringing Meta's numbers into the database.
 *
 * Until this existed, `AnalyticsSnapshot` had exactly one writer — the seed
 * script — so every figure on every dashboard was demo data with nothing
 * saying so. `fetchInsights` and `normalizeInsights` were written and tested
 * and had no callers. This is the missing half.
 *
 * Three decisions worth stating:
 *
 * **We only ingest what we published.** The link from a Meta campaign back to a
 * local one is `AdPublication.providerCampaignId`, written by the publish flow.
 * An ad account may hold campaigns created in Ads Manager years ago; attributing
 * their spend to a local campaign we cannot identify would corrupt every ratio
 * that reads from these rows. Those are reported as skipped, with the reason.
 *
 * **The window overlaps.** Meta revises recent days as attribution settles, so
 * re-fetching only "today" bakes in whatever was true at the moment of the
 * first read. Each sync re-reads several days back from the last successful one
 * and upserts, which is why every write here is idempotent.
 *
 * **Zero is a measurement; absent is not.** A campaign that reported no
 * conversion actions at all is recorded as such on the run, so downstream code
 * can tell "no conversions happened" from "conversions were never tracked" —
 * the distinction the whole finance engine is built around.
 */

import { IntegrationStatus, PerformanceGrain, Platform, Prisma, type PrismaClient } from '@prisma/client';

import { decryptSecret } from '../../lib/crypto.js';
import { fetchInsights, type FetchLike } from './meta.js';
import { runSync } from './connect-flow.js';

/** Days re-read on every sync to absorb Meta's late attribution revisions. */
const OVERLAP_DAYS = 3;
/** How far back the first sync of a connection reaches. */
const BACKFILL_DAYS = 30;

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

export interface MetricSyncResult {
  integrationId: string;
  runId: string;
  status: string;
  from: string;
  to: string;
  campaignsRead: number;
  daysWritten: number;
  created: number;
  updated: number;
  /** Publications that could not be attributed, and why. */
  skipped: Array<{ publicationId: string; reason: string }>;
  /** False when no campaign in this window reported any conversion action. */
  conversionTracking: boolean;
  errorMessage: string | null;
}

/**
 * Pull daily insights for every published advertisement on this connection.
 *
 * Returns a result rather than throwing on a provider failure: a sync that
 * fails is a fact the operator needs to read, alongside whatever did succeed.
 */
export async function syncMetaMetrics(input: {
  prisma: PrismaClient;
  integrationId: string;
  organizationId: string;
  fetchImpl: FetchLike;
  now?: Date;
}): Promise<MetricSyncResult | null> {
  const { prisma } = input;
  const now = input.now ?? new Date();

  const integration = await prisma.integration.findFirst({
    where: { id: input.integrationId, organizationId: input.organizationId },
    include: { accounts: { where: { selected: true } } },
  });
  if (!integration) return null;

  if (integration.status !== IntegrationStatus.CONNECTED) {
    throw new Error(`This connection is ${integration.status.toLowerCase()}, so there is nothing to sync.`);
  }
  if (!integration.accessTokenEnc) {
    throw new Error('This connection holds no usable credential. Reconnect it.');
  }

  /*
   * The window. A connection that has never synced backfills a month; one that
   * has re-reads from a few days before its last success, because Meta keeps
   * revising those days.
   */
  const from = integration.lastSyncAt
    ? new Date(integration.lastSyncAt.getTime() - OVERLAP_DAYS * 86_400_000)
    : new Date(now.getTime() - BACKFILL_DAYS * 86_400_000);
  const since = isoDay(from);
  const until = isoDay(now);

  const accessToken = decryptSecret(integration.accessTokenEnc);

  // Only advertisements we actually published carry a provider campaign id.
  const publications = await prisma.adPublication.findMany({
    where: {
      organizationId: input.organizationId,
      clientId: integration.clientId,
      providerCampaignId: { not: null },
    },
    select: {
      id: true, campaignId: true, providerCampaignId: true, providerAdId: true, platform: true,
      creativeId: true, videoCreativeId: true, currency: true,
    },
  });

  const skipped: Array<{ publicationId: string; reason: string }> = [];
  let campaignsRead = 0;
  let daysWritten = 0;
  let created = 0;
  let updated = 0;
  let conversionTracking = false;

  const outcome = await runSync(
    {
      integrationId: integration.id,
      organizationId: input.organizationId,
      clientId: integration.clientId,
      platform: integration.platform,
    },
    async () => {
      for (const publication of publications) {
        /*
         * Without a local campaign there is nowhere to put the numbers:
         * AnalyticsSnapshot is unique on (campaignId, platform, date), and a
         * null campaignId would let the same day be written repeatedly since
         * Postgres treats NULLs as distinct. Reported rather than dropped.
         */
        if (!publication.campaignId) {
          skipped.push({
            publicationId: publication.id,
            reason: 'This advertisement is not linked to a local campaign, so its metrics have nowhere to attach.',
          });
          continue;
        }

        const result = await fetchInsights({
          campaignId: publication.providerCampaignId as string,
          accessToken,
          since,
          until,
          fetchImpl: input.fetchImpl,
        });
        campaignsRead += 1;
        if (result.hasConversionTracking) conversionTracking = true;

        for (const insight of result.insights) {
          if (!insight.date) continue;
          const date = new Date(`${insight.date}T00:00:00.000Z`);

          const existing = await prisma.analyticsSnapshot.findFirst({
            where: { campaignId: publication.campaignId, platform: publication.platform, date },
            select: { id: true },
          });

          // Provider figures overwrite ours: Meta is the authority on its own
          // spend, and a revised day must replace the earlier read rather than
          // being added to it.
          const data = {
            spend: new Prisma.Decimal(insight.spend),
            impressions: insight.impressions,
            reach: insight.reach,
            clicks: insight.clicks,
            conversions: insight.conversions,
            revenue: new Prisma.Decimal(insight.conversionValue),
          };

          /*
           * The same day, written twice, at two grains.
           *
           * AnalyticsSnapshot answers "how is this campaign doing" and every
           * existing rollup reads it. CreativePerformance answers "which ad is
           * working", which its unique key cannot express. Both are upserts, so
           * neither accumulates on a re-sync.
           *
           * The provider campaign id is the natural key here because the
           * insights we fetch are campaign-grained; when ad-level insights are
           * added, the ad id takes over and the grain column says which is which.
           */
          if (publication.creativeId || publication.videoCreativeId) {
            const key = `${publication.providerCampaignId}:${publication.id}`;
            const existingPerformance = await prisma.creativePerformance.findFirst({
              where: { publicationId: publication.id, date, grain: PerformanceGrain.CAMPAIGN },
              select: { id: true },
            });

            const performanceData = {
              spend: new Prisma.Decimal(insight.spend),
              impressions: insight.impressions,
              reach: insight.reach,
              clicks: insight.clicks,
              conversions: insight.conversions,
              revenue: new Prisma.Decimal(insight.conversionValue),
            };

            if (existingPerformance) {
              await prisma.creativePerformance.update({ where: { id: existingPerformance.id }, data: performanceData });
            } else {
              await prisma.creativePerformance.create({
                data: {
                  organizationId: input.organizationId,
                  clientId: integration.clientId,
                  platform: publication.platform,
                  date,
                  creativeId: publication.creativeId,
                  videoCreativeId: publication.videoCreativeId,
                  campaignId: publication.campaignId,
                  publicationId: publication.id,
                  providerCampaignId: publication.providerCampaignId,
                  providerAdId: publication.providerAdId ?? key,
                  grain: PerformanceGrain.CAMPAIGN,
                  currency: publication.currency,
                  ...performanceData,
                },
              });
            }
          }

          if (existing) {
            await prisma.analyticsSnapshot.update({ where: { id: existing.id }, data });
            updated += 1;
          } else {
            await prisma.analyticsSnapshot.create({
              data: {
                organizationId: input.organizationId,
                clientId: integration.clientId,
                campaignId: publication.campaignId,
                platform: publication.platform,
                date,
                engagements: 0,
                ...data,
              },
            });
            created += 1;
          }
          daysWritten += 1;
        }
      }

      return { processed: campaignsRead, created, updated };
    },
  );

  return {
    integrationId: integration.id,
    runId: outcome.runId,
    status: outcome.status,
    from: since,
    to: until,
    campaignsRead,
    daysWritten,
    created,
    updated,
    skipped,
    conversionTracking,
    errorMessage: outcome.errorMessage,
  };
}

/** Platforms whose metrics can actually be ingested today. */
export const METRIC_SYNC_PLATFORMS: Platform[] = [
  Platform.FACEBOOK,
  Platform.INSTAGRAM,
  // Google Ads has its own ingestion — `google-ads-metrics.ts` — because the
  // two providers agree on almost nothing below the level of "read days, write
  // snapshots". The route dispatches on the platform.
  Platform.GOOGLE_ADS,
];

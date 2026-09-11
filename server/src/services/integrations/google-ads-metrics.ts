/**
 * Bringing Google Ads numbers into the database.
 *
 * The counterpart of `metric-sync.ts`, which does this for Meta. It is a
 * separate file rather than a branch inside that one because the two providers
 * disagree about almost everything that matters here: Google reports money in
 * micros, segments by day inside a single GAQL response, and addresses
 * campaigns under a customer id rather than an ad-account id. Threading those
 * differences through Meta's loop would put four conditionals in the middle of
 * a working ingestion path.
 *
 * What is deliberately identical is the part that must not drift:
 *
 * **Only what we published is ingested.** The link from a Google campaign back
 * to a local one is `AdPublication.providerCampaignId`, written by the publish
 * flow. A customer account may hold campaigns created in Google Ads Manager
 * years before NORIVA existed; attributing their spend to a local campaign we
 * cannot identify would corrupt every ratio that reads these rows. Those are
 * reported as skipped, with the reason.
 *
 * **The window overlaps.** Google revises recent days as conversions settle, so
 * each sync re-reads several days back from the last success and overwrites.
 * Every write here is idempotent.
 *
 * **Zero is a measurement; absent is not.** A day Google reported as zero spend
 * is written as zero. A day never fetched has no row at all, and `metrics.ts`
 * reads the absence of rows as NOT_FETCHED rather than as a measured nought.
 */

import { IntegrationStatus, Platform, Prisma, type PrismaClient } from '@prisma/client';

import { decryptSecret, encryptSecret } from '../../lib/crypto.js';
import type { FetchLike } from './meta.js';
import { runSync } from './connect-flow.js';
import { refreshAccessToken } from './google.js';
import {
  GoogleAdsError, fetchCampaignReport, googleAdsConfig, type GoogleAdsCampaignRow,
} from './google-ads.js';

/** Days re-read on every sync, to absorb Google's late conversion attribution. */
const OVERLAP_DAYS = 3;
/** How far back the first sync of a connection reaches. */
const BACKFILL_DAYS = 30;
/** Refresh this far ahead of expiry rather than racing it. */
const REFRESH_MARGIN_MS = 60_000;

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

export interface GoogleAdsSyncResult {
  integrationId: string;
  runId: string;
  status: string;
  customerId: string;
  from: string;
  to: string;
  campaignsRead: number;
  daysWritten: number;
  created: number;
  updated: number;
  skipped: Array<{ publicationId: string; reason: string }>;
  errorMessage: string | null;
}

/**
 * A usable access token for this connection, refreshed and persisted.
 *
 * Google access tokens last an hour, so a publish or a sync more than an hour
 * after connecting fails on an expired credential unless this happens first.
 * The refreshed token is written back encrypted for the same reason Business
 * Profile's sync writes its own back: a refresh that is not persisted works
 * once and is paid for again on the next request.
 */
export async function usableAccessToken(input: {
  prisma: PrismaClient;
  integrationId: string;
  organizationId: string;
  fetchImpl: FetchLike;
  now?: Date;
}): Promise<string> {
  const now = input.now ?? new Date();

  const integration = await input.prisma.integration.findFirst({
    where: { id: input.integrationId, organizationId: input.organizationId, platform: Platform.GOOGLE_ADS },
    select: { id: true, accessTokenEnc: true, refreshTokenEnc: true, tokenExpiresAt: true },
  });
  if (!integration?.accessTokenEnc) {
    throw new GoogleAdsError(401, 'Google Ads: this connection holds no usable credential. Reconnect it.');
  }

  const stale = integration.tokenExpiresAt
    ? integration.tokenExpiresAt.getTime() - REFRESH_MARGIN_MS <= now.getTime()
    : false;

  if (!stale) return decryptSecret(integration.accessTokenEnc);

  if (!integration.refreshTokenEnc) {
    throw new GoogleAdsError(
      401,
      'Google Ads: the authorisation has expired and no refresh token was stored. Reconnect Google Ads for this client.',
    );
  }

  const config = googleAdsConfig();
  const refreshed = await refreshAccessToken({
    config,
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

  return refreshed.accessToken;
}

/** The customer id attached to this connection, and the manager to act through. */
function selectedCustomer(accounts: Array<{ externalId: string; metadata: Prisma.JsonValue }>): {
  customerId: string;
  loginCustomerId: string | null;
} | null {
  const account = accounts[0];
  if (!account) return null;

  const metadata = (account.metadata ?? {}) as Record<string, unknown>;
  const manager = metadata.managerCustomerId;

  return {
    customerId: account.externalId,
    loginCustomerId: typeof manager === 'string' && manager.length > 0 ? manager : null,
  };
}

/**
 * Pull daily campaign performance for every advertisement published on this
 * connection.
 *
 * Returns a result rather than throwing on a provider failure: a sync that
 * fails is itself a fact the operator needs to read, alongside whatever did
 * succeed before it failed.
 */
export async function syncGoogleAdsMetrics(input: {
  prisma: PrismaClient;
  integrationId: string;
  organizationId: string;
  fetchImpl: FetchLike;
  now?: Date;
}): Promise<GoogleAdsSyncResult | null> {
  const { prisma } = input;
  const now = input.now ?? new Date();

  const integration = await prisma.integration.findFirst({
    where: { id: input.integrationId, organizationId: input.organizationId, platform: Platform.GOOGLE_ADS },
    include: { accounts: { where: { selected: true } } },
  });
  if (!integration) return null;

  if (integration.status !== IntegrationStatus.CONNECTED) {
    throw new Error(`This connection is ${integration.status.toLowerCase()}, so there is nothing to sync.`);
  }

  const target = selectedCustomer(integration.accounts);
  if (!target) {
    throw new Error('No Google Ads account is selected for this client. Choose one under Accounts.');
  }

  const config = googleAdsConfig();
  const accessToken = await usableAccessToken({
    prisma,
    integrationId: integration.id,
    organizationId: input.organizationId,
    fetchImpl: input.fetchImpl,
    now,
  });

  const from = integration.lastSyncAt
    ? new Date(integration.lastSyncAt.getTime() - OVERLAP_DAYS * 86_400_000)
    : new Date(now.getTime() - BACKFILL_DAYS * 86_400_000);
  const since = isoDay(from);
  const until = isoDay(now);

  // Only advertisements this application published carry a provider campaign id.
  const publications = await prisma.adPublication.findMany({
    where: {
      organizationId: input.organizationId,
      clientId: integration.clientId,
      platform: Platform.GOOGLE_ADS,
      providerCampaignId: { not: null },
    },
    select: { id: true, campaignId: true, providerCampaignId: true },
  });

  const skipped: Array<{ publicationId: string; reason: string }> = [];
  /** Provider campaign id → the local campaign its numbers belong to. */
  const attribution = new Map<string, string>();

  for (const publication of publications) {
    /*
     * Without a local campaign there is nowhere to put the numbers:
     * AnalyticsSnapshot is unique on (campaignId, platform, date) and Postgres
     * treats NULLs as distinct, so a null campaignId would let the same day be
     * written over and over. Reported rather than dropped silently.
     */
    if (!publication.campaignId) {
      skipped.push({
        publicationId: publication.id,
        reason: 'This advertisement is not linked to a local campaign, so its metrics have nowhere to attach.',
      });
      continue;
    }
    attribution.set(publication.providerCampaignId as string, publication.campaignId);
  }

  let campaignsRead = 0;
  let daysWritten = 0;
  let created = 0;
  let updated = 0;

  const outcome = await runSync(
    {
      integrationId: integration.id,
      organizationId: input.organizationId,
      clientId: integration.clientId,
      platform: Platform.GOOGLE_ADS,
    },
    async () => {
      if (attribution.size === 0) return { processed: 0, created: 0, updated: 0 };

      /*
       * One request for every campaign, not one per campaign. GAQL segments by
       * day inside a single response, so the whole window for the whole account
       * arrives at once — and asking per campaign would spend the rate limit on
       * a question already answered.
       */
      const rows = await fetchCampaignReport({
        customerId: target.customerId,
        accessToken,
        developerToken: config.developerToken,
        loginCustomerId: target.loginCustomerId ?? config.loginCustomerId,
        since,
        until,
        campaignIds: [...attribution.keys()],
        fetchImpl: input.fetchImpl,
      });

      const seenCampaigns = new Set<string>();

      for (const row of rows) {
        const campaignId = attribution.get(row.campaignId);
        // A campaign Google returned that we did not ask about cannot be
        // attributed, and is left alone rather than filed under a guess.
        if (!campaignId) continue;

        if (!seenCampaigns.has(row.campaignId)) {
          seenCampaigns.add(row.campaignId);
          campaignsRead += 1;
        }

        const date = new Date(`${row.date}T00:00:00.000Z`);

        const existing = await prisma.analyticsSnapshot.findFirst({
          where: { campaignId, platform: Platform.GOOGLE_ADS, date },
          select: { id: true },
        });

        /*
         * Provider figures overwrite ours: Google is the authority on its own
         * spend, and a revised day must replace the earlier read rather than
         * being added to it.
         *
         * `reach` is not written. Google Search has no reach metric — there are
         * queries, not people reached — and `advertising/metrics.ts` already
         * declares reach UNAVAILABLE for this platform. Copying impressions
         * into it would manufacture a number Google never produced.
         */
        const data = {
          spend: new Prisma.Decimal(row.cost.toFixed(2)),
          impressions: row.impressions,
          clicks: row.clicks,
          conversions: Math.round(row.conversions),
          revenue: new Prisma.Decimal(row.conversionValue.toFixed(2)),
        };

        if (existing) {
          await prisma.analyticsSnapshot.update({ where: { id: existing.id }, data });
          updated += 1;
        } else {
          await prisma.analyticsSnapshot.create({
            data: {
              organizationId: input.organizationId,
              clientId: integration.clientId,
              campaignId,
              platform: Platform.GOOGLE_ADS,
              date,
              engagements: 0,
              ...data,
            },
          });
          created += 1;
        }
        daysWritten += 1;
      }

      return { processed: campaignsRead, created, updated };
    },
  );

  return {
    integrationId: integration.id,
    runId: outcome.runId,
    status: outcome.status,
    customerId: target.customerId,
    from: since,
    to: until,
    campaignsRead,
    daysWritten,
    created,
    updated,
    skipped,
    errorMessage: outcome.errorMessage,
  };
}

export interface GoogleAdsCampaignSummary {
  campaignId: string;
  name: string;
  status: string;
  channelType: string | null;
  dailyBudget: number | null;
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
  conversionValue: number;
}

/**
 * Campaigns in the connected account, summed over a window.
 *
 * Read-only and unattributed: this answers "what is running in this Google Ads
 * account", which is a different question from "how did the campaigns NORIVA
 * published perform" — the one `syncGoogleAdsMetrics` answers by writing
 * snapshots. Nothing here is persisted, precisely because these campaigns may
 * have no local counterpart and inventing one would corrupt attribution.
 *
 * Ratios are not computed here either. `analytics.ts` derives CTR, CPC and the
 * rest from totals and refuses the ones it cannot; a second implementation
 * would give the application two answers to one question.
 */
export async function listGoogleAdsCampaigns(input: {
  prisma: PrismaClient;
  integrationId: string;
  organizationId: string;
  since: string;
  until: string;
  fetchImpl: FetchLike;
  now?: Date;
}): Promise<{ customerId: string; from: string; to: string; campaigns: GoogleAdsCampaignSummary[] }> {
  const integration = await input.prisma.integration.findFirst({
    where: { id: input.integrationId, organizationId: input.organizationId, platform: Platform.GOOGLE_ADS },
    include: { accounts: { where: { selected: true } } },
  });
  if (!integration) throw new GoogleAdsError(404, 'Google Ads: this connection does not exist.');

  if (integration.status !== IntegrationStatus.CONNECTED) {
    throw new GoogleAdsError(400, `Google Ads: this connection is ${integration.status.toLowerCase()}.`);
  }

  const target = selectedCustomer(integration.accounts);
  if (!target) {
    throw new GoogleAdsError(
      400,
      'Google Ads: no account is selected for this client. Choose one under Accounts.',
    );
  }

  const config = googleAdsConfig();
  const accessToken = await usableAccessToken({
    prisma: input.prisma,
    integrationId: integration.id,
    organizationId: input.organizationId,
    fetchImpl: input.fetchImpl,
    now: input.now,
  });

  const rows = await fetchCampaignReport({
    customerId: target.customerId,
    accessToken,
    developerToken: config.developerToken,
    loginCustomerId: target.loginCustomerId ?? config.loginCustomerId,
    since: input.since,
    until: input.until,
    fetchImpl: input.fetchImpl,
  });

  return {
    customerId: target.customerId,
    from: input.since,
    to: input.until,
    campaigns: rollUp(rows),
  };
}

/** Day rows to one row per campaign. Sums only — every ratio is derived later. */
function rollUp(rows: GoogleAdsCampaignRow[]): GoogleAdsCampaignSummary[] {
  const totals = new Map<string, GoogleAdsCampaignSummary>();

  for (const row of rows) {
    const existing = totals.get(row.campaignId);
    if (existing) {
      existing.impressions += row.impressions;
      existing.clicks += row.clicks;
      existing.cost += row.cost;
      existing.conversions += row.conversions;
      existing.conversionValue += row.conversionValue;
      continue;
    }

    totals.set(row.campaignId, {
      campaignId: row.campaignId,
      name: row.name,
      status: row.status,
      channelType: row.advertisingChannelType,
      // A budget is a current setting, not a daily measurement, so it is taken
      // from the first row rather than summed across the window.
      dailyBudget: row.dailyBudget,
      impressions: row.impressions,
      clicks: row.clicks,
      cost: row.cost,
      conversions: row.conversions,
      conversionValue: row.conversionValue,
    });
  }

  return [...totals.values()].sort((a, b) => b.cost - a.cost);
}

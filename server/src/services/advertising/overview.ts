/**
 * The advertising operation, read.
 *
 * One service behind the Advertising Command Center, the campaign table, the
 * campaign detail and the paid calendar — because they are four views of the
 * same two facts (what did we send to a provider, and what did the provider
 * report back) and splitting them would give four places for those facts to
 * disagree.
 *
 * What this does not do is as important as what it does. It computes no ratio
 * (`analytics.ts` does that), decides no metric state (`metrics.ts` does), maps
 * no provider status (`status.ts` does), and holds no opinion about what a
 * platform can do (`capability-matrix.ts` does). It loads rows, scopes them to
 * the caller's organisation, and hands them to those four.
 *
 * Scoping is not incidental here. A campaign row carries how much of somebody's
 * money was spent and what it bought; `scopeWhere(actor)` is applied to every
 * query below without exception, including the ones reached by naming an id
 * directly, and the tests name one tenant's ids from the other's session.
 */

import { Platform, PublicationStatus, type Prisma } from '@prisma/client';

import { prisma } from '../../lib/prisma.js';
import { scopeWhere, type Actor } from '../../lib/scope.js';
import { derive, sumSnapshots, PLATFORM_LABELS, type RawSnapshot } from '../analytics.js';
import { creativeFileUrl } from '../storage/objects.js';
import { matrixFor } from '../marketing/capability-matrix.js';
import { adStatusOf, ATTENTION_STATUSES, type AdStatus } from './status.js';
import { KPI_ORDER, qualifyAll, type PaidMetricName, type QualifiedMetric } from './metrics.js';

/** Platforms this product can advertise on at all, whatever the config says. */
export const AD_PLATFORMS: Platform[] = [
  Platform.FACEBOOK,
  Platform.INSTAGRAM,
  Platform.TIKTOK,
  Platform.GOOGLE_ADS,
  Platform.LINKEDIN,
  Platform.SNAPCHAT,
];

export interface AdvertisingFilters {
  clientId?: string;
  platform?: Platform;
  status?: AdStatus;
  objective?: string;
  campaignId?: string;
  accountId?: string;
  search?: string;
  from?: Date;
  to?: Date;
  page?: number;
  pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/**
 * The advertising platforms worth showing controls for, from the matrix.
 *
 * A platform whose paid channel is NOT_IMPLEMENTED or NOT_SUPPORTED is still
 * *listed* — with its state — because an operator looking for LinkedIn Ads
 * needs to learn it does not exist here rather than wonder where it went. What
 * it does not get is a filter option that would return nothing, or campaign
 * controls for campaigns that cannot be created.
 */
export interface PlatformAvailability {
  platform: Platform;
  label: string;
  state: string;
  detail: string;
  requiredEnv: string[];
  approval: string | null;
  /** Whether this platform may appear as a filter and carry controls. */
  selectable: boolean;
}

export function platformAvailability(): PlatformAvailability[] {
  return AD_PLATFORMS.map((platform) => {
    const paid = matrixFor(platform).paid;
    const campaigns = paid.capabilities.find((capability) => capability.surface === 'CAMPAIGNS');

    return {
      platform,
      label: PLATFORM_LABELS[platform],
      state: paid.state,
      detail: campaigns?.detail ?? '',
      requiredEnv: campaigns?.requiredEnv ?? [],
      approval: campaigns?.approval ?? null,
      // Built, whether or not a credential is present: a NOT_CONFIGURED
      // platform can still hold campaigns drafted before the credential
      // lapsed, and hiding them would hide real rows.
      selectable: paid.state !== 'NOT_IMPLEMENTED' && paid.state !== 'NOT_SUPPORTED',
    };
  });
}

// ------------------------------------------------------------- campaigns

export interface CampaignRow {
  id: string;
  name: string;
  platform: Platform;
  platformLabel: string;
  objective: string;
  status: AdStatus;
  statusDetail: string;
  providerStatus: string | null;
  clientId: string;
  clientName: string;
  /** Where the campaign is pointed, as the draft recorded it. */
  countries: string[];
  currency: string;
  startDate: Date;
  endDate: Date;
  publishedAt: Date | null;
  updatedAt: Date;
  managerUrl: string | null;
  /** Present only when the provider refused something. */
  error: { message: string; status: number | null } | null;
  metrics: QualifiedMetric[];
}

type PublicationRecord = Prisma.AdPublicationGetPayload<{
  include: { client: { select: { id: true; name: true; businessName: true } } };
}>;

/** Snapshot rows for a set of campaigns, keyed by campaign id. */
async function snapshotsFor(
  actor: Actor,
  publications: PublicationRecord[],
  from?: Date,
  to?: Date,
): Promise<Map<string, RawSnapshot[]>> {
  const campaignIds = [...new Set(publications.map((row) => row.campaignId).filter(Boolean))] as string[];
  const byCampaign = new Map<string, RawSnapshot[]>();
  if (campaignIds.length === 0) return byCampaign;

  const rows = await prisma.analyticsSnapshot.findMany({
    where: {
      ...scopeWhere(actor),
      campaignId: { in: campaignIds },
      ...(from || to ? { date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    },
    select: {
      campaignId: true, platform: true, date: true, spend: true, reach: true,
      impressions: true, clicks: true, conversions: true, revenue: true, engagements: true,
    },
  });

  for (const row of rows) {
    if (!row.campaignId) continue;
    const list = byCampaign.get(row.campaignId) ?? [];
    list.push(row);
    byCampaign.set(row.campaignId, list);
  }
  return byCampaign;
}

/**
 * Whether this row may claim the snapshot figures it can see.
 *
 * `AnalyticsSnapshot` is unique on (campaign, platform, day) — a *campaign*
 * grain. An `AdPublication` is finer than that: one campaign can carry several
 * advertisements on the same platform. So the figures are jointly the siblings'
 * and individually none of theirs, and printing them against each one both
 * multiplies the spend and, worse, attributes a running campaign's money to a
 * draft that has never been sent anywhere.
 *
 * Returns null when attribution is sound, or the reason it is not.
 */
function attributionBlock(publication: PublicationRecord, siblings: number): string | null {
  /*
   * A refusal is a better answer than an absence, so it is left to the
   * PROVIDER_ERROR path: an advertisement that failed at the provider *was*
   * sent, and telling the operator it "has not been published" would hide the
   * message that says why.
   */
  if (publication.errorMessage) return null;

  if (publication.status !== PublicationStatus.PUBLISHED) {
    return 'This advertisement has not been published, so no spend is attributed to it.';
  }
  if (siblings > 1) {
    return 'Performance is reported by the provider at campaign level, and this campaign carries '
      + 'more than one advertisement on this platform, so it cannot be attributed to this one alone.';
  }
  return null;
}

function toRow(
  publication: PublicationRecord,
  snapshots: RawSnapshot[],
  now: Date,
  siblings = 1,
): CampaignRow {
  const verdict = adStatusOf({
    status: publication.status,
    providerStatus: publication.providerStatus,
    endDate: publication.endDate,
    errorMessage: publication.errorMessage,
    now,
  });

  /*
   * Only this campaign's own platform is in scope, so UNAVAILABLE is decided
   * against exactly the provider that would have reported the metric — not
   * against the union of everything the operator happens to be filtering on.
   */
  const platform = publication.platform;
  const relevant = snapshots.filter((row) => row.platform === platform);

  const metrics = qualifyAll({
    platforms: [platform],
    sampleSize: relevant.length,
    providerErrored: Boolean(publication.errorMessage),
    unattributable: attributionBlock(publication, siblings),
    derived: derive(sumSnapshots(relevant)),
    budget: Number(publication.dailyBudget),
  });

  return {
    id: publication.id,
    name: publication.name,
    platform,
    platformLabel: PLATFORM_LABELS[platform],
    objective: publication.objective,
    status: verdict.status,
    statusDetail: verdict.detail,
    providerStatus: verdict.providerStatus,
    clientId: publication.clientId,
    clientName: publication.client.businessName || publication.client.name,
    countries: publication.countries,
    currency: publication.currency,
    startDate: publication.startDate,
    endDate: publication.endDate,
    publishedAt: publication.publishedAt,
    updatedAt: publication.updatedAt,
    managerUrl: publication.managerUrl,
    error: publication.errorMessage
      ? { message: publication.errorMessage, status: publication.errorStatus }
      : null,
    metrics,
  };
}

/** How many publications in this set share a snapshot's (campaign, platform). */
function siblingCounts(publications: PublicationRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of publications) {
    if (!row.campaignId) continue;
    const key = `${row.campaignId}:${row.platform}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

const siblingKey = (row: PublicationRecord) => `${row.campaignId ?? ''}:${row.platform}`;

/** Filters that can be pushed into the query; status is derived, so it cannot. */
function whereFrom(actor: Actor, filters: AdvertisingFilters): Prisma.AdPublicationWhereInput {
  return {
    ...scopeWhere(actor),
    ...(filters.clientId ? { clientId: filters.clientId } : {}),
    ...(filters.platform ? { platform: filters.platform } : {}),
    ...(filters.campaignId ? { campaignId: filters.campaignId } : {}),
    ...(filters.accountId ? { providerAccountId: filters.accountId } : {}),
    ...(filters.objective ? { objective: filters.objective } : {}),
    ...(filters.search ? { name: { contains: filters.search, mode: 'insensitive' as const } } : {}),
    ...(filters.from || filters.to
      ? {
        // A flight overlaps the window if it starts before the end of it and
        // ends after the beginning — not if both dates fall inside, which
        // would drop every campaign still running.
        ...(filters.to ? { startDate: { lte: filters.to } } : {}),
        ...(filters.from ? { endDate: { gte: filters.from } } : {}),
      }
      : {}),
  };
}

export interface CampaignPage {
  items: CampaignRow[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listCampaigns(
  actor: Actor,
  filters: AdvertisingFilters = {},
  now: Date = new Date(),
): Promise<CampaignPage> {
  const pageSize = Math.min(Math.max(filters.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const page = Math.max(filters.page ?? 1, 1);
  const where = whereFrom(actor, filters);

  /*
   * Status is derived from our status *and* the provider's *and* the end date,
   * so it cannot be a WHERE clause without duplicating that logic in SQL — two
   * implementations of the same rule, drifting. When a status filter is given
   * the page is assembled after mapping instead; without one, the database
   * paginates as usual.
   */
  if (!filters.status) {
    const [publications, total] = await Promise.all([
      prisma.adPublication.findMany({
        where,
        include: { client: { select: { id: true, name: true, businessName: true } } },
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.adPublication.count({ where }),
    ]);

    const snapshots = await snapshotsFor(actor, publications, filters.from, filters.to);
    const siblings = siblingCounts(publications);
    return {
      items: publications.map((row) =>
        toRow(row, snapshots.get(row.campaignId ?? '') ?? [], now, siblings.get(siblingKey(row)) ?? 1)),
      total,
      page,
      pageSize,
    };
  }

  const publications = await prisma.adPublication.findMany({
    where,
    include: { client: { select: { id: true, name: true, businessName: true } } },
    orderBy: { updatedAt: 'desc' },
    // Bounded: a status filter still must not load an unbounded table.
    take: MAX_PAGE_SIZE * 10,
  });

  const snapshots = await snapshotsFor(actor, publications, filters.from, filters.to);
  const statusSiblings = siblingCounts(publications);
  const mapped = publications
    .map((row) => toRow(row, snapshots.get(row.campaignId ?? '') ?? [], now, statusSiblings.get(siblingKey(row)) ?? 1))
    .filter((row) => row.status === filters.status);

  return {
    items: mapped.slice((page - 1) * pageSize, page * pageSize),
    total: mapped.length,
    page,
    pageSize,
  };
}

// -------------------------------------------------------------- overview

export interface AccountHealth {
  platform: Platform;
  label: string;
  clientId: string;
  clientName: string;
  /** From the integration record, never from a token. */
  connection: string;
  accountName: string | null;
  /** Selected ad accounts, by name and provider id. Never a token. */
  accounts: Array<{ name: string; externalId: string }>;
  lastError: string | null;
  lastSyncAt: Date | null;
}

export interface AdvertisingOverview {
  platforms: PlatformAvailability[];
  counts: Record<AdStatus, number> & { total: number; needsAttention: number };
  kpis: QualifiedMetric[];
  accounts: AccountHealth[];
  needsAttention: CampaignRow[];
  recent: CampaignRow[];
}

const EMPTY_COUNTS = (): Record<AdStatus, number> => ({
  DRAFT: 0, PENDING: 0, ACTIVE: 0, PAUSED: 0, COMPLETED: 0,
  FAILED: 0, REJECTED: 0, NEEDS_ATTENTION: 0, UNKNOWN: 0,
});

export async function advertisingOverview(
  actor: Actor,
  filters: AdvertisingFilters = {},
  now: Date = new Date(),
): Promise<AdvertisingOverview> {
  const where = whereFrom(actor, filters);

  const publications = await prisma.adPublication.findMany({
    where,
    include: { client: { select: { id: true, name: true, businessName: true } } },
    orderBy: { updatedAt: 'desc' },
    take: 500,
  });

  const snapshots = await snapshotsFor(actor, publications, filters.from, filters.to);
  const overviewSiblings = siblingCounts(publications);
  const rows = publications.map((row) =>
    toRow(row, snapshots.get(row.campaignId ?? '') ?? [], now, overviewSiblings.get(siblingKey(row)) ?? 1));

  const counts = EMPTY_COUNTS();
  for (const row of rows) counts[row.status] += 1;

  /*
   * The KPI row is qualified against every platform in the selection, so a
   * mixed selection reports a metric as measured when *any* of its platforms
   * reports it — and as unavailable only when none do. Filtering to Google Ads
   * alone therefore correctly reports reach as unavailable rather than as zero.
   */
  const platforms = filters.platform
    ? [filters.platform]
    : [...new Set(rows.map((row) => row.platform))];

  const allSnapshots = [...snapshots.values()].flat()
    .filter((row) => (filters.platform ? row.platform === filters.platform : true));

  const budget = rows.reduce((sum, row) => {
    const value = row.metrics.find((metric) => metric.metric === 'budget')?.value;
    return sum + (value ?? 0);
  }, 0);

  const kpis = qualifyAll({
    platforms: platforms.length > 0 ? platforms : AD_PLATFORMS,
    sampleSize: allSnapshots.length,
    providerErrored: rows.some((row) => row.error !== null),
    derived: derive(sumSnapshots(allSnapshots)),
    budget: rows.length > 0 ? budget : null,
  });

  const needsAttention = rows.filter((row) => ATTENTION_STATUSES.includes(row.status));

  return {
    platforms: platformAvailability(),
    counts: { ...counts, total: rows.length, needsAttention: needsAttention.length },
    kpis,
    accounts: await accountHealth(actor, filters),
    needsAttention: needsAttention.slice(0, 20),
    recent: rows.slice(0, 10),
  };
}

/**
 * Ad account connection state, from the existing integration records.
 *
 * Tokens are never selected, let alone returned — the connection status and the
 * chosen account names are what an operator needs, and are the most that can be
 * shown without handing out a credential.
 */
async function accountHealth(actor: Actor, filters: AdvertisingFilters): Promise<AccountHealth[]> {
  const integrations = await prisma.integration.findMany({
    where: {
      ...scopeWhere(actor),
      platform: { in: AD_PLATFORMS },
      ...(filters.clientId ? { clientId: filters.clientId } : {}),
      ...(filters.platform ? { platform: filters.platform } : {}),
    },
    select: {
      platform: true, status: true, accountName: true, lastError: true, lastSyncAt: true,
      client: { select: { id: true, name: true, businessName: true } },
      accounts: {
        where: { selected: true, kind: 'AD_ACCOUNT' },
        select: { name: true, externalId: true },
      },
    },
    orderBy: { platform: 'asc' },
  });

  return integrations.map((integration) => ({
    platform: integration.platform,
    label: PLATFORM_LABELS[integration.platform],
    clientId: integration.client.id,
    clientName: integration.client.businessName || integration.client.name,
    connection: integration.status,
    accountName: integration.accountName,
    accounts: integration.accounts,
    lastError: integration.lastError,
    lastSyncAt: integration.lastSyncAt,
  }));
}

// ---------------------------------------------------------------- detail

export interface CampaignActivity {
  step: string;
  ok: boolean;
  detail: string;
  at: string;
}

export interface CampaignDetail extends CampaignRow {
  /** Provider object ids, so an operator can find this in Ads Manager. */
  provider: {
    accountId: string | null;
    campaignId: string | null;
    adSetId: string | null;
    adId: string | null;
    creativeId: string | null;
  };
  copy: {
    headline: string;
    message: string;
    callToAction: string | null;
    linkUrl: string;
  };
  media: {
    kind: 'IMAGE' | 'VIDEO' | null;
    url: string | null;
    width: number | null;
    height: number | null;
    durationSeconds: number | null;
    mimeType: string | null;
    sizeBytes: number | null;
  };
  activity: CampaignActivity[];
  createdAt: Date;
}

export async function campaignDetail(
  actor: Actor,
  id: string,
  now: Date = new Date(),
): Promise<CampaignDetail | null> {
  const publication = await prisma.adPublication.findFirst({
    where: { id, ...scopeWhere(actor) },
    include: { client: { select: { id: true, name: true, businessName: true } } },
  });
  if (!publication) return null;

  const snapshots = publication.campaignId
    ? await prisma.analyticsSnapshot.findMany({
      where: { ...scopeWhere(actor), campaignId: publication.campaignId },
      select: {
        campaignId: true, platform: true, date: true, spend: true, reach: true,
        impressions: true, clicks: true, conversions: true, revenue: true, engagements: true,
      },
    })
    : [];

  /*
   * The same attribution question the list asks, asked again here: a detail
   * page for one of several advertisements on a campaign must not claim the
   * campaign's whole spend either.
   */
  const siblings = publication.campaignId
    ? await prisma.adPublication.count({
      where: {
        ...scopeWhere(actor),
        campaignId: publication.campaignId,
        platform: publication.platform,
      },
    })
    : 1;

  const row = toRow(publication, snapshots, now, siblings);
  const media = await loadMedia(publication);

  /*
   * `steps` is the audit trail the publish flow wrote as it went, so the
   * activity list is what actually happened rather than a reconstruction. A
   * failed publish keeps its steps, which is what makes a provider refusal
   * diagnosable after the fact.
   */
  const steps = Array.isArray(publication.steps)
    ? (publication.steps as unknown as CampaignActivity[])
    : [];

  return {
    ...row,
    provider: {
      accountId: publication.providerAccountId,
      campaignId: publication.providerCampaignId,
      adSetId: publication.providerAdSetId,
      adId: publication.providerAdId,
      creativeId: publication.providerCreativeId,
    },
    copy: {
      headline: publication.headline,
      message: publication.message,
      callToAction: publication.callToAction,
      linkUrl: publication.linkUrl,
    },
    media,
    activity: steps,
    createdAt: publication.createdAt,
  };
}

/** The creative behind a publication, as a URL the browser may already fetch. */
async function loadMedia(publication: {
  creativeId: string | null;
  videoCreativeId: string | null;
}): Promise<CampaignDetail['media']> {
  if (publication.videoCreativeId) {
    const video = await prisma.videoCreative.findUnique({
      where: { id: publication.videoCreativeId },
      select: { id: true, width: true, height: true, durationSeconds: true, sizeBytes: true, url: true },
    });
    if (video) {
      return {
        kind: 'VIDEO',
        // The proxied URL the model already stores. Never the storage key.
        url: video.url,
        width: video.width,
        height: video.height,
        durationSeconds: video.durationSeconds,
        mimeType: 'video/mp4',
        sizeBytes: video.sizeBytes,
      };
    }
  }

  if (publication.creativeId) {
    const creative = await prisma.creative.findUnique({
      where: { id: publication.creativeId },
      select: { id: true, width: true, height: true, format: true, sizeBytes: true },
    });
    if (creative) {
      return {
        kind: 'IMAGE',
        url: creativeFileUrl(creative.id),
        width: creative.width,
        height: creative.height,
        durationSeconds: null,
        mimeType: creative.format === 'PNG' ? 'image/png' : 'image/jpeg',
        sizeBytes: creative.sizeBytes ?? null,
      };
    }
  }

  return { kind: null, url: null, width: null, height: null, durationSeconds: null, mimeType: null, sizeBytes: null };
}

export { KPI_ORDER };
export type { PaidMetricName, QualifiedMetric, AdStatus };

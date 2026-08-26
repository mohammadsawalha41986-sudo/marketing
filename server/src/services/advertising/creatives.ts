/**
 * The ads creative library — every advertisement's artwork, with what it did.
 *
 * Built over the publications rather than over the `Creative` table, which is
 * the distinction that makes it an *ads* library rather than a second copy of
 * `/app/creatives`. That page answers "what have I uploaded and where can it
 * run"; this one answers "what actually ran, on which campaign, and how did it
 * do". Same files, different question, and the join to a campaign is the whole
 * of the difference.
 *
 * Download deserves its own note, because §7 is easy to get wrong. A creative
 * this deployment stores is downloadable — it is the operator's own file, and
 * the existing authenticated media routes already gate it. A creative that
 * exists only as a provider id (`providerCreativeId` with nothing local) is
 * not: Meta does not hand back the rendered asset, and offering a download
 * button that 404s is worse than not offering one. So `downloadUrl` is null
 * unless there is a local object to serve, and the UI keys off that rather
 * than off a guess.
 */

import { Platform, PublicationStatus, type Prisma } from '@prisma/client';

import { prisma } from '../../lib/prisma.js';
import { scopeWhere, type Actor } from '../../lib/scope.js';
import { derive, sumSnapshots, PLATFORM_LABELS, type RawSnapshot } from '../analytics.js';
import { creativeFileUrl } from '../storage/objects.js';
import { adStatusOf, type AdStatus } from './status.js';
import { qualifyAll, type QualifiedMetric } from './metrics.js';
import type { AdvertisingFilters } from './overview.js';

export interface CreativeCard {
  /** The publication this artwork ran on. The library's unit is the ad. */
  publicationId: string;
  campaignName: string;
  platform: Platform;
  platformLabel: string;
  clientId: string;
  clientName: string;
  status: AdStatus;
  kind: 'IMAGE' | 'VIDEO' | null;
  url: string | null;
  /** Null when the file lives only at the provider. See the header. */
  downloadUrl: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  sizeBytes: number | null;
  mimeType: string | null;
  headline: string;
  primaryText: string;
  callToAction: string | null;
  destination: string;
  createdAt: Date;
  publishedAt: Date | null;
  /** Spend, impressions, CTR and conversions — qualified, never invented. */
  metrics: QualifiedMetric[];
  /** The provider's refusal, when there was one. */
  error: { message: string; status: number | null } | null;
}

export interface CreativeLibraryPage {
  items: CreativeCard[];
  total: number;
  page: number;
  pageSize: number;
}

const CARD_METRICS = ['spend', 'impressions', 'ctr', 'conversions'] as const;

export async function creativeLibrary(
  actor: Actor,
  filters: AdvertisingFilters & { kind?: 'IMAGE' | 'VIDEO' } = {},
  now: Date = new Date(),
): Promise<CreativeLibraryPage> {
  const pageSize = Math.min(Math.max(filters.pageSize ?? 24, 1), 100);
  const page = Math.max(filters.page ?? 1, 1);

  const where: Prisma.AdPublicationWhereInput = {
    ...scopeWhere(actor),
    ...(filters.clientId ? { clientId: filters.clientId } : {}),
    ...(filters.platform ? { platform: filters.platform } : {}),
    ...(filters.campaignId ? { campaignId: filters.campaignId } : {}),
    ...(filters.accountId ? { providerAccountId: filters.accountId } : {}),
    ...(filters.search ? { name: { contains: filters.search, mode: 'insensitive' as const } } : {}),
    ...(filters.from ? { createdAt: { gte: filters.from } } : {}),
    ...(filters.to ? { createdAt: { lte: filters.to } } : {}),
    // A card is a picture of something. A publication with neither a creative
    // nor a video has no artwork to show and belongs on the campaign table.
    ...(filters.kind === 'IMAGE'
      ? { creativeId: { not: null } }
      : filters.kind === 'VIDEO'
        ? { videoCreativeId: { not: null } }
        : { OR: [{ creativeId: { not: null } }, { videoCreativeId: { not: null } }] }),
  };

  const [publications, total] = await Promise.all([
    prisma.adPublication.findMany({
      where,
      include: { client: { select: { id: true, name: true, businessName: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.adPublication.count({ where }),
  ]);

  // One query per kind for the whole page rather than one per card.
  const creativeIds = publications.map((row) => row.creativeId).filter(Boolean) as string[];
  const videoIds = publications.map((row) => row.videoCreativeId).filter(Boolean) as string[];
  const campaignIds = [...new Set(publications.map((row) => row.campaignId).filter(Boolean))] as string[];

  const [creatives, videos, snapshots] = await Promise.all([
    creativeIds.length > 0
      ? prisma.creative.findMany({
        where: { id: { in: creativeIds }, ...scopeWhere(actor) },
        select: { id: true, width: true, height: true, format: true, sizeBytes: true, storageKey: true },
      })
      : [],
    videoIds.length > 0
      ? prisma.videoCreative.findMany({
        where: { id: { in: videoIds }, ...scopeWhere(actor) },
        select: { id: true, width: true, height: true, durationSeconds: true, sizeBytes: true, url: true, storageKey: true },
      })
      : [],
    campaignIds.length > 0
      ? prisma.analyticsSnapshot.findMany({
        where: { ...scopeWhere(actor), campaignId: { in: campaignIds } },
        select: {
          campaignId: true, platform: true, date: true, spend: true, reach: true,
          impressions: true, clicks: true, conversions: true, revenue: true, engagements: true,
        },
      })
      : [],
  ]);

  /*
   * Counted across the whole campaign, not just this page: a sibling on page
   * two makes attribution unsound on page one too.
   */
  const siblingCounts = new Map<string, number>();
  for (const group of await prisma.adPublication.groupBy({
    by: ['campaignId', 'platform'],
    where: { ...scopeWhere(actor), campaignId: { in: campaignIds } },
    _count: { _all: true },
  })) {
    if (group.campaignId) siblingCounts.set(`${group.campaignId}:${group.platform}`, group._count._all);
  }

  const creativeById = new Map(creatives.map((row) => [row.id, row]));
  const videoById = new Map(videos.map((row) => [row.id, row]));
  const byCampaign = new Map<string, RawSnapshot[]>();
  for (const row of snapshots) {
    if (!row.campaignId) continue;
    const list = byCampaign.get(row.campaignId) ?? [];
    list.push(row);
    byCampaign.set(row.campaignId, list);
  }

  const items = publications.map((publication): CreativeCard => {
    const video = publication.videoCreativeId ? videoById.get(publication.videoCreativeId) : undefined;
    const creative = publication.creativeId ? creativeById.get(publication.creativeId) : undefined;

    const verdict = adStatusOf({
      status: publication.status,
      providerStatus: publication.providerStatus,
      endDate: publication.endDate,
      errorMessage: publication.errorMessage,
      now,
    });

    const relevant = (byCampaign.get(publication.campaignId ?? '') ?? [])
      .filter((row) => row.platform === publication.platform);

    /*
     * Same grain problem as the campaign table: a snapshot is campaign-level,
     * so a card can only claim it when this advertisement is the only one of
     * its campaign on this platform — and never before it has published.
     */
    const siblings = publication.campaignId
      ? (siblingCounts.get(`${publication.campaignId}:${publication.platform}`) ?? 1)
      : 1;
    // A provider refusal is the better answer; see `attributionBlock`.
    const unattributable = publication.errorMessage
      ? null
      : publication.status !== PublicationStatus.PUBLISHED
      ? 'This advertisement has not been published, so no spend is attributed to it.'
      : siblings > 1
        ? 'Performance is reported at campaign level and this campaign carries more than one '
          + 'advertisement on this platform, so it cannot be attributed to this one alone.'
        : null;

    const metrics = qualifyAll(
      {
        platforms: [publication.platform],
        sampleSize: relevant.length,
        providerErrored: Boolean(publication.errorMessage),
        unattributable,
        derived: derive(sumSnapshots(relevant)),
        budget: Number(publication.dailyBudget),
      },
      [...CARD_METRICS],
    );

    const url = video ? video.url : creative ? creativeFileUrl(creative.id) : null;
    /*
     * Downloadable only when we hold the bytes. `storageKey` is the proof: a
     * publication that carries a provider creative id but no local object is
     * artwork Meta rendered, which their API does not hand back.
     */
    const hasLocalObject = Boolean(video?.storageKey ?? creative?.storageKey);

    return {
      publicationId: publication.id,
      campaignName: publication.name,
      platform: publication.platform,
      platformLabel: PLATFORM_LABELS[publication.platform],
      clientId: publication.clientId,
      clientName: publication.client.businessName || publication.client.name,
      status: verdict.status,
      kind: video ? 'VIDEO' : creative ? 'IMAGE' : null,
      url,
      downloadUrl: hasLocalObject ? url : null,
      width: video?.width ?? creative?.width ?? null,
      height: video?.height ?? creative?.height ?? null,
      durationSeconds: video?.durationSeconds ?? null,
      sizeBytes: video?.sizeBytes ?? creative?.sizeBytes ?? null,
      mimeType: video ? 'video/mp4' : creative?.format === 'PNG' ? 'image/png' : creative ? 'image/jpeg' : null,
      headline: publication.headline,
      primaryText: publication.message,
      callToAction: publication.callToAction,
      destination: publication.linkUrl,
      createdAt: publication.createdAt,
      publishedAt: publication.publishedAt,
      metrics,
      error: publication.errorMessage
        ? { message: publication.errorMessage, status: publication.errorStatus }
        : null,
    };
  });

  return { items, total, page, pageSize };
}

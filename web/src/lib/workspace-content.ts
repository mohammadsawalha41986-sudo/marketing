/**
 * Shared vocabulary for the content command centre.
 *
 * Colours and platform labels are not redefined here — they come from
 * `format.ts`, which the chips, charts and analytics already read, so a
 * platform looks the same everywhere in the product. What this module adds is
 * the part the workspace needs and nothing else had: the platform order the
 * navigation and toolbar use, the status vocabulary the cards group by, and the
 * shapes the `/social/content`, `/social/capabilities` and recommendation
 * endpoints return.
 */

import type { BadgeTone } from '../components/ui';
import type { Platform } from './api';

/** The platforms the workspace composes for, in the order it shows them. */
export const WORKSPACE_PLATFORMS: Platform[] = [
  'FACEBOOK', 'INSTAGRAM', 'TIKTOK', 'YOUTUBE', 'LINKEDIN',
];

/** Route segment ⇄ platform, so /app/library/instagram resolves to INSTAGRAM. */
export const PLATFORM_SLUGS: Record<string, Platform> = {
  facebook: 'FACEBOOK',
  instagram: 'INSTAGRAM',
  tiktok: 'TIKTOK',
  youtube: 'YOUTUBE',
  linkedin: 'LINKEDIN',
};

export const slugFor = (platform: Platform): string => platform.toLowerCase();

export type PlatformPostStatus =
  | 'DRAFT' | 'IN_REVIEW' | 'CHANGES_REQUESTED' | 'APPROVED' | 'SCHEDULED'
  | 'QUEUED' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED' | 'CANCELLED';

export const STATUS_TONES: Record<PlatformPostStatus, BadgeTone> = {
  DRAFT: 'neutral',
  IN_REVIEW: 'warn',
  CHANGES_REQUESTED: 'warn',
  APPROVED: 'ok',
  SCHEDULED: 'brand',
  QUEUED: 'brand',
  PUBLISHING: 'brand',
  PUBLISHED: 'accent',
  FAILED: 'danger',
  CANCELLED: 'neutral',
};

/**
 * The status groups the workspace filters by.
 *
 * `NEEDS_ATTENTION` is not a status the database holds — it is the question an
 * operator actually asks in the morning, and it spans two real statuses that
 * both mean "this will not go out unless you do something". Keeping it as a
 * filter rather than inventing a status leaves the state machine alone.
 */
export const STATUS_GROUPS = {
  ALL: [] as PlatformPostStatus[],
  DRAFT: ['DRAFT'],
  SCHEDULED: ['SCHEDULED', 'QUEUED'],
  PUBLISHED: ['PUBLISHED'],
  FAILED: ['FAILED'],
  NEEDS_ATTENTION: ['CHANGES_REQUESTED', 'FAILED'],
} as const;

export type StatusGroup = keyof typeof STATUS_GROUPS;

// ------------------------------------------------------------------ payloads

export interface WorkspaceMedia {
  position: number;
  role: string | null;
  media: {
    id: string;
    url: string;
    thumbnailUrl: string | null;
    type: string;
    mimeType: string | null;
  };
}

/** One platform's version of a post, as the workspace feed returns it. */
export interface WorkspacePost {
  id: string;
  platform: Platform;
  caption: string | null;
  headline: string | null;
  hashtags: string[];
  linkUrl: string | null;
  ctaLabel: string | null;
  config: Record<string, unknown>;
  status: PlatformPostStatus;
  scheduledAt: string | null;
  timezone: string;
  externalUrl: string | null;
  publishedAt: string | null;
  updatedAt: string;
  errorCode: string | null;
  errorMessage: string | null;
  integrationAccount: { id: string; name: string; tokenStatus: string } | null;
  postGroup: {
    id: string;
    name: string;
    status: string;
    client: { id: string; name: string; businessName: string };
    campaign: { id: string; name: string } | null;
  };
  media: WorkspaceMedia[];
}

export interface Placement {
  key: string;
  label: string;
  surface: string;
}

export type GeoLevel = 'COUNTRY' | 'REGION' | 'CITY' | 'AREA';

export interface PlatformCapability {
  platform: Platform;
  publishes: boolean;
  surfaces: Placement[];
  adPlacements: Placement[];
  geo: { organic: GeoLevel[]; paid: GeoLevel[] };
  formats: string[];
  hasHeadline: boolean;
}

export type Basis = 'HISTORICAL' | 'CONTEXT';
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface Recommendation {
  key:
    | 'BEST_TIME' | 'BEST_DAY' | 'LOCATION' | 'AUDIENCE' | 'BEST_PLATFORM'
    | 'FORMAT' | 'HOOK' | 'CTA' | 'CAPTION' | 'HASHTAGS' | 'LANGUAGE' | 'ANGLE';
  value: string;
  reason: string;
  basis: Basis;
  confidence: Confidence;
  sampleSize: number;
}

export interface RecommendationReport {
  platformPostId: string;
  platform: Platform;
  insufficientData: boolean;
  sampleSize: number;
  insufficientDataMessage: string | null;
  recommendations: Recommendation[];
  qualityScore: number;
  qualityFindings: string[];
}

/**
 * The content type a post is, read from what it actually carries.
 *
 * Derived rather than stored: the media and the platform config already say
 * whether this is a Reel, a carousel or a link post, and a second field
 * recording the same thing is a field that can disagree with them.
 */
export function contentTypeOf(post: WorkspacePost): string {
  const surface = typeof post.config?.mediaType === 'string' ? String(post.config.mediaType) : null;
  if (surface) return surface;
  const videos = post.media.filter((row) => row.media.type === 'VIDEO').length;
  if (videos > 0) return 'VIDEO';
  if (post.media.length > 1) return 'CAROUSEL';
  if (post.media.length === 1) return 'IMAGE';
  if (post.linkUrl) return 'LINK';
  return 'TEXT';
}

/** The preview input a platform preview component expects, from a feed row. */
export function previewInputFor(post: WorkspacePost, logoUrl?: string | null) {
  return {
    brandName: post.postGroup.client.businessName,
    logoUrl,
    headline: post.headline,
    caption: post.caption,
    hashtags: post.hashtags,
    ctaLabel: post.ctaLabel,
    linkUrl: post.linkUrl,
    media: post.media.map((row) => ({
      url: row.media.thumbnailUrl ?? row.media.url,
      kind: (row.media.type === 'VIDEO' ? 'VIDEO' : 'IMAGE') as 'IMAGE' | 'VIDEO',
    })),
    config: post.config,
  };
}

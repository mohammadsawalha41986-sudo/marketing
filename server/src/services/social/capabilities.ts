/**
 * What each platform can actually do — organic surfaces, paid placements, and
 * how far its geo targeting reaches.
 *
 * This registry exists so the composer can stop guessing. A control the
 * provider does not support is worse than a missing one: it tells the operator
 * a post is targeted at Riyadh when nothing in the request will carry that,
 * and the gap only shows up as a campaign that under-delivered.
 *
 * So every entry here is a claim about an integration this repository actually
 * has. `publishes` is read from the publisher registry rather than restated,
 * which means a platform whose adapter is a refusal stub cannot appear
 * publishable by drifting out of sync with one.
 *
 * Two rules the shape enforces:
 *
 *   1. Organic surfaces and paid placements are separate lists. An organic post
 *      has no targeting, and rendering ad-placement controls beside one implies
 *      a capability the organic API does not have.
 *   2. `geo.organic` is a *context* level — the location a post is about, which
 *      the provider may show as a tag. `geo.paid` is a *targeting* level, which
 *      only exists where this repository has an ads integration.
 */

import { Platform } from '@prisma/client';

import { publisherFor } from '../publishing/registry.js';

/** How precisely a platform can be pointed at a place. */
export type GeoLevel = 'COUNTRY' | 'REGION' | 'CITY' | 'AREA';

export interface Placement {
  key: string;
  label: string;
  /** The media surface this placement renders in, keyed as in media-rules. */
  surface: string;
}

export interface PlatformCapability {
  platform: Platform;
  /** Whether this repository has a working publisher for it. */
  publishes: boolean;
  /** Organic surfaces the operator can compose for. */
  surfaces: Placement[];
  /**
   * Paid placements, empty where this repository has no ads integration for the
   * platform. Never populated speculatively: an empty list is the honest answer
   * for a platform we can only post organically to.
   */
  adPlacements: Placement[];
  geo: {
    /** Location context on an organic post, as deep as the provider accepts. */
    organic: GeoLevel[];
    /** Targeting levels available through our ads integration, if any. */
    paid: GeoLevel[];
  };
  /** Content formats the composer should offer, in preference order. */
  formats: string[];
  /** Whether the platform separates a title from the body. */
  hasHeadline: boolean;
}

/*
 * The organic surfaces below mirror media-rules' RULES keys exactly. They are
 * listed rather than derived because media-rules answers "will this file work",
 * which is a different question from "may the operator choose this", and a
 * platform can have a rule for a surface we do not offer.
 */
const SURFACES: Record<string, Placement[]> = {
  FACEBOOK: [{ key: 'FEED', label: 'Feed', surface: 'FEED' }],
  INSTAGRAM: [
    { key: 'FEED', label: 'Feed', surface: 'FEED' },
    { key: 'CAROUSEL', label: 'Carousel', surface: 'CAROUSEL' },
    { key: 'REEL', label: 'Reel', surface: 'REEL' },
  ],
  TIKTOK: [{ key: 'VIDEO', label: 'Video', surface: 'VIDEO' }],
  YOUTUBE: [{ key: 'VIDEO', label: 'Video', surface: 'VIDEO' }],
  LINKEDIN: [{ key: 'FEED', label: 'Feed', surface: 'FEED' }],
  GOOGLE_BUSINESS: [
    { key: 'UPDATE', label: 'Update', surface: 'UPDATE' },
    { key: 'OFFER', label: 'Offer', surface: 'UPDATE' },
    { key: 'EVENT', label: 'Event', surface: 'UPDATE' },
  ],
};

/*
 * Paid placements, only where an ads integration exists in this repository.
 *
 * Meta's are the placements its ads API accepts for a feed/story/reel creative.
 * Google Ads and TikTok Ads have publish flows here, so they get their real
 * placement vocabulary. LinkedIn and YouTube have organic publishers only —
 * there is no LinkedIn Ads or YouTube Ads integration in this codebase, so
 * their paid lists are empty and the UI must not offer targeting for them.
 */
const AD_PLACEMENTS: Record<string, Placement[]> = {
  FACEBOOK: [
    { key: 'FACEBOOK_FEED', label: 'Facebook feed', surface: 'FEED' },
    { key: 'FACEBOOK_STORY', label: 'Facebook Stories', surface: 'REEL' },
    { key: 'FACEBOOK_REELS', label: 'Facebook Reels', surface: 'REEL' },
  ],
  INSTAGRAM: [
    { key: 'INSTAGRAM_FEED', label: 'Instagram feed', surface: 'FEED' },
    { key: 'INSTAGRAM_STORY', label: 'Instagram Stories', surface: 'REEL' },
    { key: 'INSTAGRAM_REELS', label: 'Instagram Reels', surface: 'REEL' },
    { key: 'INSTAGRAM_EXPLORE', label: 'Explore', surface: 'FEED' },
  ],
  TIKTOK: [{ key: 'TIKTOK_FEED', label: 'For You feed', surface: 'VIDEO' }],
  GOOGLE_ADS: [
    { key: 'GOOGLE_SEARCH', label: 'Search', surface: 'SEARCH' },
    { key: 'GOOGLE_DISPLAY', label: 'Display', surface: 'DISPLAY' },
  ],
};

/*
 * Geo.
 *
 * Organic levels are what the provider will attach to a post. Meta accepts a
 * page-level location tag, Google Business is inherently a place, and TikTok,
 * YouTube and LinkedIn organic posts carry no structured location at all — so
 * they get an empty list rather than a control that writes nothing.
 *
 * Paid levels follow the ads integrations, and stop where ours do.
 */
const GEO: Record<string, { organic: GeoLevel[]; paid: GeoLevel[] }> = {
  FACEBOOK: { organic: ['COUNTRY', 'CITY'], paid: ['COUNTRY', 'REGION', 'CITY'] },
  INSTAGRAM: { organic: ['COUNTRY', 'CITY'], paid: ['COUNTRY', 'REGION', 'CITY'] },
  TIKTOK: { organic: [], paid: ['COUNTRY', 'REGION'] },
  YOUTUBE: { organic: [], paid: [] },
  LINKEDIN: { organic: [], paid: [] },
  GOOGLE_BUSINESS: { organic: ['COUNTRY', 'REGION', 'CITY', 'AREA'], paid: [] },
  GOOGLE_ADS: { organic: [], paid: ['COUNTRY', 'REGION', 'CITY', 'AREA'] },
};

/*
 * Formats, in the order the composer should suggest them. This is editorial
 * guidance about what performs on each surface, not a provider constraint —
 * media-rules remains the authority on what a platform will accept.
 */
const FORMATS: Record<string, string[]> = {
  FACEBOOK: ['IMAGE', 'VIDEO', 'LINK', 'TEXT'],
  INSTAGRAM: ['REEL', 'CAROUSEL', 'IMAGE'],
  TIKTOK: ['VIDEO'],
  YOUTUBE: ['VIDEO'],
  LINKEDIN: ['TEXT', 'IMAGE', 'LINK'],
  GOOGLE_BUSINESS: ['IMAGE', 'TEXT'],
};

/** Platforms that separate a title from the body. */
const HEADLINE = new Set<string>(['YOUTUBE', 'GOOGLE_BUSINESS', 'LINKEDIN']);

/** The platforms the content workspace composes for, in display order. */
export const WORKSPACE_PLATFORMS: Platform[] = [
  Platform.FACEBOOK,
  Platform.INSTAGRAM,
  Platform.TIKTOK,
  Platform.YOUTUBE,
  Platform.LINKEDIN,
];

export function capabilityFor(platform: Platform): PlatformCapability {
  return {
    platform,
    // Read from the registry rather than restated, so a platform whose adapter
    // is a refusal stub cannot look publishable here.
    publishes: publisherFor(platform)?.canPublish ?? false,
    surfaces: SURFACES[platform] ?? [],
    adPlacements: AD_PLACEMENTS[platform] ?? [],
    geo: GEO[platform] ?? { organic: [], paid: [] },
    formats: FORMATS[platform] ?? [],
    hasHeadline: HEADLINE.has(platform),
  };
}

/** Every platform the workspace knows about, with its honest capabilities. */
export function allCapabilities(): PlatformCapability[] {
  return WORKSPACE_PLATFORMS.map(capabilityFor);
}

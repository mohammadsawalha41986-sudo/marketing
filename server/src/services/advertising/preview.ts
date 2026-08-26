/**
 * What an advertisement will look like, per placement — and when we cannot say.
 *
 * The honest core of this file is the third answer. A preview is a promise
 * about what a customer will see, and there are three truthful things to say
 * about one: this is exactly it, this is approximately it, or we do not have
 * enough to show you. Products that only have the first answer end up showing
 * the third case as the first, which is worse than showing nothing — an
 * operator approves a layout that will not be the layout.
 *
 * So every placement returned here carries a `fidelity`:
 *
 *   EXACT        every field the placement renders is present and real
 *   ESTIMATED    renderable, but something optional is missing or inferred
 *   UNAVAILABLE  not renderable, with the reason stated
 *
 * Three registries already answer the questions this needs, and none of them is
 * re-implemented here:
 *
 *   `social/capabilities.ts`  which paid placements a platform even has
 *   `social/media-rules.ts`   whether this file fits that placement
 *   `marketing/capability-matrix.ts` whether we have an ads integration at all
 *
 * The last one is why Snapchat and LinkedIn produce no placements: their paid
 * channel is NOT_IMPLEMENTED, and a preview of an advertisement that cannot be
 * created would be a picture of nothing.
 */

import { MediaType, Platform } from '@prisma/client';

import { capabilityFor, type Placement } from '../social/capabilities.js';
import { matrixFor } from '../marketing/capability-matrix.js';
import { validateMediaForPlatform, type MediaFacts } from '../social/media-rules.js';

export type PreviewFidelity = 'EXACT' | 'ESTIMATED' | 'UNAVAILABLE';

export interface PreviewPlacement {
  key: string;
  label: string;
  /** The media surface, as media-rules names it. */
  surface: string;
  fidelity: PreviewFidelity;
  /** Why it is estimated or unavailable. Null when EXACT. */
  reason: string | null;
  /** Findings from the existing validator, verbatim. */
  findings: Array<{ level: string; message: string }>;
}

export interface PreviewCreative {
  kind: 'IMAGE' | 'VIDEO' | null;
  /** Served through the existing authenticated media proxy, never a raw key. */
  url: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  mimeType: string | null;
  sizeBytes: number | null;
}

export interface AdPreview {
  platform: Platform;
  /** The advertiser as the placement chrome will show it. */
  advertiser: { name: string; avatarUrl: string | null };
  creative: PreviewCreative;
  headline: string | null;
  primaryText: string | null;
  description: string | null;
  callToAction: string | null;
  destination: string | null;
  placements: PreviewPlacement[];
  /** Set when no placement can be rendered at all. */
  unavailable: string | null;
}

export interface PreviewSource {
  platform: Platform;
  advertiserName: string;
  advertiserAvatarUrl: string | null;
  headline: string | null;
  message: string | null;
  description: string | null;
  callToAction: string | null;
  linkUrl: string | null;
  media: (MediaFacts & { url: string | null }) | null;
}

/**
 * Fields a placement must have to be an exact rendering rather than a sketch.
 *
 * Story and Reel chrome shows almost nothing but the creative and the call to
 * action, so a missing headline does not make one estimated — it makes it
 * accurate. Feed chrome shows the headline and the body, so the same absence
 * there means the preview is not what will run.
 */
const FEED_FIELDS = ['primaryText', 'headline', 'callToAction', 'destination'] as const;
const IMMERSIVE_FIELDS = ['callToAction', 'destination'] as const;

function requiredFor(placementKey: string): readonly string[] {
  return /STORY|REEL|TIKTOK/.test(placementKey) ? IMMERSIVE_FIELDS : FEED_FIELDS;
}

/**
 * Google Search has no creative to render — it is text — so it is the one
 * placement whose preview is exact without any media at all.
 */
function isTextOnly(placementKey: string): boolean {
  return placementKey === 'GOOGLE_SEARCH';
}

export function buildPreview(source: PreviewSource): AdPreview {
  const values: Record<string, string | null> = {
    primaryText: source.message?.trim() || null,
    headline: source.headline?.trim() || null,
    callToAction: source.callToAction?.trim() || null,
    destination: source.linkUrl?.trim() || null,
  };

  const creative: PreviewCreative = source.media
    ? {
      kind: source.media.type === MediaType.VIDEO ? 'VIDEO' : 'IMAGE',
      url: source.media.url,
      width: source.media.width ?? null,
      height: source.media.height ?? null,
      durationSeconds: source.media.durationSeconds ?? null,
      mimeType: source.media.mimeType,
      sizeBytes: source.media.sizeBytes,
    }
    : { kind: null, url: null, width: null, height: null, durationSeconds: null, mimeType: null, sizeBytes: null };

  const base: Omit<AdPreview, 'placements' | 'unavailable'> = {
    platform: source.platform,
    advertiser: { name: source.advertiserName, avatarUrl: source.advertiserAvatarUrl },
    creative,
    headline: values.headline ?? null,
    primaryText: values.primaryText ?? null,
    description: source.description?.trim() || null,
    callToAction: values.callToAction ?? null,
    destination: values.destination ?? null,
  };

  /*
   * No ads integration for this platform means no advertisement to preview.
   * Read from the matrix rather than restated, so a platform that gains an
   * integration later gains its previews without this file being edited.
   */
  const paid = matrixFor(source.platform).paid;
  if (!paid.available || paid.state === 'NOT_IMPLEMENTED' || paid.state === 'NOT_SUPPORTED') {
    return {
      ...base,
      placements: [],
      unavailable:
        paid.capabilities.find((capability) => capability.surface === 'CAMPAIGNS')?.detail
        ?? 'This platform has no advertising integration in this deployment.',
    };
  }

  const declared: Placement[] = capabilityFor(source.platform).adPlacements;
  if (declared.length === 0) {
    return {
      ...base,
      placements: [],
      unavailable: 'No advertising placements are declared for this platform.',
    };
  }

  const placements = declared.map((placement) => evaluate(placement, source, values));

  return {
    ...base,
    placements,
    unavailable: placements.every((placement) => placement.fidelity === 'UNAVAILABLE')
      ? 'There is not enough on this advertisement to render any placement.'
      : null,
  };
}

function evaluate(
  placement: Placement,
  source: PreviewSource,
  values: Record<string, string | null>,
): PreviewPlacement {
  const findings = source.media
    ? validateMediaForPlatform(source.media, source.platform, placement.surface)
      .map((finding) => ({ level: finding.level, message: finding.message }))
    : [];

  // A text placement is complete without any file at all.
  if (isTextOnly(placement.key)) {
    const missing = ['headline', 'primaryText', 'destination'].filter((field) => !values[field]);
    return {
      key: placement.key,
      label: placement.label,
      surface: placement.surface,
      fidelity: missing.length === 0 ? 'EXACT' : missing.length >= 3 ? 'UNAVAILABLE' : 'ESTIMATED',
      reason: missing.length === 0
        ? null
        : missing.length >= 3
          ? 'This advertisement has no headline, body or destination to render.'
          : `Rendered without ${missing.join(' and ')}, which the real advertisement will show.`,
      findings,
    };
  }

  if (!source.media?.url) {
    return {
      key: placement.key,
      label: placement.label,
      surface: placement.surface,
      fidelity: 'UNAVAILABLE',
      reason: 'This advertisement has no media in storage, and this placement is built around it.',
      findings,
    };
  }

  /*
   * The existing validator decides fit, not a second copy of its rules here. An
   * INCOMPATIBLE finding means the platform would refuse the file, so a preview
   * would be showing something that cannot run.
   */
  if (findings.some((finding) => finding.level === 'INCOMPATIBLE')) {
    return {
      key: placement.key,
      label: placement.label,
      surface: placement.surface,
      fidelity: 'UNAVAILABLE',
      reason: findings.find((finding) => finding.level === 'INCOMPATIBLE')!.message,
      findings,
    };
  }

  const missing = requiredFor(placement.key).filter((field) => !values[field]);
  // A WARNING means it will run but be cropped or re-encoded — so what renders
  // here is close, not exact, and saying so is the whole point of the field.
  const cropped = findings.some((finding) => finding.level === 'WARNING');

  if (missing.length === 0 && !cropped) {
    return { key: placement.key, label: placement.label, surface: placement.surface, fidelity: 'EXACT', reason: null, findings };
  }

  return {
    key: placement.key,
    label: placement.label,
    surface: placement.surface,
    fidelity: 'ESTIMATED',
    reason: cropped
      ? findings.find((finding) => finding.level === 'WARNING')!.message
      : `Rendered without ${missing.join(' and ')}, which the real advertisement will show.`,
    findings,
  };
}

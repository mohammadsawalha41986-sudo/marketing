/**
 * What each placement will actually accept.
 *
 * The rendering presets in `presets.ts` answer a different question — what
 * dimensions do we *produce* — and they are not a substitute for this. A
 * preset says "an Instagram portrait is 1080×1350"; a spec says "this placement
 * takes 4:5 to 1.91:1, at least 500px wide, JPEG or PNG, up to 30MB", which is
 * what decides whether the operator's own file can run.
 *
 * Ranges, not exact sizes. The whole product rests on the operator's file being
 * usable as it is, and a spec written as one magic size would reject a perfectly
 * good 1080×1349 for being one pixel out.
 *
 * Every entry carries where it came from and when it was checked, because these
 * numbers go stale silently and a wrong limit is worse than no limit: it either
 * blocks a valid ad or waves through one the platform will reject. The values
 * below were transcribed on the date in `verifiedAt` and are documented in
 * docs/PLATFORM_SPECS.md. They are *conservative* — where sources disagreed the
 * stricter number was taken — and they must be re-checked against the official
 * documentation before anyone treats a PASS here as a guarantee.
 */

import { Platform } from '@prisma/client';

export interface PlacementSpec {
  key: string;
  platform: Platform;
  label: string;
  /** FEED, STORY, REEL… what the ad looks like where it lands. */
  surface: string;
  creativeTypes: Array<'IMAGE' | 'VIDEO'>;
  /** Inclusive width/height ratio window this placement serves. */
  aspectRatio: { min: number; max: number; recommended: number };
  minWidth: number;
  minHeight: number;
  /** Bytes. */
  maxFileSize: number;
  allowedMimeTypes: string[];
  /** Seconds. Video placements only. */
  minDuration?: number;
  maxDuration?: number;
  sourceUrl: string;
  verifiedAt: string;
}

const IMAGE_MIME = ['image/jpeg', 'image/png'];
const VIDEO_MIME = ['video/mp4', 'video/quicktime'];

const IMAGE_MB = 30 * 1024 * 1024;
const VIDEO_MB = 4 * 1024 * 1024 * 1024;

const META_DOCS = 'https://www.facebook.com/business/ads-guide';
const TIKTOK_DOCS = 'https://ads.tiktok.com/help/article/tiktok-ads-specifications';
const VERIFIED = '2026-08-16';

export const PLACEMENT_SPECS: PlacementSpec[] = [
  // ------------------------------------------------------------------ Meta
  {
    key: 'FACEBOOK_FEED_IMAGE',
    platform: Platform.FACEBOOK,
    label: 'Facebook Feed',
    surface: 'FEED',
    creativeTypes: ['IMAGE'],
    // Meta's feed serves everything from 4:5 portrait to 1.91:1 landscape.
    aspectRatio: { min: 0.8, max: 1.91, recommended: 1 },
    minWidth: 600,
    minHeight: 600,
    maxFileSize: IMAGE_MB,
    allowedMimeTypes: IMAGE_MIME,
    sourceUrl: META_DOCS,
    verifiedAt: VERIFIED,
  },
  {
    key: 'FACEBOOK_FEED_VIDEO',
    platform: Platform.FACEBOOK,
    label: 'Facebook Feed (video)',
    surface: 'FEED',
    creativeTypes: ['VIDEO'],
    aspectRatio: { min: 0.5625, max: 1.91, recommended: 1 },
    minWidth: 600,
    minHeight: 600,
    maxFileSize: VIDEO_MB,
    allowedMimeTypes: VIDEO_MIME,
    minDuration: 1,
    maxDuration: 241 * 60,
    sourceUrl: META_DOCS,
    verifiedAt: VERIFIED,
  },
  {
    key: 'FACEBOOK_STORY',
    platform: Platform.FACEBOOK,
    label: 'Facebook Story',
    surface: 'STORY',
    creativeTypes: ['IMAGE', 'VIDEO'],
    // Vertical placements are strict: 9:16 with very little tolerance.
    aspectRatio: { min: 0.5, max: 0.6, recommended: 0.5625 },
    minWidth: 500,
    minHeight: 889,
    maxFileSize: VIDEO_MB,
    allowedMimeTypes: [...IMAGE_MIME, ...VIDEO_MIME],
    minDuration: 1,
    maxDuration: 120,
    sourceUrl: META_DOCS,
    verifiedAt: VERIFIED,
  },
  {
    key: 'INSTAGRAM_FEED_IMAGE',
    platform: Platform.INSTAGRAM,
    label: 'Instagram Feed',
    surface: 'FEED',
    creativeTypes: ['IMAGE'],
    aspectRatio: { min: 0.8, max: 1.91, recommended: 0.8 },
    minWidth: 600,
    minHeight: 600,
    maxFileSize: IMAGE_MB,
    allowedMimeTypes: IMAGE_MIME,
    sourceUrl: META_DOCS,
    verifiedAt: VERIFIED,
  },
  {
    key: 'INSTAGRAM_STORY',
    platform: Platform.INSTAGRAM,
    label: 'Instagram Story',
    surface: 'STORY',
    creativeTypes: ['IMAGE', 'VIDEO'],
    aspectRatio: { min: 0.5, max: 0.6, recommended: 0.5625 },
    minWidth: 500,
    minHeight: 889,
    maxFileSize: VIDEO_MB,
    allowedMimeTypes: [...IMAGE_MIME, ...VIDEO_MIME],
    minDuration: 1,
    maxDuration: 120,
    sourceUrl: META_DOCS,
    verifiedAt: VERIFIED,
  },
  {
    key: 'INSTAGRAM_REEL',
    platform: Platform.INSTAGRAM,
    label: 'Instagram Reel',
    surface: 'REEL',
    creativeTypes: ['VIDEO'],
    aspectRatio: { min: 0.5, max: 0.6, recommended: 0.5625 },
    minWidth: 500,
    minHeight: 889,
    maxFileSize: VIDEO_MB,
    allowedMimeTypes: VIDEO_MIME,
    minDuration: 1,
    maxDuration: 900,
    sourceUrl: META_DOCS,
    verifiedAt: VERIFIED,
  },
  // ---------------------------------------------------------------- TikTok
  {
    key: 'TIKTOK_IN_FEED',
    platform: Platform.TIKTOK,
    label: 'TikTok In-Feed',
    surface: 'FEED',
    creativeTypes: ['VIDEO'],
    aspectRatio: { min: 0.5, max: 1.78, recommended: 0.5625 },
    minWidth: 540,
    minHeight: 960,
    maxFileSize: 500 * 1024 * 1024,
    allowedMimeTypes: VIDEO_MIME,
    minDuration: 5,
    maxDuration: 60,
    sourceUrl: TIKTOK_DOCS,
    verifiedAt: VERIFIED,
  },
];

export function specsFor(platform?: Platform): PlacementSpec[] {
  return platform ? PLACEMENT_SPECS.filter((spec) => spec.platform === platform) : PLACEMENT_SPECS;
}

export const specByKey = (key: string): PlacementSpec | undefined =>
  PLACEMENT_SPECS.find((spec) => spec.key === key);

// ---------------------------------------------------------------- validation

/**
 * Three outcomes, not two.
 *
 * UNKNOWN is the one that matters. A video on a deployment without FFmpeg has
 * no measured duration, and answering VALID would be a guess presented as a
 * check while INVALID would reject a file that is probably fine. Saying "not
 * measured, here is why" is the only honest answer.
 */
export type CheckOutcome = 'VALID' | 'INVALID' | 'UNKNOWN';

export interface PlacementCheck {
  key: string;
  label: string;
  outcome: CheckOutcome;
  /** What was measured, in the operator's terms. */
  actual: string;
  /** What this placement needs. */
  required: string;
  reason: string;
}

export interface PlacementValidation {
  placement: string;
  platform: Platform;
  label: string;
  surface: string;
  outcome: CheckOutcome;
  checks: PlacementCheck[];
  /** Set only when the creative cannot run here at all. */
  blockingReason: string | null;
  sourceUrl: string;
  verifiedAt: string;
}

export interface ValidationInput {
  kind: 'IMAGE' | 'VIDEO';
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  aspectRatio: number | null;
  durationSeconds: number | null;
  measured: boolean;
}

const ratioLabel = (ratio: number): string => {
  // The named ratios an operator actually recognises.
  const known: Array<[number, string]> = [
    [1, '1:1'], [0.8, '4:5'], [0.5625, '9:16'], [1.7778, '16:9'], [1.91, '1.91:1'], [1.3333, '4:3'], [0.75, '3:4'],
  ];
  const match = known.find(([value]) => Math.abs(value - ratio) < 0.02);
  return match ? match[1] : `${ratio.toFixed(2)}:1`;
};

const mb = (bytes: number): string =>
  bytes >= 1024 * 1024 * 1024 ? `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * Check one creative against one placement.
 *
 * Every check reports what was measured *and* what was required, because
 * "invalid" on its own tells the operator nothing they can act on — the whole
 * point is that they go back to Canva knowing the file needs to be 9:16.
 */
export function validateForPlacement(input: ValidationInput, spec: PlacementSpec): PlacementValidation {
  const checks: PlacementCheck[] = [];

  // --- media type -------------------------------------------------------
  const typeOk = spec.creativeTypes.includes(input.kind);
  checks.push({
    key: 'type',
    label: 'Media type',
    outcome: typeOk ? 'VALID' : 'INVALID',
    actual: input.kind.toLowerCase(),
    required: spec.creativeTypes.join(' or ').toLowerCase(),
    reason: typeOk
      ? `This placement takes ${spec.creativeTypes.join(' and ').toLowerCase()}.`
      : `This placement does not run ${input.kind.toLowerCase()} creatives.`,
  });

  // --- format -----------------------------------------------------------
  const mimeOk = spec.allowedMimeTypes.includes(input.mimeType);
  checks.push({
    key: 'format',
    label: 'File format',
    outcome: mimeOk ? 'VALID' : 'INVALID',
    actual: input.mimeType,
    required: spec.allowedMimeTypes.join(', '),
    reason: mimeOk ? 'Accepted format.' : `${input.mimeType} is not accepted here.`,
  });

  // --- size -------------------------------------------------------------
  const sizeOk = input.sizeBytes <= spec.maxFileSize;
  checks.push({
    key: 'fileSize',
    label: 'File size',
    outcome: sizeOk ? 'VALID' : 'INVALID',
    actual: mb(input.sizeBytes),
    required: `up to ${mb(spec.maxFileSize)}`,
    reason: sizeOk ? 'Within the size limit.' : `The file is ${mb(input.sizeBytes)}; the limit is ${mb(spec.maxFileSize)}.`,
  });

  // --- dimensions -------------------------------------------------------
  if (input.width && input.height) {
    const dimensionsOk = input.width >= spec.minWidth && input.height >= spec.minHeight;
    checks.push({
      key: 'dimensions',
      label: 'Dimensions',
      outcome: dimensionsOk ? 'VALID' : 'INVALID',
      actual: `${input.width} × ${input.height}`,
      required: `at least ${spec.minWidth} × ${spec.minHeight}`,
      reason: dimensionsOk
        ? 'Large enough for this placement.'
        : `Too small: this placement needs at least ${spec.minWidth} × ${spec.minHeight}.`,
    });
  } else {
    checks.push({
      key: 'dimensions',
      label: 'Dimensions',
      outcome: 'UNKNOWN',
      actual: 'not measured',
      required: `at least ${spec.minWidth} × ${spec.minHeight}`,
      reason: 'The dimensions of this file could not be measured on this deployment.',
    });
  }

  // --- aspect ratio -----------------------------------------------------
  if (input.aspectRatio) {
    const ratioOk = input.aspectRatio >= spec.aspectRatio.min && input.aspectRatio <= spec.aspectRatio.max;
    checks.push({
      key: 'aspectRatio',
      label: 'Aspect ratio',
      outcome: ratioOk ? 'VALID' : 'INVALID',
      actual: ratioLabel(input.aspectRatio),
      // Leads with the shape someone would type into Canva; the window is the
      // detail behind it. "0.50:1 to 0.60:1" is accurate and unusable.
      required: `${ratioLabel(spec.aspectRatio.recommended)} (${ratioLabel(spec.aspectRatio.min)} to ${ratioLabel(spec.aspectRatio.max)})`,
      reason: ratioOk
        ? `Within range; ${ratioLabel(spec.aspectRatio.recommended)} is the recommended shape.`
        : `This creative is ${ratioLabel(input.aspectRatio)}. This placement needs ` +
          `${ratioLabel(spec.aspectRatio.recommended)} — anything from ` +
          `${ratioLabel(spec.aspectRatio.min)} to ${ratioLabel(spec.aspectRatio.max)}.`,
    });
  } else {
    checks.push({
      key: 'aspectRatio',
      label: 'Aspect ratio',
      outcome: 'UNKNOWN',
      actual: 'not measured',
      required: `${ratioLabel(spec.aspectRatio.recommended)} (${ratioLabel(spec.aspectRatio.min)} to ${ratioLabel(spec.aspectRatio.max)})`,
      reason: 'The shape of this file could not be measured on this deployment.',
    });
  }

  // --- duration ---------------------------------------------------------
  if (input.kind === 'VIDEO' && (spec.minDuration || spec.maxDuration)) {
    if (input.durationSeconds) {
      const min = spec.minDuration ?? 0;
      const max = spec.maxDuration ?? Number.POSITIVE_INFINITY;
      const durationOk = input.durationSeconds >= min && input.durationSeconds <= max;
      checks.push({
        key: 'duration',
        label: 'Duration',
        outcome: durationOk ? 'VALID' : 'INVALID',
        actual: `${input.durationSeconds.toFixed(1)}s`,
        required: `${min}s to ${max === Number.POSITIVE_INFINITY ? 'no limit' : `${max}s`}`,
        reason: durationOk
          ? 'Within the allowed length.'
          : input.durationSeconds < min
            ? `Too short: this placement needs at least ${min}s.`
            : `Too long: this placement allows up to ${max}s.`,
      });
    } else {
      checks.push({
        key: 'duration',
        label: 'Duration',
        outcome: 'UNKNOWN',
        actual: 'not measured',
        required: `${spec.minDuration ?? 0}s to ${spec.maxDuration ?? 'no limit'}`,
        reason: input.measured
          ? 'This file reported no duration.'
          : 'Duration could not be measured: FFmpeg is not available on this deployment.',
      });
    }
  }

  const invalid = checks.filter((check) => check.outcome === 'INVALID');
  const unknown = checks.filter((check) => check.outcome === 'UNKNOWN');

  return {
    placement: spec.key,
    platform: spec.platform,
    label: spec.label,
    surface: spec.surface,
    // An unmeasured check never upgrades to valid; it holds the whole placement
    // at UNKNOWN so nobody reads a tick that was never earned.
    outcome: invalid.length > 0 ? 'INVALID' : unknown.length > 0 ? 'UNKNOWN' : 'VALID',
    blockingReason: invalid.length > 0 ? invalid.map((check) => check.reason).join(' ') : null,
    checks,
    sourceUrl: spec.sourceUrl,
    verifiedAt: spec.verifiedAt,
  };
}

export interface ValidationSummary {
  valid: number;
  invalid: number;
  unknown: number;
  placements: PlacementValidation[];
}

/** The whole matrix: one row per placement, in the order the specs are declared. */
export function validateCreative(input: ValidationInput, platform?: Platform): ValidationSummary {
  const placements = specsFor(platform).map((spec) => validateForPlacement(input, spec));

  return {
    valid: placements.filter((row) => row.outcome === 'VALID').length,
    invalid: placements.filter((row) => row.outcome === 'INVALID').length,
    unknown: placements.filter((row) => row.outcome === 'UNKNOWN').length,
    placements,
  };
}

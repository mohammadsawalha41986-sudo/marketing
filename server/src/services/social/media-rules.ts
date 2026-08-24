/**
 * Whether a file can actually be published where the operator is pointing it.
 *
 * The failure this prevents is the expensive one: a Reel scheduled with a
 * landscape video, discovered at 7pm on a Saturday when Meta refuses it. Every
 * rule here is checkable from what we already store — type, size, dimensions,
 * duration — so the answer is available in the composer rather than at the
 * moment of publication.
 *
 * The limits are the platforms' own published constraints. They move, and a
 * value here going stale shows up as a warning on a file the platform would
 * have accepted, which is the safe direction: the check never blocks
 * publication, it only tells the operator what is likely to happen. The
 * provider remains the authority on whether a post is accepted.
 */

import { MediaType, Platform } from '@prisma/client';

export type Compatibility = 'OK' | 'WARNING' | 'INCOMPATIBLE';

export interface MediaFinding {
  level: Compatibility;
  message: string;
}

export interface MediaFacts {
  type: MediaType;
  mimeType: string;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
  durationSeconds?: number | null;
}

interface PlatformRule {
  label: string;
  /** What the platform will actually take. */
  images: string[];
  videos: string[];
  maxImageBytes: number;
  maxVideoBytes: number;
  /** Aspect ratio as width/height, with the tolerance the platform allows. */
  ratio?: { min: number; max: number; recommended: string };
  maxDurationSeconds?: number;
  minDurationSeconds?: number;
  /** Some surfaces cannot take a still at all. */
  requiresVideo?: boolean;
}

const IMAGE = ['image/jpeg', 'image/png'];
const VIDEO = ['video/mp4', 'video/quicktime'];

/**
 * Rules per platform *and surface*, because they genuinely differ: an Instagram
 * feed post and an Instagram Reel disagree about orientation, and treating them
 * as one platform is how a vertical video ends up cropped square.
 */
const RULES: Record<string, PlatformRule> = {
  'FACEBOOK:FEED': {
    label: 'Facebook feed',
    images: IMAGE, videos: VIDEO,
    maxImageBytes: 30 * 1024 * 1024,
    maxVideoBytes: 4 * 1024 * 1024 * 1024,
    maxDurationSeconds: 240 * 60,
  },
  'INSTAGRAM:FEED': {
    label: 'Instagram feed',
    images: IMAGE, videos: VIDEO,
    maxImageBytes: 8 * 1024 * 1024,
    maxVideoBytes: 1024 * 1024 * 1024,
    // 4:5 portrait through 1.91:1 landscape.
    ratio: { min: 0.8, max: 1.91, recommended: '4:5 or 1:1' },
    maxDurationSeconds: 60 * 15,
  },
  'INSTAGRAM:CAROUSEL': {
    label: 'Instagram carousel',
    images: IMAGE, videos: VIDEO,
    maxImageBytes: 8 * 1024 * 1024,
    maxVideoBytes: 1024 * 1024 * 1024,
    ratio: { min: 0.8, max: 1.91, recommended: '1:1' },
  },
  'INSTAGRAM:REEL': {
    label: 'Instagram Reel',
    images: [], videos: VIDEO,
    maxImageBytes: 0,
    maxVideoBytes: 1024 * 1024 * 1024,
    ratio: { min: 0.5, max: 0.62, recommended: '9:16' },
    minDurationSeconds: 3,
    maxDurationSeconds: 90,
    requiresVideo: true,
  },
  'TIKTOK:VIDEO': {
    label: 'TikTok',
    images: [], videos: VIDEO,
    maxImageBytes: 0,
    maxVideoBytes: 4 * 1024 * 1024 * 1024,
    ratio: { min: 0.5, max: 0.62, recommended: '9:16' },
    minDurationSeconds: 3,
    maxDurationSeconds: 600,
    requiresVideo: true,
  },
  'YOUTUBE:VIDEO': {
    label: 'YouTube',
    images: IMAGE, videos: VIDEO,
    maxImageBytes: 2 * 1024 * 1024,
    maxVideoBytes: 128 * 1024 * 1024 * 1024,
    ratio: { min: 1.6, max: 1.85, recommended: '16:9' },
    requiresVideo: true,
  },
  'LINKEDIN:FEED': {
    label: 'LinkedIn',
    images: IMAGE, videos: VIDEO,
    maxImageBytes: 10 * 1024 * 1024,
    maxVideoBytes: 5 * 1024 * 1024 * 1024,
    maxDurationSeconds: 60 * 10,
  },
  'GOOGLE_BUSINESS:UPDATE': {
    label: 'Google Business',
    images: IMAGE, videos: [],
    maxImageBytes: 5 * 1024 * 1024,
    maxVideoBytes: 0,
  },
};

/** Falls back to the platform's default surface when none is named. */
const DEFAULT_SURFACE: Partial<Record<Platform, string>> = {
  FACEBOOK: 'FEED',
  INSTAGRAM: 'FEED',
  TIKTOK: 'VIDEO',
  YOUTUBE: 'VIDEO',
  LINKEDIN: 'FEED',
  GOOGLE_BUSINESS: 'UPDATE',
};

export function ruleFor(platform: Platform, surface?: string): PlatformRule | null {
  const key = `${platform}:${(surface ?? DEFAULT_SURFACE[platform] ?? 'FEED').toUpperCase()}`;
  return RULES[key] ?? RULES[`${platform}:${DEFAULT_SURFACE[platform] ?? 'FEED'}`] ?? null;
}

const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))}MB`;

/**
 * Check one file against one destination.
 *
 * Returns findings rather than a boolean: "this will be cropped" and "this
 * cannot be uploaded" need different words and different consequences, and
 * collapsing them into `false` loses the distinction the operator acts on.
 */
export function validateMediaForPlatform(
  media: MediaFacts,
  platform: Platform,
  surface?: string,
): MediaFinding[] {
  const rule = ruleFor(platform, surface);
  if (!rule) {
    return [{ level: 'WARNING', message: `No media rules are known for ${platform} yet.` }];
  }

  const findings: MediaFinding[] = [];
  const isVideo = media.type === MediaType.VIDEO;
  const allowed = isVideo ? rule.videos : rule.images;

  if (allowed.length === 0) {
    findings.push({
      level: 'INCOMPATIBLE',
      message: isVideo
        ? `${rule.label} does not accept video.`
        : `${rule.label} needs a video, not a still image.`,
    });
    return findings;
  }

  if (!allowed.includes(media.mimeType)) {
    findings.push({
      level: 'INCOMPATIBLE',
      message: `${rule.label} does not accept ${media.mimeType}. Use ${allowed.join(' or ')}.`,
    });
  }

  const maxBytes = isVideo ? rule.maxVideoBytes : rule.maxImageBytes;
  if (media.sizeBytes > maxBytes) {
    findings.push({
      level: 'INCOMPATIBLE',
      message: `The file is ${mb(media.sizeBytes)}; ${rule.label} allows up to ${mb(maxBytes)}.`,
    });
  }

  if (rule.requiresVideo && !isVideo) {
    findings.push({ level: 'INCOMPATIBLE', message: `${rule.label} requires a video.` });
  }

  // Aspect ratio is a warning, not a refusal: the platform will accept it and
  // crop, and an operator may well want that.
  if (rule.ratio && media.width && media.height) {
    const ratio = media.width / media.height;
    if (ratio < rule.ratio.min || ratio > rule.ratio.max) {
      findings.push({
        level: 'WARNING',
        message:
          `This is ${ratio.toFixed(2)}:1. ${rule.label} shows ${rule.ratio.recommended}, ` +
          'so it will be cropped.',
      });
    }
  }

  if (media.durationSeconds != null) {
    if (rule.maxDurationSeconds && media.durationSeconds > rule.maxDurationSeconds) {
      findings.push({
        level: 'INCOMPATIBLE',
        message:
          `The video is ${Math.round(media.durationSeconds)}s; ${rule.label} allows up to ` +
          `${rule.maxDurationSeconds}s.`,
      });
    }
    if (rule.minDurationSeconds && media.durationSeconds < rule.minDurationSeconds) {
      findings.push({
        level: 'INCOMPATIBLE',
        message: `The video is ${Math.round(media.durationSeconds)}s; ${rule.label} needs at least ${rule.minDurationSeconds}s.`,
      });
    }
  }

  return findings;
}

/** The worst level across a set of findings — what a badge should show. */
export function overall(findings: MediaFinding[]): Compatibility {
  if (findings.some((finding) => finding.level === 'INCOMPATIBLE')) return 'INCOMPATIBLE';
  if (findings.some((finding) => finding.level === 'WARNING')) return 'WARNING';
  return 'OK';
}

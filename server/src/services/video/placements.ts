/**
 * Video placements.
 *
 * Deliberately a separate registry from the image one rather than an edit to
 * it. The image placement registry is verified and in production, and video
 * needs entries it does not have — a 1920×1080 landscape for YouTube — while
 * not needing most of what it does. Extending by addition keeps the verified
 * table untouched, and both use the same `CreativePreset` shape so the adaptive
 * composition engine works on either without knowing the difference.
 *
 * Safe areas are wider than the image equivalents on purpose. A Reel or TikTok
 * frame carries the caption, the profile row, the sound name and a column of
 * interaction buttons over the picture, and unlike a static post the viewer
 * cannot scroll it out of the way — burned-in copy that survives on a feed image
 * ends up underneath the UI in a vertical video.
 */

import { Platform } from '@prisma/client';

import type { CreativePreset } from '../creative/presets.js';

export interface VideoPlacement extends CreativePreset {
  /** Default length in seconds; the operator can change it. */
  defaultDurationSeconds: number;
}

export const VIDEO_PLACEMENTS: VideoPlacement[] = [
  {
    key: 'TIKTOK_VIDEO',
    platform: Platform.TIKTOK,
    label: 'TikTok',
    width: 1080,
    height: 1920,
    // TikTok's own UI covers roughly the bottom fifth and the top tenth.
    safeArea: { top: 0.10, bottom: 0.20 },
    defaultDurationSeconds: 15,
  },
  {
    key: 'INSTAGRAM_REEL',
    platform: Platform.INSTAGRAM,
    label: 'Instagram Reel',
    width: 1080,
    height: 1920,
    safeArea: { top: 0.10, bottom: 0.20 },
    defaultDurationSeconds: 15,
  },
  {
    key: 'INSTAGRAM_STORY_VIDEO',
    platform: Platform.INSTAGRAM,
    label: 'Instagram Story',
    width: 1080,
    height: 1920,
    // Stories put the profile row at the very top and the reply bar at the very
    // bottom, but nothing down the right edge, so less is lost than a Reel.
    safeArea: { top: 0.14, bottom: 0.16 },
    defaultDurationSeconds: 15,
  },
  {
    key: 'INSTAGRAM_FEED_VIDEO',
    platform: Platform.INSTAGRAM,
    label: 'Instagram Feed video',
    width: 1080,
    height: 1350,
    safeArea: { top: 0.06, bottom: 0.10 },
    defaultDurationSeconds: 20,
  },
  {
    key: 'FACEBOOK_FEED_VIDEO',
    platform: Platform.FACEBOOK,
    label: 'Facebook Feed video',
    width: 1080,
    height: 1350,
    safeArea: { top: 0.06, bottom: 0.12 },
    defaultDurationSeconds: 20,
  },
  {
    key: 'SNAPCHAT_VIDEO',
    platform: Platform.SNAPCHAT,
    label: 'Snapchat',
    width: 1080,
    height: 1920,
    safeArea: { top: 0.12, bottom: 0.18 },
    defaultDurationSeconds: 12,
  },
  {
    key: 'YOUTUBE_LANDSCAPE',
    platform: Platform.GOOGLE_ADS,
    label: 'YouTube / landscape',
    width: 1920,
    height: 1080,
    safeArea: { top: 0.06, bottom: 0.12 },
    defaultDurationSeconds: 20,
  },
];

export function videoPlacementByKey(key: string): VideoPlacement | undefined {
  return VIDEO_PLACEMENTS.find((placement) => placement.key === key);
}

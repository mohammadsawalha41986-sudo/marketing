/**
 * Platform creative presets.
 *
 * One entry per place a post actually lands, with the pixel size that platform
 * serves. These are the dimensions the rendered file is produced at, so they
 * are the difference between an operator uploading artwork and an operator
 * being told their image is the wrong shape.
 *
 * `safeArea` is the fraction of the frame kept clear of burned-in text. Vertical
 * placements need it most: TikTok and Stories put their own UI over roughly the
 * bottom fifth and top tenth of the frame, so a headline centred by pixel
 * arithmetic alone ends up underneath the caption bar.
 */

import { Platform } from '@prisma/client';

export interface CreativePreset {
  key: string;
  platform: Platform;
  label: string;
  width: number;
  height: number;
  /** Fractions of height reserved at top and bottom for platform chrome. */
  safeArea: { top: number; bottom: number };
}

export const PRESETS: CreativePreset[] = [
  {
    key: 'INSTAGRAM_PORTRAIT',
    platform: Platform.INSTAGRAM,
    label: 'Instagram portrait',
    width: 1080,
    height: 1350,
    safeArea: { top: 0.06, bottom: 0.08 },
  },
  {
    key: 'INSTAGRAM_SQUARE',
    platform: Platform.INSTAGRAM,
    label: 'Instagram square',
    width: 1080,
    height: 1080,
    safeArea: { top: 0.06, bottom: 0.08 },
  },
  {
    key: 'INSTAGRAM_STORY',
    platform: Platform.INSTAGRAM,
    label: 'Instagram story',
    width: 1080,
    height: 1920,
    safeArea: { top: 0.14, bottom: 0.18 },
  },
  {
    key: 'FACEBOOK_FEED',
    platform: Platform.FACEBOOK,
    label: 'Facebook feed',
    width: 1200,
    height: 1200,
    safeArea: { top: 0.05, bottom: 0.05 },
  },
  {
    key: 'TIKTOK_VERTICAL',
    platform: Platform.TIKTOK,
    label: 'TikTok',
    width: 1080,
    height: 1920,
    // TikTok's own UI is the heaviest of any placement here.
    safeArea: { top: 0.12, bottom: 0.22 },
  },
  {
    key: 'SNAPCHAT_VERTICAL',
    platform: Platform.SNAPCHAT,
    label: 'Snapchat',
    width: 1080,
    height: 1920,
    safeArea: { top: 0.12, bottom: 0.2 },
  },
  {
    key: 'LINKEDIN_FEED',
    platform: Platform.LINKEDIN,
    label: 'LinkedIn feed',
    width: 1200,
    height: 1200,
    safeArea: { top: 0.05, bottom: 0.05 },
  },
  {
    key: 'X_LANDSCAPE',
    platform: Platform.X,
    label: 'X landscape',
    width: 1600,
    height: 900,
    safeArea: { top: 0.06, bottom: 0.06 },
  },
  {
    key: 'GOOGLE_ADS_LANDSCAPE',
    platform: Platform.GOOGLE_ADS,
    label: 'Google Ads landscape',
    width: 1200,
    height: 628,
    safeArea: { top: 0.06, bottom: 0.06 },
  },
  {
    key: 'GOOGLE_BUSINESS_POST',
    platform: Platform.GOOGLE_BUSINESS,
    label: 'Google Business post',
    width: 1200,
    height: 900,
    safeArea: { top: 0.05, bottom: 0.05 },
  },
];

const BY_KEY = new Map(PRESETS.map((preset) => [preset.key, preset]));

export function presetByKey(key: string): CreativePreset | undefined {
  return BY_KEY.get(key);
}

/** The default preset for a platform — the first one listed for it. */
export function defaultPresetFor(platform: Platform): CreativePreset {
  const preset = PRESETS.find((entry) => entry.platform === platform);
  // Every Platform value has an entry above; the fallback keeps the type total
  // if a new platform is added to the enum before a preset is written for it.
  return preset ?? PRESETS[0]!;
}

export function presetsFor(platform: Platform): CreativePreset[] {
  return PRESETS.filter((entry) => entry.platform === platform);
}

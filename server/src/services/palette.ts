/**
 * Brand identity extraction from an uploaded logo.
 *
 * The logo is downsampled, its pixels bucketed into a coarse colour histogram,
 * and the buckets ranked by a score that rewards both frequency and chroma — a
 * logo is usually mostly background, so raw frequency alone returns white.
 *
 * Everything here is a *suggestion*. Nothing is written to the brand until an
 * admin approves it, which is why the result lands in `Brand.suggestedPalette`
 * rather than in the live colour fields.
 */

import sharp from 'sharp';

export interface Swatch {
  hex: string;
  /** Share of non-transparent pixels, 0–1. */
  weight: number;
  hsl: { h: number; s: number; l: number };
}

export interface SuggestedPalette {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  text: string;
  fontFamily: string;
  visualStyle: string;
  swatches: Swatch[];
  /** Contrast of `text` on `background`, for the reviewer to sanity-check. */
  contrast: number;
  notes: string[];
}

// ------------------------------------------------------------------ colour maths

export function rgbToHex(r: number, g: number, b: number): string {
  const part = (value: number) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`.toUpperCase();
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;

  if (d === 0) return { h: 0, s: 0, l };

  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;

  return { h: h * 360, s, l };
}

export function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const hue = ((h % 360) + 360) % 360;
  if (s === 0) {
    const value = l * 255;
    return { r: value, g: value, b: value };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  const channel = (t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };

  const hk = hue / 360;
  return { r: channel(hk + 1 / 3) * 255, g: channel(hk) * 255, b: channel(hk - 1 / 3) * 255 };
}

export function hslToHex(h: number, s: number, l: number): string {
  const { r, g, b } = hslToRgb(h, s, l);
  return rgbToHex(r, g, b);
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const channel = (value: number) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two hex colours, 1–21. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [light, dark] = la > lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

/** Black or white, whichever is more readable on the given background. */
export function readableTextOn(background: string): string {
  return contrastRatio('#FFFFFF', background) >= contrastRatio('#0B0F1A', background) ? '#FFFFFF' : '#0B0F1A';
}

export const isValidHex = (value: string): boolean => /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);

// ------------------------------------------------------------------ extraction

const BUCKET = 24; // coarse enough that anti-aliased edges collapse into one entry

interface Bucket {
  r: number;
  g: number;
  b: number;
  count: number;
}

/**
 * Rank buckets by frequency weighted towards saturated, mid-lightness colours.
 * Without the chroma term, almost every logo returns white or near-black.
 */
function score(bucket: Bucket, total: number): number {
  const { s, l } = rgbToHsl(bucket.r, bucket.g, bucket.b);
  const frequency = bucket.count / total;
  const chroma = 0.25 + s * 1.75;
  // Penalise the extremes of lightness, which are usually background or outline.
  const midness = 1 - Math.abs(l - 0.5) * 1.3;
  return frequency * chroma * Math.max(midness, 0.12);
}

export async function extractPalette(image: Buffer): Promise<SuggestedPalette> {
  const { data, info } = await sharp(image)
    .resize(96, 96, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const buckets = new Map<string, Bucket>();
  let counted = 0;

  for (let i = 0; i + 3 < data.length; i += info.channels) {
    const alpha = data[i + 3] ?? 255;
    if (alpha < 128) continue; // transparent padding carries no brand information

    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;

    const key = `${Math.round(r / BUCKET)}-${Math.round(g / BUCKET)}-${Math.round(b / BUCKET)}`;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      bucket.count += 1;
    } else {
      buckets.set(key, { r, g, b, count: 1 });
    }
    counted += 1;
  }

  const notes: string[] = [];
  if (counted === 0) {
    notes.push('The image was fully transparent, so the default palette was kept.');
    return { ...defaultPalette(), notes };
  }

  const ranked = [...buckets.values()]
    .map((bucket) => ({
      hex: rgbToHex(bucket.r / bucket.count, bucket.g / bucket.count, bucket.b / bucket.count),
      weight: bucket.count / counted,
      rank: score(bucket, counted),
    }))
    .sort((a, b) => b.rank - a.rank);

  const swatches: Swatch[] = ranked.slice(0, 8).map((entry) => {
    const { r, g, b } = hexToRgb(entry.hex);
    return { hex: entry.hex, weight: Number(entry.weight.toFixed(4)), hsl: rgbToHsl(r, g, b) };
  });

  const primary = swatches[0]?.hex ?? '#6366F1';
  const primaryHsl = rgbToHsl(hexToRgb(primary).r, hexToRgb(primary).g, hexToRgb(primary).b);

  // Prefer a genuinely different second colour; fall back to a hue rotation.
  const distinct = swatches.slice(1).find((swatch) => hueDistance(swatch.hsl.h, primaryHsl.h) > 25);
  const secondary = distinct?.hex ?? hslToHex(primaryHsl.h + 28, clamp(primaryHsl.s * 0.92, 0.25, 0.9), clamp(primaryHsl.l * 1.05, 0.35, 0.7));

  const accentSource = swatches.slice(1).find((swatch) => swatch.hsl.s > 0.45 && swatch.hex !== secondary);
  const accent = accentSource?.hex ?? hslToHex(primaryHsl.h + 165, clamp(primaryHsl.s, 0.45, 0.85), 0.58);

  // Dark surface tinted with the brand hue, so the UI reads as the client's.
  const background = hslToHex(primaryHsl.h, clamp(primaryHsl.s * 0.32, 0.05, 0.28), 0.07);
  const text = readableTextOn(background);
  const contrast = contrastRatio(text, background);

  if (swatches.length < 2) notes.push('Only one dominant colour was found; the secondary and accent are derived from it.');
  if (primaryHsl.s < 0.12) notes.push('The logo is close to greyscale, so the suggested accents are synthesised rather than sampled.');
  if (contrast < 4.5) notes.push(`Text contrast is ${contrast.toFixed(1)}:1, below the 4.5:1 WCAG AA minimum. Adjust before approving.`);

  return {
    primary,
    secondary,
    accent,
    background,
    text,
    fontFamily: suggestFont(primaryHsl.s, swatches.length),
    visualStyle: suggestStyle(primaryHsl.s, primaryHsl.l, swatches.length),
    swatches,
    contrast: Number(contrast.toFixed(2)),
    notes,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function hueDistance(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/**
 * A heuristic, not a claim about the typeface in the logo — we cannot read the
 * glyphs. It maps colour character onto a curated shortlist the user can change.
 */
function suggestFont(saturation: number, swatchCount: number): string {
  if (saturation < 0.15) return 'Inter';
  if (saturation > 0.7 && swatchCount >= 4) return 'Poppins';
  if (saturation > 0.55) return 'Manrope';
  return 'Plus Jakarta Sans';
}

function suggestStyle(saturation: number, lightness: number, swatchCount: number): string {
  if (saturation < 0.15) return 'Minimal monochrome';
  if (swatchCount >= 5 && saturation > 0.6) return 'Vivid and playful';
  if (lightness < 0.35) return 'Deep and premium';
  if (saturation > 0.5) return 'Bold and confident';
  return 'Modern and restrained';
}

export function defaultPalette(): SuggestedPalette {
  return {
    primary: '#6366F1',
    secondary: '#8B5CF6',
    accent: '#22D3EE',
    background: '#0B0F1A',
    text: '#E8EBF2',
    fontFamily: 'Inter',
    visualStyle: 'Modern and restrained',
    swatches: [],
    contrast: Number(contrastRatio('#E8EBF2', '#0B0F1A').toFixed(2)),
    notes: [],
  };
}

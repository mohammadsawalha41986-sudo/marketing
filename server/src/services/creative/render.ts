/**
 * Renders the finished post creative.
 *
 * This is the piece that makes "Download" mean something. The source photograph
 * is only the background: what comes out of here is the artwork an operator
 * would actually publish — cropped to the platform's own dimensions, with the
 * headline, brand treatment and CTA burned in. Handing back the uploaded file
 * instead would be a download button that quietly does nothing useful.
 *
 * Composition, bottom to top:
 *
 *   1. the source image, cover-cropped to the preset (never stretched — the
 *      brief is explicit, and a squashed plate of food is worse than a crop)
 *   2. a bottom-weighted scrim, so light text stays legible over a bright photo
 *   3. an SVG text layer inside the preset's safe area
 *
 * The text layer is SVG rather than canvas because sharp rasterises SVG
 * natively; adding a canvas dependency to draw two strings would be a native
 * build for no benefit.
 */

import sharp from 'sharp';
import { CreativeFormat } from '@prisma/client';

import { analyzeSource, type CreativeAnalysis } from './analyze.js';
import { composeBase, planComposition, type Composition } from './compose.js';
import type { CreativePreset } from './presets.js';

export interface BrandTreatment {
  name: string;
  primaryColor: string;
  accentColor: string;
  textColor: string;
  logoUrl?: string | null;
}

export interface RenderInput {
  source: Buffer;
  preset: CreativePreset;
  brand: BrandTreatment;
  headline?: string | null;
  ctaLabel?: string | null;
  format: CreativeFormat;
}

export interface RenderedCreative {
  buffer: Buffer;
  width: number;
  height: number;
  format: CreativeFormat;
  mimeType: string;
  extension: string;
  /** How the frame was built, so the UI can explain the result. */
  composition: Composition;
  analysis: CreativeAnalysis;
}

/** XML-escape. Copy is operator-supplied, so it cannot be trusted into markup. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Accept only `#rgb`/`#rrggbb`; anything else falls back rather than reaching the SVG. */
function safeColor(value: string | undefined | null, fallback: string): string {
  return value && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value) ? value : fallback;
}

/**
 * Greedy word wrap.
 *
 * SVG has no automatic wrapping, so the line breaks have to be decided here.
 * Width is estimated from the font size because measuring text properly would
 * mean loading the font — an approximation that is a little conservative is the
 * right trade: it can waste a few pixels of line length, but it will not push a
 * headline off the edge of a paid ad.
 */
function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = word;
    if (lines.length === maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);

  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    const last = lines[maxLines - 1] ?? '';
    lines[maxLines - 1] = `${last.replace(/[\s.,;:]+$/, '')}…`;
  }
  return lines;
}

export function overlaySvg(input: {
  preset: CreativePreset;
  brand: BrandTreatment;
  headline?: string | null;
  ctaLabel?: string | null;
}): string {
  const { preset, brand } = input;
  const { width, height } = preset;

  const primary = safeColor(brand.primaryColor, '#6366F1');
  const accent = safeColor(brand.accentColor, '#22D3EE');

  const padX = Math.round(width * 0.07);
  const bottomSafe = Math.round(height * preset.safeArea.bottom);

  // Type scales with the frame so a 628px banner and a 1920px story both look
  // deliberate rather than one being a scaled copy of the other.
  const headlineSize = Math.round(Math.min(width, height) * 0.075);
  const ctaSize = Math.round(Math.min(width, height) * 0.038);
  const brandSize = Math.round(Math.min(width, height) * 0.032);

  const headline = input.headline?.trim();
  const cta = input.ctaLabel?.trim();

  const maxChars = Math.max(12, Math.floor((width - padX * 2) / (headlineSize * 0.52)));
  const lines = headline ? wrap(headline, maxChars, 3) : [];

  const ctaHeight = Math.round(ctaSize * 2.4);
  const ctaWidth = cta ? Math.round(cta.length * ctaSize * 0.62 + ctaSize * 2.2) : 0;

  let cursor = height - bottomSafe;

  const ctaBlock = cta
    ? (() => {
        cursor -= ctaHeight;
        const y = cursor;
        cursor -= Math.round(ctaSize * 0.9);
        return `
    <rect x="${padX}" y="${y}" rx="${Math.round(ctaHeight / 2)}" width="${ctaWidth}" height="${ctaHeight}" fill="${accent}"/>
    <text x="${padX + ctaWidth / 2}" y="${y + ctaHeight / 2}" font-family="sans-serif" font-size="${ctaSize}"
          font-weight="700" fill="#0B0F1A" text-anchor="middle" dominant-baseline="central">${esc(cta)}</text>`;
      })()
    : '';

  const lineHeight = Math.round(headlineSize * 1.18);
  const headlineBlock = lines.length
    ? (() => {
        cursor -= lineHeight * lines.length;
        const top = cursor;
        cursor -= Math.round(headlineSize * 0.5);
        return lines
          .map(
            (line, index) =>
              `<text x="${padX}" y="${top + lineHeight * index + headlineSize}" font-family="sans-serif" ` +
              `font-size="${headlineSize}" font-weight="800" fill="#FFFFFF" ` +
              `letter-spacing="-0.5">${esc(line)}</text>`,
          )
          .join('\n    ');
      })()
    : '';

  // Brand strip above the copy: an accent rule plus the client's name, which is
  // what makes two clients' creatives from the same stock photo distinguishable.
  const brandY = Math.max(Math.round(height * preset.safeArea.top) + brandSize, cursor - brandSize);
  const ruleWidth = Math.round(width * 0.09);

  // The scrim is sized to the text it has to cover, not to a fixed fraction.
  const scrimTop = Math.max(0, Math.min(brandY - brandSize * 2, height));
  const scrimHeight = height - scrimTop;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="45%" stop-color="#000000" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.86"/>
    </linearGradient>
  </defs>
  <rect x="0" y="${scrimTop}" width="${width}" height="${scrimHeight}" fill="url(#scrim)"/>
  <rect x="0" y="${height - Math.round(height * 0.012)}" width="${width}" height="${Math.round(height * 0.012)}" fill="${primary}"/>
  <rect x="${padX}" y="${brandY - Math.round(brandSize * 0.55)}" width="${ruleWidth}" height="${Math.max(3, Math.round(brandSize * 0.16))}" rx="2" fill="${accent}"/>
  <text x="${padX + ruleWidth + Math.round(brandSize * 0.6)}" y="${brandY}" font-family="sans-serif" font-size="${brandSize}"
        font-weight="600" fill="#FFFFFF" opacity="0.92" letter-spacing="1.5">${esc(brand.name.toUpperCase())}</text>
    ${headlineBlock}
    ${ctaBlock}
</svg>`;
}

export async function renderCreative(input: RenderInput): Promise<RenderedCreative> {
  const { preset, format } = input;

  /*
   * Analyse, then decide how to build the frame. This is the step that makes a
   * vertical variant a different composition rather than a slice of the
   * horizontal one — see compose.ts for why a crop is the wrong tool once the
   * aspects diverge.
   */
  const analysis = await analyzeSource(input.source);
  const composition = planComposition(analysis, preset);
  const baseBuffer = await composeBase({ source: input.source, analysis, preset, composition });

  const svg = overlaySvg({
    preset,
    brand: input.brand,
    headline: input.headline,
    ctaLabel: input.ctaLabel,
  });

  const composed = sharp(baseBuffer).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]);

  const buffer =
    format === CreativeFormat.JPG
      ? await composed.jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer()
      : await composed.png({ compressionLevel: 9 }).toBuffer();

  return {
    buffer,
    width: preset.width,
    height: preset.height,
    format,
    mimeType: format === CreativeFormat.JPG ? 'image/jpeg' : 'image/png',
    extension: format === CreativeFormat.JPG ? 'jpg' : 'png',
    composition,
    analysis,
  };
}

/**
 * A brand-only creative, for when there is no photograph to work from.
 *
 * This is genuinely generated here from the client's own palette — it is not an
 * AI image, and nothing in the product calls it one. Generating a photograph
 * would need an image model, which is reported as blocked rather than faked.
 */
export async function renderBrandBackground(preset: CreativePreset, brand: BrandTreatment): Promise<Buffer> {
  const primary = safeColor(brand.primaryColor, '#6366F1');
  const accent = safeColor(brand.accentColor, '#22D3EE');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${preset.width}" height="${preset.height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${primary}"/>
      <stop offset="100%" stop-color="${accent}"/>
    </linearGradient>
  </defs>
  <rect width="${preset.width}" height="${preset.height}" fill="url(#bg)"/>
  <circle cx="${preset.width * 0.82}" cy="${preset.height * 0.18}" r="${Math.min(preset.width, preset.height) * 0.28}" fill="#FFFFFF" opacity="0.10"/>
  <circle cx="${preset.width * 0.16}" cy="${preset.height * 0.74}" r="${Math.min(preset.width, preset.height) * 0.2}" fill="#000000" opacity="0.12"/>
</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Adaptive composition — the acceptance test for "do not just resize the image".
 *
 * The thing being pinned here is that a 16:9 source becoming a 9:16 ad is a
 * *different composition*, not a slice of the original. That distinction is
 * invisible to every other kind of check: a blind crop produces a file of the
 * right dimensions, with the right name, that opens fine. The only way to catch
 * a regression back to cropping is to measure what happened to the pixels.
 *
 * The source used below is deliberately built so a crop is detectable: a wide
 * frame with a bright marker band down each vertical edge. A cover crop to 9:16
 * keeps a narrow central column and loses both markers; a recomposition keeps
 * the whole frame and therefore keeps them. Counting marker pixels in the output
 * distinguishes the two without needing to look at the image.
 */

import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { CreativeFormat } from '@prisma/client';

import { analyzeSource } from '../src/services/creative/analyze.js';
import { MIN_RETAINED_AREA, planComposition, retainedAreaFor } from '../src/services/creative/compose.js';
import { renderCreative } from '../src/services/creative/render.js';
import { presetByKey } from '../src/services/creative/presets.js';

const BRAND = { name: 'Pawese', primaryColor: '#6366F1', accentColor: '#22D3EE', textColor: '#E8EBF2' };

/**
 * A 1920×1080 frame: dark ground, a mid-grey subject block in the centre, and
 * a saturated magenta marker band at the extreme left and right edges.
 */
async function wideSource(): Promise<Buffer> {
  const width = 1920;
  const height = 1080;
  const markerWidth = 120;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="${width}" height="${height}" fill="#202030"/>
    <rect x="${width / 2 - 300}" y="${height / 2 - 200}" width="600" height="400" fill="#8a8a8a"/>
    <rect x="0" y="0" width="${markerWidth}" height="${height}" fill="#ff00ff"/>
    <rect x="${width - markerWidth}" y="0" width="${markerWidth}" height="${height}" fill="#ff00ff"/>
  </svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Report whether the left and right edge markers both survived.
 *
 * Counting markers alone is not a sound test: the markers are saturated, so
 * libvips' attention algorithm is drawn *towards* one of them and a crop can
 * land on a marker rather than losing both. The invariant that actually
 * separates cropping from recomposing is that **both** markers are present —
 * they sit 1800px apart in a 1920px frame, so no 9:16 crop of it can contain
 * the pair, while a recomposition that keeps the whole frame always does.
 */
async function markerSides(image: Buffer): Promise<{ left: boolean; right: boolean }> {
  const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
  let left = 0;
  let right = 0;

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const i = (y * info.width + x) * info.channels;
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      if (r > 150 && b > 150 && g < 110) {
        if (x < info.width / 2) left += 1;
        else right += 1;
      }
    }
  }
  return { left: left > 500, right: right > 500 };
}

describe('composition planning', () => {
  it('computes how much of a frame a cover crop would keep', () => {
    // 16:9 into 9:16 keeps only (9/16)/(16/9) ≈ 32% of the frame.
    expect(retainedAreaFor(16 / 9, 9 / 16)).toBeCloseTo(0.3164, 3);
    // 4:5 into 1:1 keeps most of it.
    expect(retainedAreaFor(0.8, 1)).toBeCloseTo(0.8, 3);
    // Identical aspects lose nothing.
    expect(retainedAreaFor(1, 1)).toBe(1);
  });

  it('crops when the aspects are close and recomposes when they are not', async () => {
    const analysis = await analyzeSource(await wideSource());

    const landscape = planComposition(analysis, presetByKey('GOOGLE_ADS_LANDSCAPE')!);
    expect(landscape.strategy).toBe('CROP');
    expect(landscape.retainedArea).toBeGreaterThanOrEqual(MIN_RETAINED_AREA);

    const vertical = planComposition(analysis, presetByKey('TIKTOK_VERTICAL')!);
    expect(vertical.strategy).toBe('EXTEND');
    expect(vertical.reason).toMatch(/discard/i);
  });

  it('places the whole source inside the safe area when recomposing', async () => {
    const analysis = await analyzeSource(await wideSource());
    const preset = presetByKey('TIKTOK_VERTICAL')!;
    const plan = planComposition(analysis, preset);

    const safeTop = preset.height * preset.safeArea.top;
    const safeBottom = preset.height * (1 - preset.safeArea.bottom);

    expect(plan.subject.top).toBeGreaterThanOrEqual(Math.floor(safeTop));
    expect(plan.subject.top + plan.subject.height).toBeLessThanOrEqual(Math.ceil(safeBottom));
    // And the aspect of the placed source is preserved — never stretched.
    expect(plan.subject.width / plan.subject.height).toBeCloseTo(analysis.aspect, 1);
  });
});

describe('adaptive rendering', () => {
  const render = async (presetKey: string) =>
    renderCreative({
      source: await wideSource(),
      preset: presetByKey(presetKey)!,
      brand: BRAND,
      headline: 'Twenty percent off this weekend',
      ctaLabel: 'Order now',
      format: CreativeFormat.PNG,
    });

  it('keeps content a crop would have thrown away', async () => {
    const source = await wideSource();
    const preset = presetByKey('TIKTOK_VERTICAL')!;

    // What a blind cover crop would produce — the old behaviour.
    const cropped = await sharp(source)
      .resize(preset.width, preset.height, { fit: 'cover', position: sharp.strategy.attention })
      .png()
      .toBuffer();

    const adapted = await render('TIKTOK_VERTICAL');

    const croppedSides = await markerSides(cropped);
    const adaptedSides = await markerSides(adapted.buffer);

    // A 9:16 crop of a 16:9 frame keeps a ~607px column: it cannot hold two
    // markers 1800px apart, so at most one side survives.
    expect(croppedSides.left && croppedSides.right).toBe(false);

    // The recomposition keeps the entire frame, so both survive.
    expect(adaptedSides.left).toBe(true);
    expect(adaptedSides.right).toBe(true);
    expect(adapted.composition.strategy).toBe('EXTEND');
  });

  it('produces genuinely different compositions for vertical and landscape', async () => {
    const vertical = await render('TIKTOK_VERTICAL');
    // 1.91:1 against a 16:9 source: close enough to crop, but not identical,
    // so this exercises a real crop rather than a no-op passthrough.
    const landscape = await render('GOOGLE_ADS_LANDSCAPE');

    expect(vertical.composition.strategy).toBe('EXTEND');
    expect(landscape.composition.strategy).toBe('CROP');

    // Not merely different sizes: built by different routes, and the vertical
    // one retains the whole frame while the landscape one trims it.
    expect(vertical.composition.retainedArea).toBe(1);
    expect(landscape.composition.retainedArea).toBeLessThan(1);
    expect(landscape.composition.retainedArea).toBeGreaterThan(MIN_RETAINED_AREA);
  });

  it('never distorts the source aspect when recomposing', async () => {
    const rendered = await render('INSTAGRAM_STORY');
    const { subject } = rendered.composition;
    const analysis = rendered.analysis;

    expect(rendered.composition.strategy).toBe('EXTEND');
    expect(subject.width / subject.height).toBeCloseTo(analysis.aspect, 1);
  });

  it('still emits exactly the placement dimensions', async () => {
    for (const key of ['TIKTOK_VERTICAL', 'INSTAGRAM_PORTRAIT', 'X_LANDSCAPE', 'GOOGLE_ADS_LANDSCAPE']) {
      const rendered = await render(key);
      const preset = presetByKey(key)!;
      const meta = await sharp(rendered.buffer).metadata();

      expect(meta.width).toBe(preset.width);
      expect(meta.height).toBe(preset.height);
    }
  });

  it('reports a focal point measured from the image rather than assuming centre', async () => {
    // Subject pushed hard to the left; the focal point must follow it.
    const offset = await sharp(
      Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080">
        <rect width="1920" height="1080" fill="#101018"/>
        <rect x="60" y="340" width="520" height="400" fill="#ff6b2c"/>
      </svg>`),
    )
      .png()
      .toBuffer();

    const analysis = await analyzeSource(offset);
    expect(analysis.focalPoint.x).toBeLessThan(0.5);
    expect(analysis.width).toBe(1920);
    expect(analysis.aspect).toBeCloseTo(16 / 9, 2);
  });
});

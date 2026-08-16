/**
 * Adaptive composition.
 *
 * The rule this module exists to enforce: **a 16:9 photograph must not become a
 * 9:16 ad by cutting 64% of it away.** A cover crop from landscape to vertical
 * keeps a 1080×608 slice of a 1920×1080 frame and throws the rest out — and
 * whatever the crop window misses (the plate, the logo, half a face) is simply
 * gone, silently, in a file somebody then pays to promote.
 *
 * So the strategy is chosen from how violent the change actually is:
 *
 *   CROP    the aspects are close, so cropping costs little. Cut with
 *           attention, keeping the focal region.
 *
 *   EXTEND  the aspects are far apart. Build a *new* canvas: the source scaled
 *           up, blurred and darkened as a background plate, with the whole
 *           undamaged source laid on top, positioned into the placement's safe
 *           area. Nothing is cropped away; the frame is filled with material
 *           derived from the image itself rather than a black bar.
 *
 * The threshold is expressed as retained area, because that is the thing that
 * matters: below `MIN_RETAINED_AREA` of the original surviving a crop, the crop
 * is the wrong tool.
 */

import sharp from 'sharp';

import type { CreativeAnalysis } from './analyze.js';
import type { CreativePreset } from './presets.js';

export type CompositionStrategy = 'CROP' | 'EXTEND';

export interface Composition {
  strategy: CompositionStrategy;
  /** Fraction of the source's area that survives, 0–1. */
  retainedArea: number;
  /** Where the intact source sits on the target canvas, in target pixels. */
  subject: { left: number; top: number; width: number; height: number };
  reason: string;
}

/** Below this share of the source surviving a crop, recompose instead. */
export const MIN_RETAINED_AREA = 0.62;

/**
 * How much of the source a cover crop to this target would keep.
 *
 * Cover scales so the shorter side fills, then trims the longer one, so the
 * retained fraction is the ratio of the two aspects, whichever way round.
 */
export function retainedAreaFor(sourceAspect: number, targetAspect: number): number {
  return sourceAspect > targetAspect ? targetAspect / sourceAspect : sourceAspect / targetAspect;
}

export function planComposition(analysis: CreativeAnalysis, preset: CreativePreset): Composition {
  const targetAspect = preset.width / preset.height;
  const retained = retainedAreaFor(analysis.aspect, targetAspect);

  if (retained >= MIN_RETAINED_AREA) {
    return {
      strategy: 'CROP',
      retainedArea: retained,
      subject: { left: 0, top: 0, width: preset.width, height: preset.height },
      reason: `Aspects are close (${Math.round(retained * 100)}% of the frame retained), so the image is cropped to the focal region.`,
    };
  }

  /*
   * Fit the whole source inside the safe area rather than the whole canvas.
   * Placing it edge-to-edge would push the picture under the platform's own UI
   * on a vertical placement — which is the failure the safe area exists to
   * describe.
   */
  const safeTop = Math.round(preset.height * preset.safeArea.top);
  const safeBottom = Math.round(preset.height * preset.safeArea.bottom);
  const safeHeight = preset.height - safeTop - safeBottom;

  const scale = Math.min(preset.width / analysis.width, safeHeight / analysis.height);
  const width = Math.max(1, Math.round(analysis.width * scale));
  const height = Math.max(1, Math.round(analysis.height * scale));

  /*
   * Vertically: bias the subject above centre on tall canvases. The lower
   * portion of a Reel or TikTok frame is where the caption and controls sit,
   * and where the headline and CTA get burned in, so the picture is lifted to
   * leave that space genuinely free rather than merely nominally safe.
   */
  const slack = safeHeight - height;
  const top = safeTop + Math.round(slack * (targetAspect < 1 ? 0.35 : 0.5));

  return {
    strategy: 'EXTEND',
    retainedArea: 1,
    subject: { left: Math.round((preset.width - width) / 2), top, width, height },
    reason:
      `A crop would discard ${Math.round((1 - retained) * 100)}% of the frame, so the canvas is rebuilt: ` +
      'the full image is placed in the safe area over a background extended from the image itself.',
  };
}

/**
 * Render the source onto the target canvas according to the plan.
 *
 * Returns a buffer at exactly the preset's dimensions, ready for the text layer
 * to be composited over.
 */
export async function composeBase(input: {
  source: Buffer;
  analysis: CreativeAnalysis;
  preset: CreativePreset;
  composition: Composition;
}): Promise<Buffer> {
  const { preset, composition } = input;

  if (composition.strategy === 'CROP') {
    return sharp(input.source)
      .rotate()
      .resize(preset.width, preset.height, { fit: 'cover', position: sharp.strategy.attention })
      .toBuffer();
  }

  /*
   * Background plate: the source blown up to fill, heavily blurred and darkened.
   * Derived from the image itself so the colours always agree with the subject,
   * which a flat brand-colour fill cannot guarantee. Darkened because the plate
   * sits behind burned-in white copy.
   */
  const background = await sharp(input.source)
    .rotate()
    .resize(preset.width, preset.height, { fit: 'cover', position: sharp.strategy.attention })
    .blur(Math.max(12, Math.round(Math.min(preset.width, preset.height) / 28)))
    .modulate({ brightness: 0.62, saturation: 1.1 })
    .toBuffer();

  // The subject, intact — this is the copy nothing is cropped out of.
  const subject = await sharp(input.source)
    .rotate()
    .resize(composition.subject.width, composition.subject.height, { fit: 'inside' })
    .toBuffer();

  return sharp(background)
    .composite([{ input: subject, left: composition.subject.left, top: composition.subject.top }])
    .toBuffer();
}

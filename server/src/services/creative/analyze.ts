/**
 * Source creative analysis.
 *
 * Finds where the picture's subject actually is, so a variant can be *composed*
 * around it rather than cropped through it. Everything here is measured from
 * real pixels — there is no vision model in this deployment, so nothing claims
 * to know that the subject is a burger, only where the visually dense region
 * sits and how much of the frame is expendable background.
 *
 * The focal region comes from libvips' own attention algorithm, which scores
 * for skin tones, saturation and edge density and is what sharp's
 * `position: attention` already uses internally. Running it against a square
 * target and reading back the crop offsets is the cheapest way to get a real
 * focal box rather than assuming the centre — and the centre assumption is
 * exactly what ruins a 16:9 restaurant shot where the dish sits on one third.
 */

import sharp from 'sharp';

export interface Region {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CreativeAnalysis {
  width: number;
  height: number;
  aspect: number;
  /** Where the visually important content sits, in source pixels. */
  focalRegion: Region;
  /** Centre of the focal region, as fractions of width/height. */
  focalPoint: { x: number; y: number };
  /** Mean luminance 0–255, used to pick a legible scrim and text colour. */
  luminance: number;
  /** True when the edges are calm enough to extend as background. */
  backgroundExtendable: boolean;
  /** Dominant colour, for background fill that does not clash. */
  dominant: { r: number; g: number; b: number };
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/**
 * Locate the focal region by asking libvips to crop to a square with attention
 * and reading where it chose to cut.
 */
async function focalRegion(source: Buffer, width: number, height: number): Promise<Region> {
  const side = Math.min(width, height);

  try {
    const { info } = await sharp(source)
      .resize(side, side, { fit: 'cover', position: sharp.strategy.attention })
      .raw()
      .toBuffer({ resolveWithObject: true });

    // cropOffset* are only present when a crop actually happened.
    const left = (info as unknown as { cropOffsetLeft?: number }).cropOffsetLeft ?? 0;
    const top = (info as unknown as { cropOffsetTop?: number }).cropOffsetTop ?? 0;

    return {
      left: clamp(Math.abs(left), 0, Math.max(0, width - side)),
      top: clamp(Math.abs(top), 0, Math.max(0, height - side)),
      width: side,
      height: side,
    };
  } catch {
    // Analysis must never be the reason a render fails; centre is a safe answer.
    return { left: Math.round((width - side) / 2), top: Math.round((height - side) / 2), width: side, height: side };
  }
}

export async function analyzeSource(source: Buffer): Promise<CreativeAnalysis> {
  const image = sharp(source, { failOn: 'error' });
  const metadata = await image.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width === 0 || height === 0) throw new Error('Source image has no readable dimensions');

  const [region, stats] = await Promise.all([focalRegion(source, width, height), sharp(source).stats()]);

  const [r, g, b] = stats.channels;
  const luminance = r && g && b ? 0.2126 * r.mean + 0.7152 * g.mean + 0.0722 * b.mean : 128;

  /*
   * Whether the frame can be extended is judged from how busy its edges are.
   * A high standard deviation at the border means detail runs to the edge, and
   * stretching that produces visible smearing; a calm border (sky, table,
   * studio backdrop) extends convincingly. Measured on the outer eighth.
   */
  const border = Math.max(8, Math.round(Math.min(width, height) / 8));
  let edgeVariance = 999;
  try {
    const strip = await sharp(source)
      .extract({ left: 0, top: 0, width, height: Math.min(border, height) })
      .stats();
    edgeVariance = strip.channels[0]?.stdev ?? 999;
  } catch {
    // Leave the pessimistic default: no extension rather than a smeared one.
  }

  return {
    width,
    height,
    aspect: width / height,
    focalRegion: region,
    focalPoint: {
      x: clamp((region.left + region.width / 2) / width, 0, 1),
      y: clamp((region.top + region.height / 2) / height, 0, 1),
    },
    luminance,
    backgroundExtendable: edgeVariance < 60,
    dominant: stats.dominant ?? { r: 20, g: 20, b: 28 },
  };
}

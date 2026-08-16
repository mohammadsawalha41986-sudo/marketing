/**
 * Video rendering.
 *
 * Two commitments shape this file.
 *
 * **Every frame goes through the adaptive composition engine.** A vertical video
 * built from a landscape product photograph is not that photograph with 64% cut
 * off — `planComposition` and `composeBase` decide, exactly as they do for a
 * still, whether the aspect change is small enough to crop or large enough to
 * need a rebuilt canvas. The engine is imported, not reimplemented and not
 * modified.
 *
 * **The output is verified before it is returned.** FFmpeg exits 0 on files that
 * do not play; a truncated MP4 downloads perfectly and opens nowhere. So the
 * render is not finished until ffprobe confirms an H.264 video stream, an AAC
 * audio stream, the right dimensions and a duration close to what was asked for.
 *
 * The motion is done by FFmpeg's `zoompan`, working on stills composed by sharp.
 * Doing it the other way round — rendering every frame in Node — would mean
 * thousands of sharp invocations per video for a result FFmpeg produces in one
 * pass.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

import { analyzeSource } from '../creative/analyze.js';
import { composeBase, planComposition } from '../creative/compose.js';
import type { BrandTreatment } from '../creative/render.js';
import { ffmpeg, probe, type ProbeResult } from './ffmpeg.js';
import type { VideoPlacement } from './placements.js';
import type { Motion, Scene } from './script.js';

export interface AudioTrack {
  buffer: Buffer;
  /** Original filename, used only to pick a container extension. */
  filename: string;
  volume?: number;
  trimStartSeconds?: number;
  fadeInSeconds?: number;
  fadeOutSeconds?: number;
}

export interface VideoRenderInput {
  /** One image per scene, in order. A single image is reused for all scenes. */
  sources: Buffer[];
  scenes: Scene[];
  placement: VideoPlacement;
  brand: BrandTreatment;
  audio?: AudioTrack | null;
  fps?: number;
}

export interface RenderedVideo {
  buffer: Buffer;
  probe: ProbeResult;
  width: number;
  height: number;
  durationSeconds: number;
  /** How each scene's frame was built, so a crop regression stays visible. */
  compositions: Array<{ scene: string; strategy: string; retainedArea: number }>;
}

/** Cross-dissolve length. Short enough to read as a cut with a soft edge. */
const TRANSITION_SECONDS = 0.4;

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function safeColor(value: string | undefined | null, fallback: string): string {
  return value && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value) ? value : fallback;
}

/** Greedy wrap, same approach as the still renderer: SVG will not wrap for us. */
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
  return lines.slice(0, maxLines);
}

/**
 * The text layer for one scene.
 *
 * Placed inside the placement's safe area, which for video is wider than for a
 * still — the caption, sound name and interaction column sit over the picture
 * and the viewer cannot scroll them away.
 */
function sceneOverlay(input: { scene: Scene; placement: VideoPlacement; brand: BrandTreatment }): string {
  const { scene, placement, brand } = input;
  const { width, height } = placement;

  const primary = safeColor(brand.primaryColor, '#6366F1');
  const accent = safeColor(brand.accentColor, '#22D3EE');

  const padX = Math.round(width * 0.08);
  const bottomSafe = Math.round(height * placement.safeArea.bottom);

  // The offer and CTA are the two scenes that must read at a glance, so they
  // get the larger type; a benefit sentence needs to fit more than it needs to
  // shout.
  const emphatic = scene.kind === 'OFFER' || scene.kind === 'CTA' || scene.kind === 'HOOK';
  const size = Math.round(Math.min(width, height) * (emphatic ? 0.095 : 0.062));
  const subSize = Math.round(size * 0.42);

  const maxChars = Math.max(10, Math.floor((width - padX * 2) / (size * 0.52)));
  const lines = wrap(scene.text, maxChars, 3);
  const lineHeight = Math.round(size * 1.16);

  const blockHeight = lines.length * lineHeight + (scene.subtext ? subSize * 1.8 : 0);
  const top = height - bottomSafe - blockHeight;

  const textLines = lines
    .map(
      (line, index) =>
        `<text x="${padX}" y="${top + lineHeight * index + size}" font-family="sans-serif" font-size="${size}" ` +
        `font-weight="800" fill="#FFFFFF" letter-spacing="-0.5">${esc(line)}</text>`,
    )
    .join('\n  ');

  const sub = scene.subtext
    ? `<text x="${padX}" y="${top + lines.length * lineHeight + subSize * 1.3}" font-family="sans-serif" ` +
      `font-size="${subSize}" font-weight="600" fill="#FFFFFF" opacity="0.82">${esc(scene.subtext)}</text>`
    : '';

  const scrimTop = Math.max(0, top - size * 1.5);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="55%" stop-color="#000000" stop-opacity="0.6"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.88"/>
    </linearGradient>
  </defs>
  <rect x="0" y="${scrimTop}" width="${width}" height="${height - scrimTop}" fill="url(#scrim)"/>
  <rect x="0" y="${height - Math.round(height * 0.008)}" width="${width}" height="${Math.round(height * 0.008)}" fill="${primary}"/>
  <rect x="${padX}" y="${Math.max(0, scrimTop - Math.round(size * 0.5))}" width="${Math.round(width * 0.1)}" height="${Math.max(3, Math.round(size * 0.09))}" rx="2" fill="${accent}"/>
  ${textLines}
  ${sub}
</svg>`;
}

/**
 * The `zoompan` expression for a motion style.
 *
 * zoompan works per output frame; `on` is the frame index. The still is scaled
 * up first (in the filter chain below) because zoompan samples from the input at
 * integer offsets, and on a frame-sized input that quantisation shows up as
 * visible stepping rather than a smooth push.
 */
function motionFilter(motion: Motion, frames: number, width: number, height: number): string {
  const size = `s=${width}x${height}`;
  const common = `d=${frames}:${size}:fps=30`;

  switch (motion) {
    case 'ZOOM_IN':
      // 1.0 → 1.12 over the scene, centred.
      return `zoompan=z='min(1.0+0.12*on/${frames},1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':${common}`;
    case 'ZOOM_OUT':
      return `zoompan=z='max(1.12-0.12*on/${frames},1.0)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':${common}`;
    case 'PAN_LEFT':
      // Held at a slight zoom so there is room to travel without black edges.
      return `zoompan=z='1.08':x='(iw-iw/zoom)*(1-on/${frames})':y='ih/2-(ih/zoom/2)':${common}`;
    case 'PAN_RIGHT':
      return `zoompan=z='1.08':x='(iw-iw/zoom)*on/${frames}':y='ih/2-(ih/zoom/2)':${common}`;
    case 'STATIC':
    default:
      // Still not literally static: a 2% drift stops a card looking like a
      // stalled player.
      return `zoompan=z='min(1.0+0.02*on/${frames},1.02)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':${common}`;
  }
}

function audioExtension(filename: string): string {
  const match = /\.(mp3|wav|m4a|aac|ogg)$/i.exec(filename);
  return match ? match[0].toLowerCase() : '.mp3';
}

export async function renderVideo(input: VideoRenderInput): Promise<RenderedVideo> {
  const { placement, scenes, brand } = input;
  if (scenes.length === 0) throw new Error('A video needs at least one scene');
  if (input.sources.length === 0) throw new Error('A video needs at least one source image');

  const fps = input.fps ?? 30;
  const workDir = await mkdtemp(join(tmpdir(), 'mos-video-'));

  try {
    const compositions: RenderedVideo['compositions'] = [];
    const framePaths: string[] = [];

    for (const [index, scene] of scenes.entries()) {
      // Scenes cycle through whatever imagery exists rather than demanding one
      // photograph per scene — most products arrive with two or three images.
      const source = input.sources[index % input.sources.length]!;

      /*
       * The adaptive engine, unmodified. This is the step that makes a vertical
       * video a recomposition of a landscape photograph rather than a slice of
       * one, and it is exactly the same code path the still creatives use.
       */
      const analysis = await analyzeSource(source);
      const composition = planComposition(analysis, placement);
      const base = await composeBase({ source, analysis, preset: placement, composition });

      compositions.push({
        scene: scene.kind,
        strategy: composition.strategy,
        retainedArea: composition.retainedArea,
      });

      const overlay = Buffer.from(sceneOverlay({ scene, placement, brand }));
      const frame = await sharp(base).composite([{ input: overlay, top: 0, left: 0 }]).png().toBuffer();

      const framePath = join(workDir, `scene-${index}.png`);
      await writeFile(framePath, frame);
      framePaths.push(framePath);
    }

    const outputPath = join(workDir, 'out.mp4');

    // ------------------------------------------------------------- filtergraph
    const args: string[] = [];
    for (const [index, framePath] of framePaths.entries()) {
      args.push('-loop', '1', '-t', String(scenes[index]!.durationSeconds), '-i', framePath);
    }

    /*
     * Every input has to be declared before the filtergraph and the maps —
     * FFmpeg parses options positionally, and an input added after `-map` is
     * read as an output option and rejected.
     *
     * A video with no chosen music still gets a silent AAC track. Several ad
     * platforms transcode or reject audio-less uploads unpredictably, and a
     * uniform stream layout makes the ffprobe gate below one check rather than
     * a pair of conditional ones.
     */
    const hasAudio = Boolean(input.audio);
    const audioIndex = framePaths.length;

    if (input.audio) {
      const audioPath = join(workDir, `audio${audioExtension(input.audio.filename)}`);
      await writeFile(audioPath, input.audio.buffer);
      if (input.audio.trimStartSeconds && input.audio.trimStartSeconds > 0) {
        args.push('-ss', String(input.audio.trimStartSeconds));
      }
      args.push('-i', audioPath);
    } else {
      args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
    }

    const chains: string[] = [];
    for (const [index, scene] of scenes.entries()) {
      const frames = Math.max(1, Math.round(scene.durationSeconds * fps));
      /*
       * Scale to 2× before zoompan, then let zoompan output at the placement
       * size. Sampling a frame-sized still produces visible stepping as the
       * zoom crosses pixel boundaries; the oversized intermediate hides it.
       */
      chains.push(
        `[${index}:v]scale=${placement.width * 2}:${placement.height * 2},` +
          `${motionFilter(scene.motion, frames, placement.width, placement.height)},` +
          `setsar=1,format=yuv420p[v${index}]`,
      );
    }

    /*
     * Cross-dissolve the scenes together. Each xfade starts
     * `TRANSITION_SECONDS` before the running total ends, so the offsets
     * accumulate: offset(k) = Σ durations[0..k] − (k+1) × transition.
     */
    let lastLabel = 'v0';
    let elapsed = scenes[0]!.durationSeconds;

    for (let index = 1; index < scenes.length; index += 1) {
      const label = `x${index}`;
      const offset = Math.max(0, elapsed - TRANSITION_SECONDS);
      chains.push(
        `[${lastLabel}][v${index}]xfade=transition=fade:duration=${TRANSITION_SECONDS}:offset=${offset.toFixed(3)}[${label}]`,
      );
      elapsed = offset + TRANSITION_SECONDS + scenes[index]!.durationSeconds - TRANSITION_SECONDS;
      elapsed = Number((offset + scenes[index]!.durationSeconds).toFixed(3));
      lastLabel = label;
    }

    const totalDuration = Number(elapsed.toFixed(3));

    if (input.audio) {
      const volume = Math.min(2, Math.max(0, input.audio.volume ?? 1));
      const fadeIn = input.audio.fadeInSeconds ?? 0.5;
      const fadeOut = input.audio.fadeOutSeconds ?? 1;
      const fadeOutStart = Math.max(0, totalDuration - fadeOut);

      chains.push(
        `[${audioIndex}:a]atrim=0:${totalDuration},asetpts=PTS-STARTPTS,` +
          `volume=${volume},afade=t=in:st=0:d=${fadeIn},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOut},` +
          `aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[aout]`,
      );
    }

    args.push('-filter_complex', chains.join(';'));
    args.push('-map', `[${lastLabel}]`);

    args.push('-map', hasAudio ? '[aout]' : `${audioIndex}:a`);

    args.push(
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '21',
      // yuv420p and an even frame size: anything else fails to play on iOS.
      '-pix_fmt', 'yuv420p',
      '-r', String(fps),
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '44100',
      '-movflags', '+faststart',
      '-t', String(totalDuration),
      '-shortest',
      outputPath,
    );

    await ffmpeg(args);

    // ------------------------------------------------------------ acceptance
    const result = await probe(outputPath);

    if (!result.hasVideo) throw new Error('The rendered file has no video stream');
    if (result.videoCodec !== 'h264') throw new Error(`Expected an H.264 video stream, got ${result.videoCodec}`);
    if (!result.hasAudio) throw new Error('The rendered file has no audio stream');
    if (result.width !== placement.width || result.height !== placement.height) {
      throw new Error(
        `Rendered at ${result.width}x${result.height}, expected ${placement.width}x${placement.height}`,
      );
    }
    // A truncated render exits 0 and probes short. Half a second of tolerance
    // covers frame rounding at the tail.
    if (Math.abs(result.durationSeconds - totalDuration) > 0.75) {
      throw new Error(
        `Rendered ${result.durationSeconds.toFixed(2)}s, expected about ${totalDuration.toFixed(2)}s — the output is truncated`,
      );
    }
    if (result.sizeBytes < 1024) throw new Error('The rendered file is too small to be a real video');

    return {
      buffer: await readFile(outputPath),
      probe: result,
      width: placement.width,
      height: placement.height,
      durationSeconds: result.durationSeconds,
      compositions,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

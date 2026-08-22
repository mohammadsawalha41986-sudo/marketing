/**
 * What a file actually is.
 *
 * Every claim about an uploaded advertisement — its dimensions, its ratio, how
 * long it runs, whether it has sound — is measured here from the bytes. The
 * multipart headers say whatever the client chose to say, the extension says
 * whatever someone typed, and neither is evidence. `sharp` reads images through
 * libvips and `ffprobe` reads video through FFmpeg, so both answers come from a
 * decoder that would have to actually open the file.
 *
 * Nothing in this module modifies anything. It is the measuring step of
 * upload → validate → analyse, and the uploaded creative is the operator's
 * finished work: it gets inspected, never corrected.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';

import { badRequest } from '../../lib/errors.js';
import { ffmpegCapability, probe } from '../video/ffmpeg.js';

export type MediaShape = 'IMAGE' | 'VIDEO';

export interface InspectedMedia {
  kind: MediaShape;
  /** Hex SHA-256 of the exact bytes received. */
  sha256: string;
  sizeBytes: number;
  /** The container/codec family the bytes really are, e.g. `jpeg`, `mp4`. */
  format: string;
  width: number | null;
  height: number | null;
  /** width / height, to three decimals. Null when a dimension is unknown. */
  aspectRatio: number | null;
  durationSeconds: number | null;
  frameRate: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean | null;
  bitrateKbps: number | null;
  /**
   * True when the numbers above came from a decoder. False means the file was
   * accepted on its signature alone because the deployment has no FFmpeg — the
   * validator must then report "unknown", never "valid".
   */
  measured: boolean;
  /** Why something is unmeasured, for the operator rather than the log. */
  note: string | null;
}

export const sha256Of = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');

/**
 * Container sniffing for video, matching what `sniffImage` does for pictures.
 *
 * MP4 and MOV are both ISO base media files: bytes 4–8 are `ftyp` and the brand
 * that follows says which. WebM is a Matroska EBML header. A file that claims
 * video/mp4 and starts with anything else is not an MP4, whatever the browser
 * put in the Content-Type.
 */
export function sniffVideo(buffer: Buffer): 'mp4' | 'mov' | 'webm' | null {
  if (buffer.length < 12) return null;

  if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('ascii').toLowerCase();
    // `qt  ` is QuickTime; everything else in this family reads as MP4 to the
    // platforms that matter (isom, mp42, avc1, iso2, m4v…).
    if (brand.startsWith('qt')) return 'mov';
    return 'mp4';
  }

  // EBML magic: 1A 45 DF A3.
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return 'webm';

  return null;
}

const round = (value: number, places = 3): number => Number(value.toFixed(places));

async function inspectImage(buffer: Buffer): Promise<InspectedMedia> {
  let meta: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
  try {
    meta = await sharp(buffer).metadata();
  } catch {
    // A file that starts like an image but does not decode is the operator's
    // problem to fix, not a server fault.
    throw badRequest('That image could not be decoded. It may be truncated or corrupt.');
  }

  const width = meta.width ?? null;
  const height = meta.height ?? null;

  return {
    kind: 'IMAGE',
    sha256: sha256Of(buffer),
    sizeBytes: buffer.byteLength,
    format: meta.format ?? 'unknown',
    width,
    height,
    aspectRatio: width && height ? round(width / height) : null,
    durationSeconds: null,
    frameRate: null,
    videoCodec: null,
    audioCodec: null,
    hasAudio: null,
    bitrateKbps: null,
    measured: true,
    note: null,
  };
}

/**
 * Probe a video.
 *
 * ffprobe reads a path, so the buffer is written to a private temp file and
 * removed afterwards — the upload itself goes to the StorageProvider, never to
 * local disk. When FFmpeg is absent the file is still accepted on its signature
 * (refusing it would make the deployment's missing dependency the operator's
 * problem) but every measured field stays null and `measured` is false, so
 * nothing downstream can mistake "not measured" for "fine".
 */
async function inspectVideo(buffer: Buffer, container: string): Promise<InspectedMedia> {
  const base: InspectedMedia = {
    kind: 'VIDEO',
    sha256: sha256Of(buffer),
    sizeBytes: buffer.byteLength,
    format: container,
    width: null,
    height: null,
    aspectRatio: null,
    durationSeconds: null,
    frameRate: null,
    videoCodec: null,
    audioCodec: null,
    hasAudio: null,
    bitrateKbps: null,
    measured: false,
    note: null,
  };

  const capability = await ffmpegCapability();
  if (!capability.available) {
    return {
      ...base,
      note:
        'Video could not be measured: FFmpeg is not installed on this deployment, so duration, ' +
        'dimensions and codecs are unknown. Placement checks that need them will say so.',
    };
  }

  const dir = await mkdtemp(join(tmpdir(), 'mos-inspect-'));
  const path = join(dir, `upload.${container}`);
  try {
    await writeFile(path, buffer);
    const result = await probe(path);

    if (!result.hasVideo) {
      throw badRequest('That file contains no video stream.');
    }

    const width = result.width || null;
    const height = result.height || null;
    const duration = result.durationSeconds || null;

    return {
      ...base,
      width,
      height,
      aspectRatio: width && height ? round(width / height) : null,
      durationSeconds: duration ? round(duration, 2) : null,
      frameRate: result.frameRate,
      videoCodec: result.videoCodec,
      audioCodec: result.audioCodec,
      hasAudio: result.hasAudio,
      // From the real byte count and the real duration, not the container's
      // own claim, which is frequently absent.
      bitrateKbps: duration ? Math.round((buffer.byteLength * 8) / duration / 1000) : null,
      measured: true,
      note: null,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Inspect an upload, deciding image or video from the bytes themselves.
 *
 * `declaredMime` is used only to choose which sniffer to try first; it never
 * decides the outcome. A file whose signature matches neither family is
 * rejected here rather than stored and discovered later.
 */
export async function inspectMedia(buffer: Buffer, declaredMime: string): Promise<InspectedMedia> {
  const { sniffImage } = await import('../../middleware/upload.js');

  const looksVideo = declaredMime.startsWith('video/');
  const video = sniffVideo(buffer);
  const image = sniffImage(buffer);

  if (looksVideo) {
    if (video) return inspectVideo(buffer, video);
    if (image) return inspectImage(buffer);
    throw badRequest('That file is not a readable video.');
  }

  if (image) return inspectImage(buffer);
  if (video) return inspectVideo(buffer, video);

  throw badRequest('That file is neither a readable image nor a readable video.');
}

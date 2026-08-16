/**
 * The FFmpeg boundary.
 *
 * Everything that shells out lives here, for two reasons. FFmpeg either exists
 * on the host or it does not, and the difference has to be a reported
 * capability rather than a crash halfway through a render — a deployment
 * without it should say so on the health endpoint, not fail the first time
 * somebody presses "Create video".
 *
 * And the output has to be *verified*. An FFmpeg process can exit 0 having
 * written a truncated file, and a zero-byte MP4 downloads perfectly and plays
 * nowhere. So nothing is returned from this module until ffprobe has confirmed
 * the file has the streams, codecs, dimensions and duration it was supposed to
 * have.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Bounded so a pathological input cannot pin a worker indefinitely. */
const RENDER_TIMEOUT_MS = 180_000;
const PROBE_TIMEOUT_MS = 20_000;

export interface FfmpegCapability {
  available: boolean;
  ffmpegVersion: string | null;
  ffprobeVersion: string | null;
  /** Why video is unavailable, when it is. */
  reason: string | null;
}

let cached: FfmpegCapability | null = null;

function firstLine(output: string): string | null {
  const line = output.split('\n')[0]?.trim();
  return line && line.length > 0 ? line : null;
}

/**
 * Whether this host can render video at all.
 *
 * Cached after the first successful probe: the binaries do not appear or vanish
 * mid-process, and shelling out twice per request to ask the same question is
 * waste. A negative result is *not* cached, so a container that gains FFmpeg
 * (a rebuilt image, a fixed PATH) starts working without a restart.
 */
export async function ffmpegCapability(refresh = false): Promise<FfmpegCapability> {
  if (cached && !refresh) return cached;

  try {
    const [ffmpeg, ffprobe] = await Promise.all([
      run('ffmpeg', ['-version'], { timeout: PROBE_TIMEOUT_MS }),
      run('ffprobe', ['-version'], { timeout: PROBE_TIMEOUT_MS }),
    ]);

    const capability: FfmpegCapability = {
      available: true,
      ffmpegVersion: firstLine(ffmpeg.stdout),
      ffprobeVersion: firstLine(ffprobe.stdout),
      reason: null,
    };
    cached = capability;
    return capability;
  } catch (error) {
    return {
      available: false,
      ffmpegVersion: null,
      ffprobeVersion: null,
      reason:
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'FFmpeg is not installed on this host, so video rendering is unavailable. Add the ffmpeg apt package to the deployment image.'
          : `FFmpeg could not be started: ${(error as Error).message}`,
    };
  }
}

export interface ProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
  videoCodec: string | null;
  audioCodec: string | null;
  hasVideo: boolean;
  hasAudio: boolean;
  frameRate: number | null;
  sizeBytes: number;
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
}

/** Parse ffprobe's `30000/1001` rational frame rate. */
function parseRate(value: string | undefined): number | null {
  if (!value) return null;
  const [num, den] = value.split('/').map(Number);
  if (!num || !den) return null;
  return Number((num / den).toFixed(3));
}

/**
 * Inspect a rendered file.
 *
 * This is the acceptance gate, not a diagnostic: a file that does not probe as
 * a real video with the expected geometry never reaches the operator.
 */
export async function probe(path: string): Promise<ProbeResult> {
  const { stdout } = await run(
    'ffprobe',
    ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path],
    { timeout: PROBE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
  );

  const parsed = JSON.parse(stdout) as {
    streams?: ProbeStream[];
    format?: { duration?: string; size?: string };
  };

  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');

  return {
    durationSeconds: Number(parsed.format?.duration ?? 0),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    frameRate: parseRate(video?.avg_frame_rate),
    sizeBytes: Number(parsed.format?.size ?? 0),
  };
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly stderrTail: string,
  ) {
    super(message);
    this.name = 'FfmpegError';
  }
}

/**
 * Run FFmpeg with the given arguments.
 *
 * `-nostdin` matters: without it a prompt (an existing output file, a codec
 * question) leaves the process waiting on input that will never arrive, and the
 * render hangs until the timeout rather than failing.
 *
 * Only the tail of stderr is kept on failure. FFmpeg is extremely verbose, and
 * the useful line — the codec that is missing, the filter that would not build
 * — is always at the end.
 */
export async function ffmpeg(args: string[], timeoutMs = RENDER_TIMEOUT_MS): Promise<void> {
  try {
    await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args], {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? '';
    const tail = stderr.split('\n').filter(Boolean).slice(-8).join('\n');
    throw new FfmpegError(`FFmpeg failed: ${tail || (error as Error).message}`, tail);
  }
}

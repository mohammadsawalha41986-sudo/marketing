/**
 * Video rendering.
 *
 * Two things are worth testing here and one of them is easy to skip.
 *
 * The easy one: the file is a real, playable MP4 — H.264 video, AAC audio, the
 * right dimensions, the right length. FFmpeg exits 0 on files that do not play,
 * so this is checked with ffprobe against the actual output rather than assumed
 * from a successful exit code.
 *
 * The one that is easy to skip: the video is *adaptively composed*, not
 * cover-cropped. A 16:9 product photograph becoming a 9:16 Reel must keep the
 * whole frame, exactly as it does for a still. That is checked by extracting a
 * real frame out of the finished MP4 and looking at its pixels — the marker
 * bands at both edges of the source sit 1800px apart, so no vertical crop can
 * contain the pair while a recomposition always does.
 *
 * Every case skips cleanly when FFmpeg is absent, because a machine without it
 * is a machine that legitimately cannot render video, and a red suite would say
 * the code is broken when the host is simply not equipped.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { ffmpegCapability, probe } from '../src/services/video/ffmpeg.js';
import { videoPlacementByKey, VIDEO_PLACEMENTS } from '../src/services/video/placements.js';
import { buildScript } from '../src/services/video/script.js';
import { renderVideo } from '../src/services/video/render.js';

const run = promisify(execFile);

const BRAND = { name: 'Forno Rosso', primaryColor: '#6366F1', accentColor: '#22D3EE', textColor: '#E8EBF2' };

const PRODUCT = {
  name: 'Stone Oven Margherita',
  brand: 'Forno Rosso',
  description: 'Hand-stretched dough, San Marzano tomatoes and fior di latte.',
  price: 42.5,
  salePrice: null,
  currency: 'SAR',
  category: 'Pizza',
  features: ['Fired at 450C in a stone oven'],
};

/** 1920×1080 with a saturated marker band down each vertical edge. */
async function wideSource(): Promise<Buffer> {
  return sharp(
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080">
      <rect width="1920" height="1080" fill="#202030"/>
      <rect x="660" y="340" width="600" height="400" fill="#8a8a8a"/>
      <rect x="0" y="0" width="120" height="1080" fill="#ff00ff"/>
      <rect x="1800" y="0" width="120" height="1080" fill="#ff00ff"/>
    </svg>`),
  )
    .png()
    .toBuffer();
}

let available = false;

beforeAll(async () => {
  available = (await ffmpegCapability()).available;
});

const whenFfmpeg = (name: string, fn: () => Promise<void>, timeout = 180_000) =>
  it(name, async (context) => {
    if (!available) {
      context.skip();
      return;
    }
    await fn();
  }, timeout);

describe('ffmpeg capability', () => {
  it('reports availability as a capability rather than throwing', async () => {
    const capability = await ffmpegCapability(true);

    if (capability.available) {
      expect(capability.ffmpegVersion).toMatch(/ffmpeg version/i);
      expect(capability.ffprobeVersion).toMatch(/ffprobe version/i);
      expect(capability.reason).toBeNull();
    } else {
      // A host without FFmpeg must say so in words an operator can act on.
      expect(capability.reason).toBeTruthy();
      expect(capability.reason).toMatch(/ffmpeg/i);
    }
  });
});

describe('the scene script', () => {
  it('builds the five-beat structure from real product fields', () => {
    const script = buildScript(PRODUCT, 15);
    expect(script.scenes.map((scene) => scene.kind)).toEqual(['HOOK', 'PRODUCT', 'BENEFIT', 'OFFER', 'CTA']);
    expect(script.totalSeconds).toBeGreaterThan(10);
    expect(script.scenes.every((scene) => scene.text.length > 0)).toBe(true);
  });

  it('omits the offer scene when the product has no price', () => {
    // A five-second card reading "Special offer" over a product with no stated
    // price is an advertisement making a claim nobody wrote.
    const script = buildScript({ ...PRODUCT, price: null, currency: null }, 15);

    expect(script.scenes.map((scene) => scene.kind)).not.toContain('OFFER');
    expect(script.omitted.join(' ')).toMatch(/did not state a price/i);
    expect(JSON.stringify(script.scenes)).not.toMatch(/42\.5|SAR/);
  });

  it('omits the benefit scene when there is nothing to say', () => {
    const script = buildScript({ ...PRODUCT, description: null, features: [] }, 15);
    expect(script.scenes.map((scene) => scene.kind)).not.toContain('BENEFIT');
    expect(script.omitted.join(' ')).toMatch(/no description or features/i);
  });

  it('shows a discount only when there genuinely is one', () => {
    const discounted = buildScript({ ...PRODUCT, price: 60, salePrice: 42.5 }, 15);
    const offer = discounted.scenes.find((scene) => scene.kind === 'OFFER');
    expect(offer?.subtext).toMatch(/was/i);

    const flat = buildScript({ ...PRODUCT, price: 42.5, salePrice: 42.5 }, 15);
    expect(flat.scenes.find((scene) => scene.kind === 'OFFER')?.subtext).toBeNull();
  });

  it('keeps every scene readable and none of them dead air', () => {
    for (const target of [5, 15, 30, 60]) {
      for (const scene of buildScript(PRODUCT, target).scenes) {
        expect(scene.durationSeconds).toBeGreaterThanOrEqual(1.4);
        expect(scene.durationSeconds).toBeLessThanOrEqual(6);
      }
    }
  });
});

describe('rendering an MP4', () => {
  whenFfmpeg('produces a playable H.264/AAC file at the placement size', async () => {
    const placement = videoPlacementByKey('TIKTOK_VIDEO')!;
    const script = buildScript(PRODUCT, 12);

    const rendered = await renderVideo({
      sources: [await wideSource()],
      scenes: script.scenes,
      placement,
      brand: BRAND,
    });

    expect(rendered.probe.videoCodec).toBe('h264');
    expect(rendered.probe.audioCodec).toBe('aac');
    expect(rendered.probe.hasVideo).toBe(true);
    expect(rendered.probe.hasAudio).toBe(true);
    expect(rendered.probe.width).toBe(1080);
    expect(rendered.probe.height).toBe(1920);
    expect(rendered.probe.frameRate).toBe(30);
    expect(rendered.buffer.byteLength).toBeGreaterThan(10_000);

    // An MP4 begins with a box-size word then 'ftyp'. A file that is not one
    // still downloads fine, which is exactly why this is checked.
    expect(rendered.buffer.subarray(4, 8).toString('ascii')).toBe('ftyp');
  });

  whenFfmpeg('recomposes rather than crops — checked against real video frames', async () => {
    const placement = videoPlacementByKey('INSTAGRAM_REEL')!;
    const script = buildScript(PRODUCT, 10);

    const rendered = await renderVideo({
      sources: [await wideSource()],
      scenes: script.scenes,
      placement,
      brand: BRAND,
    });

    // Every scene went through the adaptive engine and chose to rebuild the
    // canvas, keeping the whole source.
    expect(rendered.compositions.length).toBe(script.scenes.length);
    for (const composition of rendered.compositions) {
      expect(composition.strategy, composition.scene).toBe('EXTEND');
      expect(composition.retainedArea, composition.scene).toBe(1);
    }

    // And the pixels agree: pull a frame out of the finished MP4 and look.
    const dir = await mkdtemp(join(tmpdir(), 'mos-frame-'));
    try {
      const videoPath = join(dir, 'v.mp4');
      const framePath = join(dir, 'frame.png');
      await writeFile(videoPath, rendered.buffer);
      // One second in — past the opening cross-dissolve, inside a real scene.
      await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '1', '-i', videoPath, '-frames:v', '1', framePath]);

      const { data, info } = await sharp(await readFile(framePath)).raw().toBuffer({ resolveWithObject: true });
      let left = 0;
      let right = 0;

      for (let y = 0; y < info.height; y += 1) {
        for (let x = 0; x < info.width; x += 1) {
          const i = (y * info.width + x) * info.channels;
          const r = data[i] ?? 0;
          const g = data[i + 1] ?? 0;
          const b = data[i + 2] ?? 0;
          // The markers are magenta; the blurred background plate derived from
          // them is far less saturated, so the threshold separates the two.
          if (r > 140 && b > 140 && g < 110) {
            if (x < info.width / 2) left += 1;
            else right += 1;
          }
        }
      }

      // Both edge markers are present in the delivered video. A cover crop to
      // 9:16 keeps a ~607px column of a 1920px frame and cannot hold both.
      expect(left).toBeGreaterThan(300);
      expect(right).toBeGreaterThan(300);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  whenFfmpeg('renders each vertical placement at its own exact dimensions', async () => {
    const source = await wideSource();
    const script = buildScript(PRODUCT, 8);

    for (const key of ['TIKTOK_VIDEO', 'INSTAGRAM_FEED_VIDEO', 'YOUTUBE_LANDSCAPE']) {
      const placement = videoPlacementByKey(key)!;
      const rendered = await renderVideo({ sources: [source], scenes: script.scenes.slice(0, 3), placement, brand: BRAND });

      expect(rendered.probe.width, key).toBe(placement.width);
      expect(rendered.probe.height, key).toBe(placement.height);
    }
  });

  whenFfmpeg('mixes user-supplied audio into the track', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mos-audio-'));
    try {
      // A real WAV, generated rather than committed as a fixture.
      const audioPath = join(dir, 'tone.wav');
      await run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20', audioPath]);

      const placement = videoPlacementByKey('TIKTOK_VIDEO')!;
      const rendered = await renderVideo({
        sources: [await wideSource()],
        scenes: buildScript(PRODUCT, 8).scenes.slice(0, 2),
        placement,
        brand: BRAND,
        audio: { buffer: await readFile(audioPath), filename: 'tone.wav', volume: 0.6, fadeInSeconds: 0.3, fadeOutSeconds: 0.5 },
      });

      expect(rendered.probe.audioCodec).toBe('aac');
      expect(rendered.probe.hasAudio).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  whenFfmpeg('respects an operator’s edited script exactly', async () => {
    const placement = videoPlacementByKey('TIKTOK_VIDEO')!;
    const scenes = [
      { kind: 'HOOK' as const, text: 'Edited hook line', subtext: null, durationSeconds: 2, motion: 'STATIC' as const, from: ['operator'] },
      { kind: 'CTA' as const, text: 'Edited call to action', subtext: null, durationSeconds: 2, motion: 'ZOOM_IN' as const, from: ['operator'] },
    ];

    const rendered = await renderVideo({ sources: [await wideSource()], scenes, placement, brand: BRAND });

    // Two scenes, one 0.4s cross-dissolve: 2 + 2 − 0.4.
    expect(rendered.durationSeconds).toBeGreaterThan(3.3);
    expect(rendered.durationSeconds).toBeLessThan(4.1);
    expect(rendered.compositions.map((c) => c.scene)).toEqual(['HOOK', 'CTA']);
  });
});

describe('output validation', () => {
  whenFfmpeg('rejects a file that is not a real video', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mos-bad-'));
    try {
      const path = join(dir, 'not-a-video.mp4');
      // The failure mode this guards: a zero-length or truncated file that
      // downloads perfectly and plays nowhere.
      await writeFile(path, Buffer.from('this is not an mp4'));
      await expect(probe(path)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('placement registry', () => {
  it('covers every format the brief names, at the stated sizes', () => {
    const byKey = Object.fromEntries(VIDEO_PLACEMENTS.map((p) => [p.key, p]));

    expect(byKey.TIKTOK_VIDEO).toMatchObject({ width: 1080, height: 1920 });
    expect(byKey.INSTAGRAM_REEL).toMatchObject({ width: 1080, height: 1920 });
    expect(byKey.INSTAGRAM_STORY_VIDEO).toMatchObject({ width: 1080, height: 1920 });
    expect(byKey.INSTAGRAM_FEED_VIDEO).toMatchObject({ width: 1080, height: 1350 });
    expect(byKey.FACEBOOK_FEED_VIDEO).toMatchObject({ width: 1080, height: 1350 });
    expect(byKey.YOUTUBE_LANDSCAPE).toMatchObject({ width: 1920, height: 1080 });
  });

  it('reserves more of a vertical frame than a feed frame', () => {
    // Vertical placements put the caption, sound name and button column over the
    // picture, and the viewer cannot scroll them away.
    const reel = videoPlacementByKey('INSTAGRAM_REEL')!;
    const feed = videoPlacementByKey('INSTAGRAM_FEED_VIDEO')!;

    expect(reel.safeArea.bottom).toBeGreaterThan(feed.safeArea.bottom);
    expect(reel.safeArea.top).toBeGreaterThan(feed.safeArea.top);
  });
});

/**
 * The HTTP path, end to end: upload an image, render a video from it, stream it
 * back. Kept to one placement and a short script because the point is the route
 * wiring — storage, tenancy, range requests — not the renderer, which the cases
 * above cover thoroughly.
 */
describe('video routes', () => {
  it('renders, stores and streams a video, scoped to its tenant', async (context) => {
    if (!available) {
      context.skip();
      return;
    }

    const { Agent, agent, createTenant, prisma, resetDatabase } = await import('./helpers.js');
    void Agent;

    await resetDatabase();
    const alpha = await createTenant('alpha');
    const beta = await createTenant('beta');

    const admin = agent();
    await admin.login(alpha.adminEmail);
    const outsider = agent();
    await outsider.login(beta.adminEmail);

    const upload = await admin
      .post('/api/media')
      .field('clientId', alpha.clientId)
      .attach('files', await wideSource(), 'product.png');
    expect(upload.status).toBe(201);
    const mediaId = upload.body.items[0].id as string;

    const catalogue = await admin.get('/api/videos/placements');
    expect(catalogue.status).toBe(200);
    expect(catalogue.body.capability.available).toBe(true);

    const rendered = await admin.post('/api/videos', {
      mediaIds: [mediaId],
      placementKeys: ['TIKTOK_VIDEO'],
      scenes: [
        { kind: 'PRODUCT', text: 'Stone Oven Margherita', durationSeconds: 2, motion: 'STATIC' },
        { kind: 'CTA', text: 'Shop now', durationSeconds: 2, motion: 'ZOOM_IN' },
      ],
    });

    expect(rendered.status).toBe(201);
    const video = rendered.body.videos[0];
    expect(video.width).toBe(1080);
    expect(video.height).toBe(1920);
    expect(video.videoCodec).toBe('h264');
    expect(video.audioSource).toBe('NONE');
    expect(video.url).toBe(`/api/videos/${video.id}/file`);

    // Stored under the client's own prefix, like every other asset.
    const row = await prisma.videoCreative.findUniqueOrThrow({ where: { id: video.id } });
    expect(row.storageKey.startsWith(`clients/${alpha.clientId}/videos/`)).toBe(true);

    const streamed = await admin.get(`/api/videos/${video.id}/file`);
    expect(streamed.status).toBe(200);
    expect(streamed.headers['content-type']).toBe('video/mp4');
    expect(streamed.headers['accept-ranges']).toBe('bytes');

    // A <video> element issues a range request immediately; answering 200 with
    // the whole file makes every seek re-download from the start.
    const ranged = await admin.get(`/api/videos/${video.id}/file`).set('Range', 'bytes=0-1023');
    expect(ranged.status).toBe(206);
    expect(ranged.headers['content-range']).toMatch(/^bytes 0-1023\//);

    const downloaded = await admin.get(`/api/videos/${video.id}/download`);
    expect(downloaded.headers['content-disposition']).toMatch(/^attachment/);
    expect(downloaded.headers['x-video-dimensions']).toBe('1080x1920');

    // Another tenant cannot reach any of it.
    expect((await outsider.get(`/api/videos/${video.id}/file`)).status).toBe(404);
    expect((await outsider.get(`/api/videos/${video.id}/download`)).status).toBe(404);
    expect((await outsider.get('/api/videos')).body.videos).toHaveLength(0);
  }, 180_000);
});

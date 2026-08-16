/**
 * Uploading a finished advertisement, and being told where it can run.
 *
 * This is the product's primary path — the operator made the ad elsewhere and
 * this system runs it — so the assertions are mostly about *not* doing things:
 * not re-encoding the file, not trusting the Content-Type, not inventing a
 * measurement, and not calling a placement valid when nothing was measured.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { CreativeSource, Platform } from '@prisma/client';
import sharp from 'sharp';

import { agent, createTenant, prisma, resetDatabase, type Tenant } from './helpers.js';
import { sha256Of, sniffVideo, inspectMedia } from '../src/services/creative/inspect.js';
import { validateCreative, specByKey, validateForPlacement } from '../src/services/creative/specs.js';

/** A real JPEG of the requested shape, produced by libvips rather than faked. */
const jpeg = (width: number, height: number): Promise<Buffer> =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 80, b: 40 } } })
    .jpeg({ quality: 80 })
    .toBuffer();

const png = (width: number, height: number): Promise<Buffer> =>
  sharp({ create: { width, height, channels: 4, background: { r: 10, g: 120, b: 90, alpha: 1 } } })
    .png()
    .toBuffer();

describe('creative inspection', () => {
  it('measures an image from its bytes, not from what the caller claimed', async () => {
    const buffer = await jpeg(1080, 1350);
    // The caller lies about the type; the bytes decide.
    const result = await inspectMedia(buffer, 'image/png');

    expect(result.kind).toBe('IMAGE');
    expect(result.format).toBe('jpeg');
    expect(result.width).toBe(1080);
    expect(result.height).toBe(1350);
    expect(result.aspectRatio).toBeCloseTo(0.8, 2);
    expect(result.measured).toBe(true);
  });

  it('hashes the exact bytes, so the same file twice is the same digest', async () => {
    const a = await png(400, 400);
    const b = Buffer.from(a);
    expect(sha256Of(a)).toBe(sha256Of(b));
    expect(sha256Of(a)).toHaveLength(64);

    const different = await png(401, 400);
    expect(sha256Of(different)).not.toBe(sha256Of(a));
  });

  it('recognises real video containers and rejects a renamed text file', () => {
    // ISO base media: bytes 4-8 are ftyp, then the brand.
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(16)]);
    const mov = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  '), Buffer.alloc(16)]);
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(16)]);

    expect(sniffVideo(mp4)).toBe('mp4');
    expect(sniffVideo(mov)).toBe('mov');
    expect(sniffVideo(webm)).toBe('webm');
    expect(sniffVideo(Buffer.from('this is definitely not a video at all'))).toBeNull();
  });

  it('refuses a file that is neither image nor video, whatever it claims to be', async () => {
    await expect(inspectMedia(Buffer.from('#!/bin/sh\nrm -rf /'), 'image/jpeg')).rejects.toThrow(/neither a readable image nor a readable video/i);
  });
});

describe('placement validation', () => {
  const portrait = {
    kind: 'IMAGE' as const,
    mimeType: 'image/jpeg',
    sizeBytes: 1_800_000,
    width: 1080,
    height: 1350,
    aspectRatio: 0.8,
    durationSeconds: null,
    measured: true,
  };

  it('passes a 4:5 image for Instagram Feed', () => {
    const spec = specByKey('INSTAGRAM_FEED_IMAGE')!;
    const result = validateForPlacement(portrait, spec);
    expect(result.outcome).toBe('VALID');
    expect(result.blockingReason).toBeNull();
  });

  it('fails the same image for Story and says exactly why', () => {
    const spec = specByKey('INSTAGRAM_STORY')!;
    const result = validateForPlacement(portrait, spec);

    expect(result.outcome).toBe('INVALID');
    const ratio = result.checks.find((check) => check.key === 'aspectRatio')!;
    // Not merely "invalid": the operator is told what they have and what is needed.
    expect(ratio.actual).toBe('4:5');
    expect(ratio.required).toContain('9:16');
    expect(ratio.reason).toMatch(/9:16/);
  });

  it('reports an unmeasured video as unknown, never as valid', () => {
    const result = validateCreative(
      {
        kind: 'VIDEO',
        mimeType: 'video/mp4',
        sizeBytes: 5_000_000,
        width: null,
        height: null,
        aspectRatio: null,
        durationSeconds: null,
        measured: false,
      },
      Platform.TIKTOK,
    );

    expect(result.placements[0]?.outcome).toBe('UNKNOWN');
    expect(result.valid).toBe(0);
    const duration = result.placements[0]?.checks.find((check) => check.key === 'duration');
    expect(duration?.reason).toMatch(/FFmpeg/i);
  });

  it('rejects an image for a video-only placement', () => {
    const spec = specByKey('INSTAGRAM_REEL')!;
    const result = validateForPlacement(portrait, spec);
    expect(result.outcome).toBe('INVALID');
    expect(result.checks.find((check) => check.key === 'type')?.outcome).toBe('INVALID');
  });

  it('rejects an oversized file with both numbers stated', () => {
    const spec = specByKey('INSTAGRAM_FEED_IMAGE')!;
    const result = validateForPlacement({ ...portrait, sizeBytes: 60 * 1024 * 1024 }, spec);

    const size = result.checks.find((check) => check.key === 'fileSize')!;
    expect(size.outcome).toBe('INVALID');
    expect(size.actual).toBe('60.0 MB');
    expect(size.required).toContain('30.0 MB');
  });

  it('rejects an image below the minimum dimensions', () => {
    const spec = specByKey('FACEBOOK_FEED_IMAGE')!;
    const result = validateForPlacement({ ...portrait, width: 320, height: 400 }, spec);
    expect(result.checks.find((check) => check.key === 'dimensions')?.outcome).toBe('INVALID');
  });

  it('carries the source and verification date on every placement', () => {
    for (const row of validateCreative(portrait).placements) {
      expect(row.sourceUrl).toMatch(/^https:\/\//);
      expect(row.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('creative upload route', () => {
  let alpha: Tenant;
  let beta: Tenant;

  beforeAll(async () => {
    await resetDatabase();
    alpha = await createTenant('upload-alpha');
    beta = await createTenant('upload-beta');
  });

  const admin = async (tenant: Tenant) => {
    const client = agent();
    await client.login(tenant.adminEmail);
    return client;
  };

  it('accepts a finished ad and stores it byte for byte', async () => {
    const buffer = await jpeg(1080, 1350);
    const client = await admin(alpha);

    const response = await client
      .post('/api/creatives/upload')
      .field('clientId', alpha.clientId)
      .field('platform', Platform.INSTAGRAM)
      .attach('file', buffer, 'burger-ad.jpg');

    expect(response.status).toBe(201);
    expect(response.body.creative.source).toBe(CreativeSource.UPLOADED);
    // The upload is the creative: nothing was rendered from something else.
    expect(response.body.creative.sourceMediaId).toBeNull();
    expect(response.body.creative.preset).toBe('UPLOADED');
    expect(response.body.media.sha256).toBe(sha256Of(buffer));
    expect(response.body.media.sizeBytes).toBe(buffer.byteLength);
    expect(response.body.inspected.width).toBe(1080);
    expect(response.body.inspected.height).toBe(1350);
  });

  it('answers with the placement matrix immediately', async () => {
    const buffer = await jpeg(1080, 1350);
    const client = await admin(alpha);

    const response = await client
      .post('/api/creatives/upload')
      .field('clientId', alpha.clientId)
      .attach('file', buffer, 'again.jpg');

    const instagramFeed = response.body.validation.placements.find(
      (row: { placement: string }) => row.placement === 'INSTAGRAM_FEED_IMAGE',
    );
    const story = response.body.validation.placements.find(
      (row: { placement: string }) => row.placement === 'INSTAGRAM_STORY',
    );

    expect(instagramFeed.outcome).toBe('VALID');
    expect(story.outcome).toBe('INVALID');
  });

  it('recognises a re-upload of the same file instead of duplicating it', async () => {
    const buffer = await png(800, 800);
    const client = await admin(alpha);

    const first = await client
      .post('/api/creatives/upload')
      .field('clientId', alpha.clientId)
      .attach('file', buffer, 'square.png');
    const second = await client
      .post('/api/creatives/upload')
      .field('clientId', alpha.clientId)
      .attach('file', buffer, 'square-copy.png');

    expect(second.body.duplicateOf).not.toBeNull();
    // One asset, two creatives that both point at it.
    expect(second.body.media.id).toBe(first.body.media.id);
    expect(second.body.creative.id).not.toBe(first.body.creative.id);
  });

  it('never lets one tenant upload against another tenant\'s restaurant', async () => {
    const buffer = await jpeg(600, 600);
    const client = await admin(alpha);

    const response = await client
      .post('/api/creatives/upload')
      .field('clientId', beta.clientId)
      .attach('file', buffer, 'intruder.jpg');

    expect(response.status).toBe(404);
  });

  it('rejects a text file dressed up as a JPEG', async () => {
    const client = await admin(alpha);
    const response = await client
      .post('/api/creatives/upload')
      .field('clientId', alpha.clientId)
      .attach('file', Buffer.from('not an image'), { filename: 'evil.jpg', contentType: 'image/jpeg' });

    expect(response.status).toBe(400);
  });

  it('re-validates from the stored bytes on demand', async () => {
    const buffer = await jpeg(1920, 1080);
    const client = await admin(alpha);

    const uploaded = await client
      .post('/api/creatives/upload')
      .field('clientId', alpha.clientId)
      .attach('file', buffer, 'landscape.jpg');

    const validated = await client.get(`/api/creatives/${uploaded.body.creative.id}/validate`);

    expect(validated.status).toBe(200);
    expect(validated.body.inspected.width).toBe(1920);
    const story = validated.body.validation.placements.find(
      (row: { placement: string }) => row.placement === 'INSTAGRAM_STORY',
    );
    // 16:9 cannot run as a Story, and the answer is re-measured, not remembered.
    expect(story.outcome).toBe('INVALID');
  });

  it('serves the spec catalogue so nothing downstream hardcodes a limit', async () => {
    const client = await admin(alpha);
    const response = await client.get('/api/creatives/specs?platform=INSTAGRAM');

    expect(response.status).toBe(200);
    expect(response.body.specs.length).toBeGreaterThan(0);
    expect(response.body.specs.every((spec: { platform: string }) => spec.platform === 'INSTAGRAM')).toBe(true);
  });

  it('leaves the existing rendered-creative path untouched', async () => {
    // The regression that matters: Creative.source defaults to RENDERED, so
    // every row the render pipeline writes keeps its old meaning.
    const media = await prisma.media.create({
      data: {
        organizationId: alpha.organizationId,
        clientId: alpha.clientId,
        type: 'IMAGE',
        filename: 'legacy-key',
        originalName: 'legacy.png',
        mimeType: 'image/png',
        sizeBytes: 1000,
        url: '/api/media/legacy/file',
      },
    });

    const creative = await prisma.creative.create({
      data: {
        organizationId: alpha.organizationId,
        clientId: alpha.clientId,
        sourceMediaId: media.id,
        platform: Platform.INSTAGRAM,
        preset: 'INSTAGRAM_PORTRAIT',
        width: 1080,
        height: 1350,
        storageKey: 'legacy-creative-key',
        url: '/api/creatives/legacy/file',
        sizeBytes: 2000,
      },
    });

    expect(creative.source).toBe(CreativeSource.RENDERED);
    expect(creative.sourceMediaId).toBe(media.id);
  });
});

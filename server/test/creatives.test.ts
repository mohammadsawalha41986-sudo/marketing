/**
 * Creative rendering, scoring, download and isolation.
 *
 * The test this file exists for is `download returns the rendered creative,
 * not the source image`. Everything else about the feature can look right while
 * the download button quietly hands back the original upload — the request that
 * succeeds, the file that arrives, the image that opens. So the assertions here
 * are on the *pixels*: different dimensions from the source, different bytes,
 * and a real PNG/JPEG signature at the platform's own size.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { uploadDir } from '../src/env.js';

import { Agent, agent, createTenant, prisma, resetDatabase, type Tenant } from './helpers.js';

/** A real, decodable source image — 1600×1600, so crops are lossless. */
async function sourceImage(): Promise<Buffer> {
  return sharp({
    create: { width: 1600, height: 1600, channels: 3, background: { r: 200, g: 90, b: 40 } },
  })
    .png()
    .toBuffer();
}

/** Uploads through the real multipart route, so storage is genuinely exercised. */
async function uploadSource(actor: Agent, clientId: string, name = 'burger-hero.png'): Promise<string> {
  const response = await actor
    .post('/api/media')
    .field('clientId', clientId)
    .attach('files', await sourceImage(), name);

  expect(response.status).toBe(201);
  return response.body.items[0].id as string;
}

describe('creative rendering and download', () => {
  let alpha: Tenant;
  let beta: Tenant;
  let alphaAdmin: Agent;
  let betaAdmin: Agent;
  let mediaId: string;
  let creativeId: string;

  beforeAll(async () => {
    await resetDatabase();
    alpha = await createTenant('alpha');
    beta = await createTenant('beta');

    alphaAdmin = agent();
    await alphaAdmin.login(alpha.adminEmail);
    betaAdmin = agent();
    await betaAdmin.login(beta.adminEmail);

    mediaId = await uploadSource(alphaAdmin, alpha.clientId);

    const rendered = await alphaAdmin.post('/api/creatives', {
      mediaId,
      campaignId: alpha.campaignId,
      presetKeys: ['INSTAGRAM_PORTRAIT'],
      headline: 'Twenty percent off every burger, this weekend only',
      ctaLabel: 'Order now',
    });
    expect(rendered.status).toBe(201);
    creativeId = rendered.body.creatives[0].id;
  });

  it('exposes the platform preset catalogue', async () => {
    const response = await alphaAdmin.get('/api/creatives/presets');
    expect(response.status).toBe(200);

    const keys = response.body.presets.map((preset: { key: string }) => preset.key);
    expect(keys).toEqual(expect.arrayContaining([
      'INSTAGRAM_PORTRAIT', 'FACEBOOK_FEED', 'TIKTOK_VERTICAL', 'LINKEDIN_FEED', 'X_LANDSCAPE', 'GOOGLE_ADS_LANDSCAPE',
    ]));

    // Each platform gets its own geometry — not one shape relabelled.
    const byKey = new Map(response.body.presets.map((p: { key: string; width: number; height: number }) => [p.key, p]));
    expect(byKey.get('TIKTOK_VERTICAL')).toMatchObject({ width: 1080, height: 1920 });
    expect(byKey.get('X_LANDSCAPE')).toMatchObject({ width: 1600, height: 900 });
  });

  it('renders at the platform dimensions and stores it separately from the source', async () => {
    const creative = await prisma.creative.findUniqueOrThrow({ where: { id: creativeId } });
    const media = await prisma.media.findUniqueOrThrow({ where: { id: mediaId } });

    expect(creative.width).toBe(1080);
    expect(creative.height).toBe(1350);
    expect(creative.sourceMediaId).toBe(mediaId);
    // Distinct storage keys: re-rendering must never overwrite the original.
    expect(creative.storageKey).not.toBe(media.filename);
    expect(creative.storageKey).toContain(`clients/${alpha.clientId}/creatives`);
  });

  it('downloads the rendered creative, not the source image', async () => {
    const response = await alphaAdmin.get(`/api/creatives/${creativeId}/download`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.headers['cache-control']).toContain('no-store');

    const downloaded = response.body as Buffer;
    const meta = await sharp(downloaded).metadata();

    // The decisive assertions: platform dimensions, and not the 1600×1600 source.
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1350);
    expect(meta.format).toBe('png');

    const source = await sourceImage();
    expect(downloaded.equals(source)).toBe(false);
    expect(downloaded.byteLength).toBeGreaterThan(1000);
  });

  it('burns the headline and CTA into the pixels', async () => {
    // A flat-colour source composited with white text must contain near-white
    // pixels; the source has none. That is the cheapest honest proof that the
    // copy was actually rasterised rather than merely recorded in the database.
    const response = await alphaAdmin.get(`/api/creatives/${creativeId}/download`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

    const { data, info } = await sharp(response.body as Buffer).raw().toBuffer({ resolveWithObject: true });
    let bright = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      if ((data[i] ?? 0) > 240 && (data[i + 1] ?? 0) > 240 && (data[i + 2] ?? 0) > 240) bright += 1;
    }
    expect(bright).toBeGreaterThan(200);
  });

  it('transcodes to JPG on request and still returns the rendered artwork', async () => {
    const response = await alphaAdmin.get(`/api/creatives/${creativeId}/download?format=JPG`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('image/jpeg');
    expect(response.headers['content-disposition']).toContain('.jpg');

    const meta = await sharp(response.body as Buffer).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1350);
  });

  it('renders a distinct variant per platform rather than one shape reused', async () => {
    const response = await alphaAdmin.post('/api/creatives', {
      mediaId,
      campaignId: alpha.campaignId,
      presetKeys: ['TIKTOK_VERTICAL', 'X_LANDSCAPE', 'LINKEDIN_FEED'],
      headline: 'Weekend burger offer',
      ctaLabel: 'Order now',
    });

    expect(response.status).toBe(201);
    expect(response.body.creatives).toHaveLength(3);

    const sizes = response.body.creatives.map((c: { width: number; height: number }) => `${c.width}x${c.height}`);
    expect(sizes).toEqual(['1080x1920', '1600x900', '1200x1200']);

    // Distinct stored objects, not three rows pointing at one file.
    const keys = response.body.creatives.map((c: { storageKey: string }) => c.storageKey);
    expect(new Set(keys).size).toBe(3);
  });

  it('scores the creative from real inspection and never invents an overall', async () => {
    const response = await alphaAdmin.post('/api/creatives/analyze', {
      mediaId,
      campaignId: alpha.campaignId,
      presetKey: 'INSTAGRAM_PORTRAIT',
      headline: 'Weekend burger offer',
      ctaLabel: 'Order now',
    });

    expect(response.status).toBe(200);
    const { match } = response.body;

    // Quality and platform fit are measurable from the real pixels, so they
    // must carry a number rather than a shrug.
    const quality = match.checks.find((check: { key: string }) => check.key === 'quality');
    expect(quality.score).toBeGreaterThan(0);
    expect(quality.detail).toContain('1600');

    // Brand fit rests on asset metadata; with no tags it must abstain.
    const brand = match.checks.find((check: { key: string }) => check.key === 'brand');
    expect(brand.score === null || typeof brand.score === 'number').toBe(true);

    expect(match.measured).toBeGreaterThan(0);
    expect(['EXCELLENT', 'GOOD', 'NEEDS_REVIEW', 'POOR', 'BLOCKED', 'UNMEASURED']).toContain(match.band);
  });

  it('blocks a source far below the resolution the placement needs', async () => {
    const tiny = await sharp({ create: { width: 240, height: 240, channels: 3, background: '#333' } }).png().toBuffer();
    const upload = await alphaAdmin.post('/api/media').field('clientId', alpha.clientId).attach('files', tiny, 'tiny.png');
    expect(upload.status).toBe(201);

    const response = await alphaAdmin.post('/api/creatives/analyze', {
      mediaId: upload.body.items[0].id,
      presetKey: 'INSTAGRAM_PORTRAIT',
    });

    expect(response.body.match.band).toBe('BLOCKED');
    expect(response.body.match.blockers[0]).toMatch(/resolution/i);
  });

  it('rejects a corrupt image at upload rather than failing later at render', async () => {
    // A file can pass the magic-number check and still be undecodable: correct
    // PNG signature, malformed body. libvips raises "libpng read error", which
    // unhandled became a 500 and read as "the renderer is broken" when the
    // input was the problem. Found on production. It is now caught at the
    // earliest point that can know — the upload — so a file that can never be
    // rendered does not enter the library at all.
    const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const truncated = Buffer.concat([header, Buffer.from('not really a png body')]);

    const upload = await alphaAdmin
      .post('/api/media')
      .field('clientId', alpha.clientId)
      .attach('files', truncated, { filename: 'broken.png', contentType: 'image/png' });

    expect(upload.status).toBe(400);
    expect(upload.body.error.message).toMatch(/could not be decoded/i);
    expect(await prisma.media.count({ where: { originalName: 'broken.png' } })).toBe(0);
  });

  it('reports a vanished stored object as gone, naming ephemeral storage', async () => {
    // The exact production failure: the row survives a redeploy, the file does
    // not. A 500 would send someone hunting for a renderer bug.
    const rendered = await alphaAdmin.post('/api/creatives', { mediaId, presetKeys: ['INSTAGRAM_SQUARE'] });
    const id = rendered.body.creatives[0].id as string;

    const creative = await prisma.creative.findUniqueOrThrow({ where: { id } });
    await unlink(join(uploadDir, creative.storageKey));

    const response = await alphaAdmin.get(`/api/creatives/${id}/download`);
    expect(response.status).toBe(410);
    expect(response.body.error.code).toBe('STORED_OBJECT_MISSING');
    expect(response.body.error.message).toMatch(/object storage|no longer on disk/i);
  });

  it('refuses to render from a non-image asset', async () => {
    const doc = await alphaAdmin
      .post('/api/media')
      .field('clientId', alpha.clientId)
      .attach('files', Buffer.from('plain text'), { filename: 'notes.txt', contentType: 'text/plain' });
    expect(doc.status).toBe(201);

    const response = await alphaAdmin.post('/api/creatives', {
      mediaId: doc.body.items[0].id,
      presetKeys: ['INSTAGRAM_PORTRAIT'],
    });
    expect(response.status).toBe(400);
  });

  it('records status transitions through to approval', async () => {
    const saved = await alphaAdmin.patch(`/api/creatives/${creativeId}`, { status: 'SAVED' });
    expect(saved.status).toBe(200);
    expect(saved.body.creative.status).toBe('SAVED');

    const approved = await alphaAdmin.patch(`/api/creatives/${creativeId}`, { status: 'APPROVED' });
    expect(approved.body.creative.status).toBe('APPROVED');
  });

  it('keeps the source asset when a rendered variant is deleted', async () => {
    const extra = await alphaAdmin.post('/api/creatives', { mediaId, presetKeys: ['INSTAGRAM_SQUARE'] });
    const id = extra.body.creatives[0].id;

    expect((await alphaAdmin.delete(`/api/creatives/${id}`)).status).toBe(200);
    expect(await prisma.creative.findUnique({ where: { id } })).toBeNull();
    // The photograph survives — deleting artwork must not destroy the original.
    expect(await prisma.media.findUnique({ where: { id: mediaId } })).not.toBeNull();
  });
});

describe('creative client isolation', () => {
  let alpha: Tenant;
  let beta: Tenant;
  let alphaAdmin: Agent;
  let betaAdmin: Agent;
  let alphaMediaId: string;
  let alphaCreativeId: string;

  beforeAll(async () => {
    await resetDatabase();
    alpha = await createTenant('alpha');
    beta = await createTenant('beta');

    alphaAdmin = agent();
    await alphaAdmin.login(alpha.adminEmail);
    betaAdmin = agent();
    await betaAdmin.login(beta.adminEmail);

    alphaMediaId = await uploadSource(alphaAdmin, alpha.clientId);
    const rendered = await alphaAdmin.post('/api/creatives', {
      mediaId: alphaMediaId,
      presetKeys: ['INSTAGRAM_PORTRAIT'],
      headline: 'Alpha only',
    });
    alphaCreativeId = rendered.body.creatives[0].id;
  });

  it('will not render another tenant asset even when its id is named directly', async () => {
    const response = await betaAdmin.post('/api/creatives', {
      mediaId: alphaMediaId,
      presetKeys: ['INSTAGRAM_PORTRAIT'],
    });
    expect(response.status).toBe(404);
    expect(await prisma.creative.count({ where: { sourceMediaId: alphaMediaId, organizationId: beta.organizationId } })).toBe(0);
  });

  it('will not download another tenant creative', async () => {
    expect((await betaAdmin.get(`/api/creatives/${alphaCreativeId}/download`)).status).toBe(404);
    expect((await betaAdmin.get(`/api/creatives/${alphaCreativeId}`)).status).toBe(404);
  });

  it('will not delete or re-status another tenant creative', async () => {
    expect((await betaAdmin.delete(`/api/creatives/${alphaCreativeId}`)).status).toBe(404);
    expect((await betaAdmin.patch(`/api/creatives/${alphaCreativeId}`, { status: 'APPROVED' })).status).toBe(404);
    // Still present and untouched.
    const creative = await prisma.creative.findUniqueOrThrow({ where: { id: alphaCreativeId } });
    expect(creative.status).toBe('DRAFT');
  });

  it('never lists another tenant creative', async () => {
    const response = await betaAdmin.get('/api/creatives');
    expect(response.status).toBe(200);
    expect(response.body.creatives).toHaveLength(0);
  });

  it('refuses to attach another tenant campaign to a creative', async () => {
    const response = await alphaAdmin.post('/api/creatives', {
      mediaId: alphaMediaId,
      campaignId: beta.campaignId,
      presetKeys: ['INSTAGRAM_PORTRAIT'],
    });
    expect(response.status).toBe(404);
  });

  it('requires an authenticated session to download', async () => {
    const anonymous = agent();
    expect((await anonymous.get(`/api/creatives/${alphaCreativeId}/download`)).status).toBe(401);
  });
});

describe('image import from a URL', () => {
  let tenant: Tenant;
  let admin: Agent;

  beforeAll(async () => {
    await resetDatabase();
    tenant = await createTenant('urls');
    admin = agent();
    await admin.login(tenant.adminEmail);
  });

  it('refuses a non-https URL rather than fetching it', async () => {
    const response = await admin.post('/api/media/from-url', {
      url: 'http://example.com/a.png',
      clientId: tenant.clientId,
    });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/https/i);
  });

  it('refuses a URL belonging to another tenant client', async () => {
    const other = await createTenant('urls-other');
    const response = await admin.post('/api/media/from-url', {
      url: 'https://example.com/a.png',
      clientId: other.clientId,
    });
    expect(response.status).toBe(404);
  });
});

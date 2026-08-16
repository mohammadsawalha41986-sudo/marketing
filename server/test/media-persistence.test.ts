/**
 * Media persistence, end to end through the HTTP routes.
 *
 * The storage driver tests prove the bucket adapter is correct in isolation.
 * These prove the *application* stopped depending on the container filesystem:
 * that every URL it hands the browser resolves through the storage layer, that
 * one tenant cannot fetch another's bytes, and that deleting a row does not
 * delete an object another row is still using.
 *
 * The disk driver is what runs under test, and that is deliberate — the point
 * is that no route reaches for a path, so the same code works whichever driver
 * is mounted. The bucket-specific behaviour is covered in storage.test.ts.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';

import { Agent, agent, createTenant, prisma, resetDatabase, type Tenant } from './helpers.js';
import { storage } from '../src/services/storage/index.js';

async function image(seed: number): Promise<Buffer> {
  return sharp({ create: { width: 800, height: 600, channels: 3, background: { r: seed, g: 120, b: 200 } } })
    .png()
    .toBuffer();
}

describe('media is addressed by key, never by path', () => {
  let alpha: Tenant;
  let beta: Tenant;
  let alphaAdmin: Agent;
  let betaAdmin: Agent;
  let mediaId: string;

  beforeAll(async () => {
    await resetDatabase();
    alpha = await createTenant('alpha');
    beta = await createTenant('beta');

    alphaAdmin = agent();
    await alphaAdmin.login(alpha.adminEmail);
    betaAdmin = agent();
    await betaAdmin.login(beta.adminEmail);

    const upload = await alphaAdmin
      .post('/api/media')
      .field('clientId', alpha.clientId)
      .attach('files', await image(210), 'hero.png');
    expect(upload.status).toBe(201);
    mediaId = upload.body.items[0].id;
  });

  it('stores the object under the owning client, so the bucket carries the tenant boundary', async () => {
    const media = await prisma.media.findUniqueOrThrow({ where: { id: mediaId } });
    expect(media.filename.startsWith(`clients/${alpha.clientId}/assets/`)).toBe(true);
    // Content-addressed, and stable: no date segment to make the same bytes
    // land on a second object next month.
    expect(media.filename).toMatch(/\/[0-9a-f]{32}\.png$/);
  });

  it('hands the browser an application URL rather than a storage location', async () => {
    const media = await prisma.media.findUniqueOrThrow({ where: { id: mediaId } });

    // The stored URL itself is right, not merely the serialized one — five
    // different routes embed Media rows, and only one of them was rewriting.
    expect(media.url).toBe(`/api/media/${mediaId}/file`);
    expect(media.thumbnailUrl).toBe(`/api/media/${mediaId}/file`);

    const listed = await alphaAdmin.get('/api/media');
    expect(listed.body.items[0].url).toBe(`/api/media/${mediaId}/file`);
  });

  it('serves the bytes back through the storage layer', async () => {
    const response = await alphaAdmin.get(`/api/media/${mediaId}/file`);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['cache-control']).toBe('private, max-age=300');

    const meta = await sharp(response.body).metadata();
    expect(meta.width).toBe(800);
    expect(meta.height).toBe(600);
  });

  it('will not serve one tenant the other tenant’s file', async () => {
    const response = await betaAdmin.get(`/api/media/${mediaId}/file`);
    expect(response.status).toBe(404);
  });

  it('requires a session at all', async () => {
    const response = await agent().get(`/api/media/${mediaId}/file`);
    expect(response.status).toBe(401);
  });

  it('reports a reference whose object has gone as 410, not 500', async () => {
    const upload = await alphaAdmin
      .post('/api/media')
      .field('clientId', alpha.clientId)
      .attach('files', await image(90), 'doomed.png');
    const doomedId = upload.body.items[0].id as string;
    const { filename } = await prisma.media.findUniqueOrThrow({ where: { id: doomedId } });

    // Exactly what a redeploy does to the local driver: the row survives, the
    // bytes do not.
    await storage.delete(filename);

    const response = await alphaAdmin.get(`/api/media/${doomedId}/file`);
    expect(response.status).toBe(410);
    expect(response.body.error.code).toBe('STORED_OBJECT_MISSING');
  });
});

describe('deleting media', () => {
  let alpha: Tenant;
  let admin: Agent;

  beforeAll(async () => {
    await resetDatabase();
    alpha = await createTenant('alpha');
    admin = agent();
    await admin.login(alpha.adminEmail);
  });

  it('removes the object once nothing references it', async () => {
    const upload = await admin
      .post('/api/media')
      .field('clientId', alpha.clientId)
      .attach('files', await image(31), 'solo.png');
    const id = upload.body.items[0].id as string;
    const { filename } = await prisma.media.findUniqueOrThrow({ where: { id } });

    expect(await storage.exists!(filename)).toBe(true);

    const deleted = await admin.delete(`/api/media/${id}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.object).toBe('deleted');
    // No orphan left in storage, and no row left pointing at one.
    expect(await storage.exists!(filename)).toBe(false);
  });

  it('keeps the object while another row still shares it', async () => {
    // The same picture uploaded twice: content addressing gives both rows one
    // object, so deleting either must not pull the bytes out from under the
    // other. Before the reference count, the second row became a dead link.
    const bytes = await image(77);
    const first = await admin.post('/api/media').field('clientId', alpha.clientId).attach('files', bytes, 'twin.png');
    const second = await admin.post('/api/media').field('clientId', alpha.clientId).attach('files', bytes, 'twin.png');

    const firstId = first.body.items[0].id as string;
    const secondId = second.body.items[0].id as string;

    const a = await prisma.media.findUniqueOrThrow({ where: { id: firstId } });
    const b = await prisma.media.findUniqueOrThrow({ where: { id: secondId } });
    expect(a.filename).toBe(b.filename);

    const deleted = await admin.delete(`/api/media/${firstId}`);
    expect(deleted.body.object).toBe('still-referenced');
    expect(await storage.exists!(a.filename)).toBe(true);

    // The survivor still resolves.
    expect((await admin.get(`/api/media/${secondId}/file`)).status).toBe(200);

    // And once it goes too, the object goes with it.
    const last = await admin.delete(`/api/media/${secondId}`);
    expect(last.body.object).toBe('deleted');
    expect(await storage.exists!(a.filename)).toBe(false);
  });
});

describe('brand logos', () => {
  let alpha: Tenant;
  let admin: Agent;

  beforeAll(async () => {
    await resetDatabase();
    alpha = await createTenant('alpha');
    admin = agent();
    await admin.login(alpha.adminEmail);
  });

  it('reads the logo back through storage rather than from disk', async () => {
    const upload = await admin
      .post(`/api/brands/${alpha.clientId}/logo`)
      .attach('file', await image(160), 'logo.png');
    expect(upload.status).toBe(201);

    const brand = await prisma.brand.findUniqueOrThrow({ where: { clientId: alpha.clientId } });
    // The key is what the server needs; the URL is what the browser needs. The
    // old code kept only the URL and then tried to turn it back into a path.
    expect(brand.logoKey).toBeTruthy();
    expect(brand.logoUrl).toBe(`/api/brands/${alpha.clientId}/logo`);

    const served = await admin.get(`/api/brands/${alpha.clientId}/logo`);
    expect(served.status).toBe(200);
    expect((await sharp(served.body).metadata()).width).toBe(800);

    // Re-extracting the palette used to require the disk driver; it now works
    // against whatever storage is mounted.
    const suggested = await admin.post(`/api/brands/${alpha.clientId}/palette/suggest`);
    expect(suggested.status).toBe(200);
    expect(suggested.body.suggested).toBeTruthy();
  });
});

/**
 * Storage diagnostics.
 *
 * This endpoint exists so an acceptance test can ask "is this object really in
 * the bucket" for a key the database may never have seen. That power is exactly
 * why the tenant check on it matters: object keys carry the client id, so a
 * probe against another agency's key must be refused even though the answer is
 * only a size and a digest.
 */
describe('storage diagnostics', () => {
  let alpha: Tenant;
  let beta: Tenant;
  let admin: Agent;
  let outsider: Agent;
  let key: string;

  beforeAll(async () => {
    await resetDatabase();
    alpha = await createTenant('alpha');
    beta = await createTenant('beta');
    admin = agent();
    await admin.login(alpha.adminEmail);
    outsider = agent();
    await outsider.login(beta.adminEmail);

    const upload = await admin
      .post('/api/media')
      .field('clientId', alpha.clientId)
      .attach('files', await image(64), 'diag.png');
    const media = await prisma.media.findUniqueOrThrow({ where: { id: upload.body.items[0].id } });
    key = media.filename;
  });

  it('reports the driver and confirms an object by digest', async () => {
    const response = await admin.get(`/api/storage/diagnostics?key=${encodeURIComponent(key)}`);

    expect(response.status).toBe(200);
    expect(response.body.driver).toBe(storage.name);
    expect(response.body.object.exists).toBe(true);
    expect(response.body.object.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(response.body.object.sizeBytes).toBeGreaterThan(0);
  });

  it('never returns credentials, only whether they are set', async () => {
    const response = await admin.get(`/api/storage/diagnostics?key=${encodeURIComponent(key)}`);
    const body = JSON.stringify(response.body);

    // The variable *names* appear — that is the report. The values must not.
    expect(typeof response.body.variables.S3_ACCESS_KEY_ID).toBe('boolean');
    expect(typeof response.body.variables.S3_SECRET_ACCESS_KEY).toBe('boolean');

    for (const name of ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
      const value = process.env[name];
      if (value) expect(body).not.toContain(value);
    }

    // A digest of the object, never the object.
    expect(response.body.object.content).toBeUndefined();
  });

  it('says plainly when an object is missing rather than erroring', async () => {
    const response = await admin.get(
      `/api/storage/diagnostics?key=${encodeURIComponent(`clients/${alpha.clientId}/assets/deadbeef.png`)}`,
    );

    expect(response.status).toBe(200);
    expect(response.body.object.exists).toBe(false);
    expect(response.body.object.sha256).toBeNull();
  });

  it('refuses a probe against another organisation’s key', async () => {
    const response = await outsider.get(`/api/storage/diagnostics?key=${encodeURIComponent(key)}`);
    expect(response.status).toBe(403);
  });

  it('requires the owner to ask about storage in general', async () => {
    // With no key there is no tenant to scope to, so the unscoped form stays
    // owner-only.
    expect((await admin.get('/api/storage/diagnostics')).status).toBe(403);
  });
});

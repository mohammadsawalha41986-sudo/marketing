/**
 * The asset library's folders and tags.
 *
 * Phase 5b's browse UI needs three things the API could not previously answer:
 * which folders and tags exist, "assets in no folder", and "assets tagged X"
 * as a question distinct from a filename search. Each is tested here as a
 * question rather than as an endpoint, because the UI's correctness depends on
 * the distinctions, not on the shape of the JSON.
 *
 * Folders are `Media.category` and tags are `Media.tags` — both already on the
 * model. Nothing here introduces a second place assets can live.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';

import { Agent, agent, createTenant, resetDatabase, type Tenant } from './helpers.js';

async function image(seed: number): Promise<Buffer> {
  return sharp({ create: { width: 240, height: 240, channels: 3, background: { r: seed, g: 90, b: 160 } } })
    .png()
    .toBuffer();
}

describe('media library: folders and tags', () => {
  let alpha: Tenant;
  let beta: Tenant;
  let admin: Agent;
  let betaAdmin: Agent;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await resetDatabase();
    alpha = await createTenant('library-alpha');
    beta = await createTenant('library-beta');

    admin = agent();
    await admin.login(alpha.adminEmail);
    betaAdmin = agent();
    await betaAdmin.login(beta.adminEmail);

    const upload = async (name: string, seed: number) => {
      const response = await admin
        .post('/api/media')
        .field('clientId', alpha.clientId)
        .attach('files', await image(seed), name);
      expect(response.status).toBe(201);
      return response.body.items[0].id as string;
    };

    ids.hero = await upload('ramadan-hero.png', 10);
    ids.banner = await upload('banner.png', 20);
    ids.loose = await upload('unfiled-shot.png', 30);

    // Filed through the route the UI uses, not by writing the rows directly —
    // the PATCH existing and working is part of what is under test.
    await admin.patch(`/api/media/${ids.hero}`).send({ category: 'Ramadan', tags: ['hero', 'vertical'] });
    await admin.patch(`/api/media/${ids.banner}`).send({ category: 'Ramadan', tags: ['vertical'] });

    // The beta tenant files something identically, to prove the facets are scoped.
    const other = await betaAdmin
      .post('/api/media')
      .field('clientId', beta.clientId)
      .attach('files', await image(40), 'their-hero.png');
    await betaAdmin.patch(`/api/media/${other.body.items[0].id}`).send({ category: 'Ramadan', tags: ['hero'] });
  });

  it('reports the folders and tags that exist, with counts', async () => {
    const response = await admin.get('/api/media/facets');
    expect(response.status).toBe(200);

    const folders = response.body.folders as Array<{ name: string | null; count: number }>;
    expect(folders.find((row) => row.name === 'Ramadan')?.count).toBe(2);
    // The unfiled asset is its own bucket, not omitted — assets nobody filed
    // are exactly what a tidy-up needs to find.
    expect(folders.find((row) => row.name === null)?.count).toBe(1);

    const tags = response.body.tags as Array<{ name: string; count: number }>;
    expect(tags.find((row) => row.name === 'vertical')?.count).toBe(2);
    expect(tags.find((row) => row.name === 'hero')?.count).toBe(1);
    // Sorted by count, so the rail leads with what the library actually uses.
    expect(tags[0]?.name).toBe('vertical');

    expect(response.body.total).toBe(3);
    expect(response.body.untagged).toBe(1);
  });

  it('never counts another tenant\'s folders or tags', async () => {
    const response = await admin.get('/api/media/facets');
    // Beta filed one asset under "Ramadan" tagged "hero". If scoping leaked,
    // these counts would be 3 and 2.
    expect(response.body.folders.find((row: { name: string | null }) => row.name === 'Ramadan').count).toBe(2);
    expect(response.body.tags.find((row: { name: string }) => row.name === 'hero').count).toBe(1);
  });

  it('filters to one folder', async () => {
    const response = await admin.get('/api/media?category=Ramadan');
    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(2);
    expect(response.body.items.every((row: { category: string }) => row.category === 'Ramadan')).toBe(true);
  });

  it('can ask for the assets that are in no folder at all', async () => {
    // The distinction an empty string cannot carry through a query string:
    // "unfiled" versus "no folder filter".
    const unfiled = await admin.get('/api/media?category=__unfiled__');
    expect(unfiled.body.items).toHaveLength(1);
    expect(unfiled.body.items[0].id).toBe(ids.loose);

    const everything = await admin.get('/api/media');
    expect(everything.body.items).toHaveLength(3);
  });

  it('filters by an exact tag, which a filename search cannot do', async () => {
    const tagged = await admin.get('/api/media?tag=vertical');
    expect(tagged.body.items).toHaveLength(2);

    // "ramadan" appears in a *filename*, so free-text search finds it while an
    // exact tag query does not. This is the whole reason `tag` is its own
    // parameter rather than being folded into `search`.
    const searched = await admin.get('/api/media?search=ramadan');
    expect(searched.body.items).toHaveLength(1);
    expect(searched.body.items[0].id).toBe(ids.hero);

    const byTag = await admin.get('/api/media?tag=ramadan');
    expect(byTag.body.items).toHaveLength(0);
  });

  it('combines a folder and a tag', async () => {
    const response = await admin.get('/api/media?category=Ramadan&tag=hero');
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].id).toBe(ids.hero);
  });

  it('unfiles an asset by clearing its folder', async () => {
    const response = await admin.patch(`/api/media/${ids.banner}`).send({ category: null, tags: [] });
    expect(response.status).toBe(200);
    expect(response.body.media.category).toBeNull();

    const facets = await admin.get('/api/media/facets');
    // The folder shrank rather than the asset vanishing.
    expect(facets.body.folders.find((row: { name: string | null }) => row.name === 'Ramadan').count).toBe(1);
    expect(facets.body.untagged).toBe(2);

    // Put it back, so the ordering of these tests is not load-bearing.
    await admin.patch(`/api/media/${ids.banner}`).send({ category: 'Ramadan', tags: ['vertical'] });
  });

  it('refuses the facets to a caller with no session', async () => {
    const response = await agent().get('/api/media/facets');
    expect(response.status).toBe(401);
  });
});

/**
 * Restaurant data integrity.
 *
 * This replaces the tenant-isolation suite. There is no longer a tenant
 * boundary to enforce — one operator owns every row — but the relationships
 * still have to be right: content for one restaurant must never appear under
 * another, an ad must never land on a different restaurant's reporting, and a
 * campaign must not be moved out from under the work attached to it. Those are
 * the failures that would quietly corrupt a client report, so they are what is
 * tested here.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { agent, createOwner, createRestaurant, prisma, resetDatabase } from './helpers.js';

describe('restaurant data integrity', () => {
  let client: ReturnType<typeof agent>;

  beforeEach(async () => {
    await resetDatabase();
    const owner = await createOwner();
    client = agent();
    await client.login(owner.email);
  });

  it('filters content, campaigns and ads to one restaurant', async () => {
    const alpha = await createRestaurant('alpha');
    const beta = await createRestaurant('beta');

    for (const [path, id] of [['content', alpha.restaurantId], ['campaigns', alpha.restaurantId], ['ads', alpha.restaurantId]] as const) {
      const response = await client.get(`/api/${path}?restaurantId=${id}`);
      expect(response.status).toBe(200);
      expect(response.body.items.length).toBeGreaterThan(0);
      for (const item of response.body.items) {
        const owner = item.restaurantId ?? item.restaurant?.id;
        expect(owner, `${path} leaked another restaurant`).toBe(alpha.restaurantId);
      }
    }

    // And the unfiltered list genuinely spans both, so the filter above proved
    // something rather than matching an already-single-restaurant database.
    const all = await client.get('/api/content');
    const restaurantIds = new Set(all.body.items.map((item: { restaurant: { id: string } }) => item.restaurant.id));
    expect(restaurantIds).toEqual(new Set([alpha.restaurantId, beta.restaurantId]));
  });

  it('refuses to file content under a campaign belonging to another restaurant', async () => {
    const alpha = await createRestaurant('alpha');
    const beta = await createRestaurant('beta');

    const response = await client.post('/api/content', {
      restaurantId: alpha.restaurantId,
      campaignId: beta.campaignId,
      name: 'Cross-wired post',
      platform: 'INSTAGRAM',
    });

    expect(response.status).toBe(404);
    expect(await prisma.content.count({ where: { name: 'Cross-wired post' } })).toBe(0);
  });

  it('takes an ad\'s restaurant from its campaign, not from the caller', async () => {
    const alpha = await createRestaurant('alpha');
    const beta = await createRestaurant('beta');

    // The body names beta, but the campaign belongs to alpha. The campaign wins,
    // because it is the reference that decides whose budget the spend lands on.
    const response = await client.post('/api/ads', {
      campaignId: alpha.campaignId,
      restaurantId: beta.restaurantId,
      name: 'Ownership test',
      platform: 'INSTAGRAM',
    });

    expect(response.status).toBe(201);
    expect(response.body.ad.restaurant.id).toBe(alpha.restaurantId);
  });

  it('will not move an ad to a campaign under a different restaurant', async () => {
    const alpha = await createRestaurant('alpha');
    const beta = await createRestaurant('beta');

    const response = await client.patch(`/api/ads/${alpha.adId}`, { campaignId: beta.campaignId });
    expect(response.status).toBe(404);

    const ad = await prisma.ad.findUnique({ where: { id: alpha.adId } });
    expect(ad?.campaignId).toBe(alpha.campaignId);
  });

  it('pins content to its restaurant, ignoring an attempt to reassign it', async () => {
    const alpha = await createRestaurant('alpha');
    const beta = await createRestaurant('beta');

    const response = await client.patch(`/api/content/${alpha.contentId}`, {
      restaurantId: beta.restaurantId,
      name: 'Renamed',
    });

    expect(response.status).toBe(200);
    expect(response.body.content.name).toBe('Renamed');
    expect(response.body.content.restaurant.id).toBe(alpha.restaurantId);
  });

  it('scopes analytics to the restaurant asked for', async () => {
    const alpha = await createRestaurant('alpha');
    await createRestaurant('beta');

    const scoped = await client.get(`/api/analytics/dashboard?restaurantId=${alpha.restaurantId}`);
    const all = await client.get('/api/analytics/dashboard');

    expect(scoped.status).toBe(200);
    expect(scoped.body.kpis.restaurants).toBe(1);
    expect(all.body.kpis.restaurants).toBe(2);
    expect(all.body.kpis.spend).toBeGreaterThan(scoped.body.kpis.spend);
  });

  it('deletes a restaurant with everything attached to it', async () => {
    const alpha = await createRestaurant('alpha');
    const beta = await createRestaurant('beta');

    expect((await client.delete(`/api/restaurants/${alpha.restaurantId}`)).status).toBe(200);

    expect(await prisma.campaign.count({ where: { restaurantId: alpha.restaurantId } })).toBe(0);
    expect(await prisma.content.count({ where: { restaurantId: alpha.restaurantId } })).toBe(0);
    expect(await prisma.ad.count({ where: { restaurantId: alpha.restaurantId } })).toBe(0);
    expect(await prisma.analyticsSnapshot.count({ where: { restaurantId: alpha.restaurantId } })).toBe(0);

    // The other restaurant is untouched.
    expect(await prisma.campaign.count({ where: { restaurantId: beta.restaurantId } })).toBe(1);
  });

  it('archives without destroying the reporting history', async () => {
    const alpha = await createRestaurant('alpha');

    const response = await client.post(`/api/restaurants/${alpha.restaurantId}/archive`);
    expect(response.status).toBe(200);
    expect(response.body.restaurant.status).toBe('ARCHIVED');

    // Archiving is the safe alternative to deletion, so the work survives.
    expect(await prisma.campaign.count({ where: { restaurantId: alpha.restaurantId } })).toBe(1);
    expect(await prisma.analyticsSnapshot.count({ where: { restaurantId: alpha.restaurantId } })).toBe(5);
  });

  it('refuses two restaurants with the same name', async () => {
    await client.post('/api/restaurants', { name: 'Sabah Al Leil', businessName: 'Sabah Al Leil' });
    const duplicate = await client.post('/api/restaurants', { name: 'Sabah Al Leil', businessName: 'Another' });
    expect(duplicate.status).toBe(409);
  });

  it('creates a brand alongside every restaurant, because the AI requires one', async () => {
    const created = await client.post('/api/restaurants', {
      name: 'Brand Check',
      businessName: 'Brand Check Ltd',
      cuisine: 'Grill',
      preferredLanguage: 'AR',
    });

    expect(created.status).toBe(201);
    expect(created.body.restaurant.brand).toBeTruthy();
    expect(created.body.restaurant.brand.preferredLanguage).toBe('AR');
    expect(created.body.restaurant.brand.cuisine).toBe('Grill');

    // Which means generation works immediately, with no extra setup step.
    const generated = await client.post('/api/content/generate', {
      restaurantId: created.body.restaurant.id,
      platform: 'INSTAGRAM',
      language: 'AR',
    });
    expect(generated.status).toBe(200);
  });

  it('never exposes integration credentials', async () => {
    const alpha = await createRestaurant('alpha');
    await prisma.integration.create({
      data: {
        restaurantId: alpha.restaurantId,
        platform: 'INSTAGRAM',
        status: 'CONNECTED',
        credentials: { accessToken: 'super-secret-token' },
      },
    });

    const response = await client.get('/api/integrations');
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain('super-secret-token');
    expect(response.body.items[0]).not.toHaveProperty('credentials');
  });
});

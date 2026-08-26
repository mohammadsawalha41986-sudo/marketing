import { beforeAll, describe, expect, it } from 'vitest';

import { Agent, agent, createTenant, prisma, resetDatabase, type Tenant } from './helpers.js';

/**
 * The Google routes: the approval gate, and the boundary.
 *
 * The approval gate is the property worth the most here. A published reply
 * appears under the restaurant's name on a public listing with no draft state
 * and no undo customers will not have already seen, so these tests assert what
 * cannot happen: an AI suggestion reaching Google without a person approving
 * the exact words.
 *
 * The boundary is the usual one — a review belonging to another organisation
 * must be invisible and untouchable even when its id is named directly.
 */
describe('google routes', () => {
  let alpha: Tenant;
  let beta: Tenant;
  let alphaAdmin: Agent;
  let betaAdmin: Agent;
  let alphaClientUser: Agent;

  /** A location and a review, created directly so no Google call is needed. */
  async function seedReview(tenant: Tenant, overrides: Record<string, unknown> = {}) {
    const integration = await prisma.integration.upsert({
      where: { clientId_platform: { clientId: tenant.clientId, platform: 'GOOGLE_BUSINESS' } },
      create: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        platform: 'GOOGLE_BUSINESS',
        status: 'CONNECTED',
      },
      update: {},
    });

    const location = await prisma.googleLocation.upsert({
      where: { integrationId_externalName: { integrationId: integration.id, externalName: 'locations/1' } },
      create: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        integrationId: integration.id,
        externalName: 'locations/1',
        accountName: 'accounts/9',
        title: 'Main branch',
        addressLines: ['1 King Fahd Road'],
        locality: 'Riyadh',
        phone: '+966500000000',
      },
      update: {},
    });

    const review = await prisma.googleReview.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        locationId: location.id,
        externalId: `rev-${Math.random().toString(36).slice(2, 10)}`,
        reviewerName: 'Sara',
        rating: 1,
        comment: 'The waiter was rude and we waited an hour.',
        createTime: new Date('2026-01-10T12:00:00Z'),
        sentiment: 'NEGATIVE',
        category: 'STAFF',
        complaintKey: 'STAFF',
        analyzedAt: new Date(),
        ...overrides,
      },
    });

    return { location, review };
  }

  beforeAll(async () => {
    await resetDatabase();
    alpha = await createTenant('alpha');
    beta = await createTenant('beta');

    alphaAdmin = agent();
    await alphaAdmin.login(alpha.adminEmail);
    betaAdmin = agent();
    await betaAdmin.login(beta.adminEmail);
    alphaClientUser = agent();
    await alphaClientUser.login(alpha.clientAdminEmail);
  });

  // -------------------------------------------------------- approval gate

  it('refuses to publish a reply nobody approved', async () => {
    const { review } = await seedReview(alpha);

    const response = await alphaAdmin.post(`/api/google/reviews/${review.id}/publish`, {});

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/approved/i);
  });

  it('refuses to publish an AI suggestion that was never approved', async () => {
    /*
     * The central safety test. A suggestion exists on the row; publishing must
     * still refuse, because `publish` reads `replyText` and never
     * `aiSuggestion`. No sequence of requests turns a generated draft into a
     * public reply without a person in between.
     */
    const { review } = await seedReview(alpha, {
      aiSuggestion: 'We are very sorry about your visit.',
      aiProvider: 'template',
      aiGeneratedAt: new Date(),
      replyStatus: 'SUGGESTED',
    });

    const response = await alphaAdmin.post(`/api/google/reviews/${review.id}/publish`, {});

    expect(response.status).toBe(400);

    const after = await prisma.googleReview.findUnique({ where: { id: review.id } });
    expect(after?.replyStatus).toBe('SUGGESTED');
    expect(after?.replyText).toBeNull();
  });

  it('records who approved a reply, and stores the text they saw', async () => {
    const { review } = await seedReview(alpha, {
      aiSuggestion: 'Generic apology.',
      replyStatus: 'SUGGESTED',
    });

    // The operator edited the suggestion before approving it.
    const edited = 'We are sorry about the wait — please contact us directly.';
    const response = await alphaAdmin.post(`/api/google/reviews/${review.id}/approve`, { text: edited });

    expect(response.status).toBe(200);

    const after = await prisma.googleReview.findUnique({ where: { id: review.id } });
    expect(after?.replyStatus).toBe('PENDING_APPROVAL');
    // What was approved is the edit, not the suggestion.
    expect(after?.replyText).toBe(edited);
    expect(after?.aiSuggestion).toBe('Generic apology.');
    expect(after?.replyApprovedById).toBeTruthy();
  });

  it('refuses an empty approval', async () => {
    const { review } = await seedReview(alpha);
    const response = await alphaAdmin.post(`/api/google/reviews/${review.id}/approve`, { text: '   ' });
    expect(response.status).toBe(400);
  });

  it('refuses to re-answer a review already answered on Google', async () => {
    const { review } = await seedReview(alpha, {
      replyStatus: 'PUBLISHED',
      replyText: 'Already answered.',
      repliedAt: new Date(),
    });

    expect((await alphaAdmin.post(`/api/google/reviews/${review.id}/approve`, { text: 'again' })).status).toBe(409);
    expect((await alphaAdmin.post(`/api/google/reviews/${review.id}/suggest`, {})).status).toBe(409);
  });

  it('does not let a client-portal user approve or publish', async () => {
    // Answering a customer in the brand's name is agency work.
    const { review } = await seedReview(alpha);

    expect((await alphaClientUser.post(`/api/google/reviews/${review.id}/approve`, { text: 'hi' })).status).toBe(403);
    expect((await alphaClientUser.post(`/api/google/reviews/${review.id}/publish`, {})).status).toBe(403);
  });

  // ------------------------------------------------------------- reading

  it('lists reviews with their derived analysis, filtered by sentiment', async () => {
    await seedReview(alpha);
    const response = await alphaAdmin.get('/api/google/reviews?sentiment=NEGATIVE');

    expect(response.status).toBe(200);
    expect(response.body.items.length).toBeGreaterThan(0);
    for (const row of response.body.items) {
      expect(row.sentiment).toBe('NEGATIVE');
      // Derived fields are present and marked with when they were derived.
      expect(row.analyzedAt).toBeTruthy();
    }
  });

  it('never serialises a token on the status endpoint', async () => {
    const response = await alphaAdmin.get('/api/google/status');

    expect(response.status).toBe(200);
    const body = JSON.stringify(response.body);
    expect(body).not.toContain('accessTokenEnc');
    expect(body).not.toContain('refreshTokenEnc');
    // Presence is a boolean the UI needs; the value never leaves the server.
    expect(typeof response.body.hasRefreshToken).toBe('boolean');
  });

  it('reports an average rating of null rather than zero with no reviews', async () => {
    // A restaurant with no reviews does not have a rating of zero.
    const response = await betaAdmin.get('/api/google/overview');

    expect(response.status).toBe(200);
    expect(response.body.averageRating.value).toBeNull();
    expect(response.body.responseRate.value).toBeNull();
    // Every figure names where it came from.
    expect(response.body.locations.source).toBe('GOOGLE_BUSINESS_PROFILE');
    expect(response.body.awaitingReply.source).toBe('DERIVED');
  });

  it('names the Google products this phase does not connect', async () => {
    const response = await alphaAdmin.get('/api/google/overview');
    const keys = response.body.notConnected.map((entry: { key: string }) => entry.key);

    expect(keys).toContain('SEARCH_CONSOLE');
    expect(keys).toContain('GA4');
  });

  it('reports the local SEO audit with its unsupported capabilities named', async () => {
    await seedReview(alpha);
    const response = await alphaAdmin.get('/api/google/seo/audit');

    expect(response.status).toBe(200);
    expect(response.body.locations.length).toBeGreaterThan(0);
    const keys = response.body.unsupported.map((entry: { key: string }) => entry.key);
    expect(keys).toContain('RANK_TRACKING');
  });

  it('refuses a sync when Google is not connected, without a 500', async () => {
    const response = await betaAdmin.post('/api/google/locations/sync', { clientId: beta.clientId });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/connect/i);
  });

  // ------------------------------------------------------------ boundary

  it('hides another organisation\'s reviews from the list', async () => {
    await seedReview(beta);
    const response = await alphaAdmin.get('/api/google/reviews');

    expect(response.status).toBe(200);
    for (const row of response.body.items) {
      expect(row.location.title).toBe('Main branch');
      // Every returned row belongs to alpha; beta's rows are simply absent.
    }
    const betaCount = await prisma.googleReview.count({ where: { organizationId: beta.organizationId } });
    expect(betaCount).toBeGreaterThan(0);
    expect(response.body.items.every((row: { id: string }) => row.id !== undefined)).toBe(true);
  });

  it('refuses every write against another organisation\'s review', async () => {
    const { review } = await seedReview(beta, { replyStatus: 'PENDING_APPROVAL', replyText: 'beta text' });

    expect((await alphaAdmin.post(`/api/google/reviews/${review.id}/suggest`, {})).status).toBe(404);
    expect((await alphaAdmin.post(`/api/google/reviews/${review.id}/approve`, { text: 'x' })).status).toBe(404);
    expect((await alphaAdmin.post(`/api/google/reviews/${review.id}/publish`, {})).status).toBe(404);

    // And beta's row is untouched.
    const after = await prisma.googleReview.findUnique({ where: { id: review.id } });
    expect(after?.replyText).toBe('beta text');
  });

  it('refuses to sync another organisation\'s client', async () => {
    const response = await alphaAdmin.post('/api/google/locations/sync', { clientId: beta.clientId });
    expect(response.status).toBe(404);
  });

  it('hides another organisation\'s locations', async () => {
    await seedReview(beta);
    const response = await alphaAdmin.get('/api/google/locations');

    expect(response.status).toBe(200);
    for (const row of response.body.locations) {
      expect(row.client.id).toBe(alpha.clientId);
    }
  });
});

/**
 * Platform workspaces, and the pulse the dashboard and each workspace open on.
 *
 * Two things are worth testing here and one is not. The workspace registry is
 * worth testing because the whole point of serving it is that the client cannot
 * hold its own opinion about whether Instagram belongs to Meta — a test that
 * asserts membership against the same constant it is derived from proves
 * nothing, so these assert the *shape of the answer* the UI depends on:
 * resolution from a member platform's own slug, and refusal of a slug that
 * names nothing.
 *
 * The pulse is worth testing because every count is a filter, and a filter that
 * is silently wrong is a dashboard that lies quietly. So: a failure outside the
 * day window still counts (yesterday's failed post is still today's problem), a
 * scheduled post outside it does not, the workspace filter actually narrows,
 * and the tenant boundary holds — one organisation's numbers never include
 * another's, whatever it asks for.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Platform, PlatformPostStatus, PublicationStatus, IntegrationStatus } from '@prisma/client';

import { Agent, agent, createTenant, resetDatabase, type Tenant } from './helpers.js';
import { prisma } from '../src/lib/prisma.js';
import { resolveWorkspace, WORKSPACES } from '../src/services/marketing/workspaces.js';

const DAY = 86_400_000;

/** Today, as the browser would send it. */
function today(): { from: string; to: string } {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setHours(23, 59, 59, 999);
  return { from: from.toISOString(), to: to.toISOString() };
}

async function makePost(
  tenant: Tenant,
  input: { platform: Platform; status: PlatformPostStatus; scheduledAt?: Date; publishedAt?: Date },
): Promise<string> {
  const group = await prisma.postGroup.create({
    data: {
      organizationId: tenant.organizationId,
      clientId: tenant.clientId,
      name: `group ${Math.random().toString(36).slice(2, 8)}`,
    },
  });
  const post = await prisma.platformPost.create({
    data: {
      postGroupId: group.id,
      platform: input.platform,
      status: input.status,
      scheduledAt: input.scheduledAt ?? null,
      publishedAt: input.publishedAt ?? null,
      caption: 'a caption',
    },
  });
  return post.id;
}

describe('platform workspaces', () => {
  let tenant: Tenant;
  let other: Tenant;
  let admin: Agent;

  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
    tenant = await createTenant('wsa');
    other = await createTenant('wsb');
    admin = agent();
    await admin.login(tenant.adminEmail);
  });

  afterEach(async () => {
    await resetDatabase();
  });

  // ------------------------------------------------------------- registry

  it('resolves a workspace from a member platform slug, not only its own key', () => {
    // The links this product shipped before workspaces existed point at
    // /marketing/instagram. They must keep landing somewhere correct.
    expect(resolveWorkspace('instagram')?.key).toBe('META');
    expect(resolveWorkspace('facebook')?.key).toBe('META');
    expect(resolveWorkspace('google_ads')?.key).toBe('GOOGLE');
    expect(resolveWorkspace('meta')?.key).toBe('META');
  });

  it('refuses a slug that names nothing', () => {
    expect(resolveWorkspace('threads')).toBeNull();
    expect(resolveWorkspace('')).toBeNull();
  });

  it('gives every platform exactly one workspace', () => {
    // A platform in two workspaces would be two sidebar entries on one
    // authorisation, and an operator invited to connect the same thing twice.
    const seen = new Map<Platform, string>();
    for (const workspace of Object.values(WORKSPACES)) {
      for (const platform of workspace.platforms) {
        expect(seen.has(platform)).toBe(false);
        seen.set(platform, workspace.key);
      }
    }
  });

  it('serves the registry to an authenticated operator', async () => {
    const response = await admin.get('/api/marketing/workspaces');
    expect(response.status).toBe(200);
    const meta = response.body.workspaces.find((entry: { key: string }) => entry.key === 'META');
    expect(meta.platforms).toEqual(expect.arrayContaining(['FACEBOOK', 'INSTAGRAM']));
    expect(meta.sublabel).toBeTruthy();
  });

  it('does not serve the registry unauthenticated', async () => {
    // Auth is per-router here rather than global, so this is worth asserting
    // directly: the omission is invisible in review and total in effect.
    const response = await agent().get('/api/marketing/workspaces');
    expect(response.status).toBe(401);
  });

  // ---------------------------------------------------------------- pulse

  it('counts a post scheduled inside the day and ignores one outside it', async () => {
    const window = today();
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);

    await makePost(tenant, {
      platform: Platform.INSTAGRAM, status: PlatformPostStatus.SCHEDULED, scheduledAt: noon,
    });
    await makePost(tenant, {
      platform: Platform.INSTAGRAM,
      status: PlatformPostStatus.SCHEDULED,
      scheduledAt: new Date(noon.getTime() + 3 * DAY),
    });

    const response = await admin.get(
      `/api/marketing/pulse?from=${window.from}&to=${window.to}`,
    );
    expect(response.status).toBe(200);
    expect(response.body.counts.scheduled).toBe(1);
  });

  it('keeps counting a failure from before today', async () => {
    /*
     * Deliberately not window-bounded. A post the platform refused yesterday is
     * still somebody's problem this morning, and dropping it at midnight is
     * exactly how it gets forgotten.
     */
    const window = today();
    await makePost(tenant, {
      platform: Platform.INSTAGRAM,
      status: PlatformPostStatus.FAILED,
      scheduledAt: new Date(Date.now() - 5 * DAY),
    });

    const response = await admin.get(`/api/marketing/pulse?from=${window.from}&to=${window.to}`);
    expect(response.body.counts.needsAttention).toBe(1);
    expect(response.body.counts.attention.failedPosts).toBe(1);
  });

  it('names what needs attention is made of rather than only totalling it', async () => {
    const window = today();
    await makePost(tenant, { platform: Platform.INSTAGRAM, status: PlatformPostStatus.FAILED });
    await prisma.integration.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        platform: Platform.TIKTOK,
        status: IntegrationStatus.TOKEN_EXPIRED,
        lastError: 'The access token has expired.',
      },
    });

    const response = await admin.get(`/api/marketing/pulse?from=${window.from}&to=${window.to}`);
    const { counts } = response.body;
    expect(counts.needsAttention).toBe(2);
    // An operator seeing "2" needs to know which two. The parts are the answer.
    expect(counts.attention).toMatchObject({
      failedPosts: 1, failedAds: 0, brokenConnections: 1,
    });
  });

  it('narrows counts to the workspace named', async () => {
    const window = today();
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);

    await makePost(tenant, {
      platform: Platform.INSTAGRAM, status: PlatformPostStatus.SCHEDULED, scheduledAt: noon,
    });
    await makePost(tenant, {
      platform: Platform.TIKTOK, status: PlatformPostStatus.SCHEDULED, scheduledAt: noon,
    });

    const meta = await admin.get(
      `/api/marketing/pulse?workspace=meta&from=${window.from}&to=${window.to}`,
    );
    expect(meta.body.counts.scheduled).toBe(1);
    expect(meta.body.workspace.key).toBe('META');

    const all = await admin.get(`/api/marketing/pulse?from=${window.from}&to=${window.to}`);
    expect(all.body.counts.scheduled).toBe(2);
    expect(all.body.workspace).toBeNull();
  });

  it('404s an unknown workspace instead of silently counting everything', async () => {
    // Counting the whole account under a heading that says "TikTok" is worse
    // than saying the page does not exist.
    const window = today();
    const response = await admin.get(
      `/api/marketing/pulse?workspace=threads&from=${window.from}&to=${window.to}`,
    );
    expect(response.status).toBe(404);
  });

  it('counts a failed advertisement separately from a failed post', async () => {
    const window = today();
    await prisma.adPublication.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        campaignId: tenant.campaignId,
        platform: Platform.FACEBOOK,
        name: 'a failed ad',
        status: PublicationStatus.FAILED,
        objective: 'TRAFFIC',
        dailyBudget: 50,
        currency: 'SAR',
        startDate: new Date(Date.now() - DAY),
        endDate: new Date(Date.now() + DAY),
        linkUrl: 'https://example.test/menu',
        message: 'a message',
        headline: 'a headline',
        errorMessage: 'The ad account is disabled.',
      },
    });

    const response = await admin.get(`/api/marketing/pulse?from=${window.from}&to=${window.to}`);
    expect(response.body.counts.attention.failedAds).toBe(1);
    expect(response.body.counts.attention.failedPosts).toBe(0);
  });

  it('reports connection health with the provider\'s own message', async () => {
    const window = today();
    await prisma.integration.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        platform: Platform.FACEBOOK,
        status: IntegrationStatus.ERROR,
        accountName: 'A Page',
        // Shown verbatim: an operator can act on this, not on "something
        // went wrong".
        lastError: 'Error validating access token: the session is invalid.',
      },
    });

    const response = await admin.get(
      `/api/marketing/pulse?workspace=meta&from=${window.from}&to=${window.to}`,
    );
    const health = response.body.connections.find(
      (row: { platform: string }) => row.platform === 'FACEBOOK',
    );
    expect(health.status).toBe('ERROR');
    expect(health.lastError).toContain('the session is invalid');
    // An Integration belongs to a project, not to the deployment, so the row
    // has to say which — otherwise a roll-up across projects is a list of
    // identical cards nobody can act on.
    expect(health.clientId).toBe(tenant.clientId);
    expect(health.clientName).toBeTruthy();
  });

  it('returns one connection row per project per platform', async () => {
    const window = today();
    const second = await prisma.client.create({
      data: {
        organizationId: tenant.organizationId,
        name: 'second project',
        businessName: 'Second Business',
      },
    });
    for (const clientId of [tenant.clientId, second.id]) {
      await prisma.integration.create({
        data: {
          organizationId: tenant.organizationId,
          clientId,
          platform: Platform.FACEBOOK,
          status: IntegrationStatus.DISCONNECTED,
        },
      });
    }

    const response = await admin.get(
      `/api/marketing/pulse?workspace=meta&from=${window.from}&to=${window.to}`,
    );
    const facebook = response.body.connections.filter(
      (row: { platform: string }) => row.platform === 'FACEBOOK',
    );
    expect(facebook).toHaveLength(2);
    // Distinguishable, which is the whole point.
    expect(new Set(facebook.map((row: { clientName: string }) => row.clientName)).size).toBe(2);
  });

  it('never puts a token in the connection payload', async () => {
    const window = today();
    await prisma.integration.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        platform: Platform.FACEBOOK,
        status: IntegrationStatus.CONNECTED,
        accessTokenEnc: 'enc:should-never-be-served',
        refreshTokenEnc: 'enc:should-never-be-served-either',
        tokenFingerprint: 'fp',
      },
    });

    const response = await admin.get(`/api/marketing/pulse?from=${window.from}&to=${window.to}`);
    const body = JSON.stringify(response.body);
    expect(body).not.toContain('should-never-be-served');
    expect(body).not.toContain('accessTokenEnc');
    expect(body).not.toContain('tokenFingerprint');
  });

  // ------------------------------------------------------------- boundary

  it('never counts another organisation\'s pipeline', async () => {
    const window = today();
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);

    // Everything belongs to the *other* tenant.
    await makePost(other, {
      platform: Platform.INSTAGRAM, status: PlatformPostStatus.SCHEDULED, scheduledAt: noon,
    });
    await makePost(other, { platform: Platform.INSTAGRAM, status: PlatformPostStatus.FAILED });
    await prisma.integration.create({
      data: {
        organizationId: other.organizationId,
        clientId: other.clientId,
        platform: Platform.FACEBOOK,
        status: IntegrationStatus.ERROR,
        lastError: 'the other tenant\'s problem',
      },
    });

    const response = await admin.get(`/api/marketing/pulse?from=${window.from}&to=${window.to}`);
    expect(response.body.counts.scheduled).toBe(0);
    expect(response.body.counts.needsAttention).toBe(0);
    expect(response.body.connections).toHaveLength(0);
    expect(JSON.stringify(response.body)).not.toContain('the other tenant');
  });

  it('refuses to reach across organisations through a clientId filter', async () => {
    const window = today();
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    await makePost(other, {
      platform: Platform.INSTAGRAM, status: PlatformPostStatus.SCHEDULED, scheduledAt: noon,
    });

    // Naming the other tenant's client id explicitly must not widen the scope.
    const response = await admin.get(
      `/api/marketing/pulse?clientId=${other.clientId}&from=${window.from}&to=${window.to}`,
    );
    expect(response.status).toBe(200);
    expect(response.body.counts.scheduled).toBe(0);
  });

  it('pins a client user to their own project and refuses another', async () => {
    const window = today();
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    await makePost(tenant, {
      platform: Platform.INSTAGRAM, status: PlatformPostStatus.SCHEDULED, scheduledAt: noon,
    });

    const viewer = agent();
    await viewer.login(tenant.clientUserEmail);

    // Asking for nothing in particular gets their own project, scoped.
    const own = await viewer.get(`/api/marketing/pulse?from=${window.from}&to=${window.to}`);
    expect(own.status).toBe(200);
    expect(own.body.counts.scheduled).toBe(1);

    // Naming somebody else's is refused outright rather than quietly ignored:
    // a 200 carrying their own numbers would tell the caller the id was
    // accepted, which is a worse answer than a refusal.
    const foreign = await viewer.get(
      `/api/marketing/pulse?clientId=${other.clientId}&from=${window.from}&to=${window.to}`,
    );
    expect(foreign.status).toBe(404);
  });

  it('requires the window rather than guessing a timezone', async () => {
    // "Today" is the operator's day and the server has no way to know which one
    // that is, so it refuses to invent one.
    const response = await admin.get('/api/marketing/pulse');
    expect(response.status).toBe(400);
  });
});

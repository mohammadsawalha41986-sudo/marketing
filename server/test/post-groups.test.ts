/**
 * One idea, several platforms, each with its own words.
 *
 * The failure this whole model exists to prevent is the one an agency notices
 * immediately: a tool that writes the Facebook caption and copies it to
 * Instagram and TikTok. So the assertions here are mostly about independence —
 * editing one version must not touch its siblings — and about the state a
 * single-platform model cannot express at all, which is Facebook succeeding
 * while TikTok fails.
 *
 * `Content` is deliberately untouched by all of this. The two paths run side by
 * side, and a test that finds the old rows disturbed is a test that has caught
 * a migration nobody asked for.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PlatformPostStatus, Platform, PostGroupStatus } from '@prisma/client';

import { agent, createTenant, prisma, resetDatabase, type Tenant } from './helpers.js';
import { deriveGroupStatus } from '../src/services/social/state.js';
import { publishPlatformPost, refreshGroupStatus } from '../src/services/social/post-groups.js';
import { socialTick } from '../src/services/publishing/scheduler.js';
import { encryptSecret } from '../src/lib/crypto.js';

describe('multi-platform posts', () => {
  let tenant: Tenant;

  beforeAll(async () => {
    await resetDatabase();
    tenant = await createTenant('social-groups');
  });

  beforeEach(async () => {
    await prisma.postGroup.deleteMany({ where: { clientId: tenant.clientId } });
  });

  const admin = async () => {
    const client = agent();
    await client.login(tenant.adminEmail);
    return client;
  };

  const createGroup = async (platforms: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => {
    const client = await admin();
    const response = await client.post('/api/social/post-groups', {
      clientId: tenant.clientId,
      name: 'Ramadan offer',
      shared: { caption: 'A shared starting point.' },
      platforms,
      ...extra,
    });
    return { client, response };
  };

  // ------------------------------------------------------------- creation

  it('creates one group with a version per platform', async () => {
    const { response } = await createGroup([
      { platform: Platform.FACEBOOK },
      { platform: Platform.INSTAGRAM },
      { platform: Platform.TIKTOK },
    ]);

    expect(response.status).toBe(201);
    expect(response.body.group.posts).toHaveLength(3);
    // Three versions of one idea, not three unrelated posts.
    expect(new Set(response.body.group.posts.map((p: { platform: string }) => p.platform)).size).toBe(3);
    expect(response.body.group.status).toBe(PostGroupStatus.DRAFT);
  });

  it('seeds each version from the shared draft without binding them to it', async () => {
    const { response } = await createGroup([
      { platform: Platform.FACEBOOK },
      // An override at creation time, which is the whole point of the field.
      { platform: Platform.INSTAGRAM, caption: '✨ Something shorter.' },
    ]);

    const posts = response.body.group.posts as Array<{ platform: string; caption: string }>;
    expect(posts.find((p) => p.platform === 'FACEBOOK')?.caption).toBe('A shared starting point.');
    expect(posts.find((p) => p.platform === 'INSTAGRAM')?.caption).toBe('✨ Something shorter.');
  });

  it('refuses two versions of the same platform', async () => {
    const { response } = await createGroup([
      { platform: Platform.FACEBOOK },
      { platform: Platform.FACEBOOK },
    ]);

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/appears twice/i);
  });

  it('refuses a group with no platforms', async () => {
    const client = await admin();
    const response = await client.post('/api/social/post-groups', {
      clientId: tenant.clientId,
      name: 'Nowhere',
      platforms: [],
    });
    expect(response.status).toBe(400);
  });

  // ---------------------------------------------------------- independence

  it('editing one platform leaves its siblings alone', async () => {
    const { client, response } = await createGroup([
      { platform: Platform.FACEBOOK },
      { platform: Platform.INSTAGRAM },
    ]);

    const instagram = response.body.group.posts.find(
      (p: { platform: string }) => p.platform === 'INSTAGRAM',
    );

    const edited = await client.patch(`/api/social/platform-posts/${instagram.id}`, {
      caption: 'Rewritten for Instagram only.',
      hashtags: ['ramadan', 'riyadh'],
    });

    expect(edited.status).toBe(200);
    const posts = edited.body.group.posts as Array<{ platform: string; caption: string; hashtags: string[] }>;

    expect(posts.find((p) => p.platform === 'INSTAGRAM')?.caption).toBe('Rewritten for Instagram only.');
    expect(posts.find((p) => p.platform === 'INSTAGRAM')?.hashtags).toEqual(['ramadan', 'riyadh']);
    // The assertion the product depends on.
    expect(posts.find((p) => p.platform === 'FACEBOOK')?.caption).toBe('A shared starting point.');
    expect(posts.find((p) => p.platform === 'FACEBOOK')?.hashtags).toEqual([]);
  });

  it('keeps provider-specific settings per platform', async () => {
    const { response } = await createGroup([
      { platform: Platform.INSTAGRAM, config: { mediaType: 'REEL' } },
      { platform: Platform.TIKTOK, config: { privacyLevel: 'PUBLIC_TO_EVERYONE' } },
    ]);

    const posts = response.body.group.posts as Array<{ platform: string; config: Record<string, unknown> }>;
    expect(posts.find((p) => p.platform === 'INSTAGRAM')?.config).toEqual({ mediaType: 'REEL' });
    expect(posts.find((p) => p.platform === 'TIKTOK')?.config).toEqual({ privacyLevel: 'PUBLIC_TO_EVERYONE' });
  });

  // -------------------------------------------------------- state machine

  it('refuses to jump from draft straight to published', async () => {
    const { client, response } = await createGroup([{ platform: Platform.FACEBOOK }]);
    const post = response.body.group.posts[0];

    // Approval is not a step that can be skipped by calling another endpoint.
    const published = await client.post(`/api/social/platform-posts/${post.id}/publish-now`);

    expect(published.status).toBe(400);
    expect(published.body.error.message).toMatch(/must be approved/i);
  });

  it('walks draft to approved and refuses the illegal step back', async () => {
    const { client, response } = await createGroup([{ platform: Platform.FACEBOOK }]);
    const post = response.body.group.posts[0];

    expect((await client.post(`/api/social/platform-posts/${post.id}/submit`)).status).toBe(200);
    expect((await client.post(`/api/social/platform-posts/${post.id}/approve`)).status).toBe(200);

    // Approved is not a state you submit from.
    const again = await client.post(`/api/social/platform-posts/${post.id}/submit`);
    expect(again.status).toBe(409);
    expect(again.body.error.message).toMatch(/cannot become/i);
  });

  it('will not edit a post that has been approved', async () => {
    const { client, response } = await createGroup([{ platform: Platform.FACEBOOK }]);
    const post = response.body.group.posts[0];

    await client.post(`/api/social/platform-posts/${post.id}/submit`);
    await client.post(`/api/social/platform-posts/${post.id}/approve`);

    // The approval was of a specific version; changing it silently would make
    // the approval a record of something that no longer exists.
    const edit = await client.patch(`/api/social/platform-posts/${post.id}`, { caption: 'Sneaky change' });
    expect(edit.status).toBe(400);
    expect(edit.body.error.message).toMatch(/no longer be edited/i);
  });

  it('moves the whole group and skips what cannot legally move', async () => {
    const { client, response } = await createGroup([
      { platform: Platform.FACEBOOK },
      { platform: Platform.INSTAGRAM },
    ]);
    const first = response.body.group.posts[0];

    // One is already further along than the other.
    await client.post(`/api/social/platform-posts/${first.id}/submit`);

    const submitted = await client.post(`/api/social/post-groups/${response.body.group.id}/submit`);

    expect(submitted.status).toBe(200);
    // The one already in review is left alone rather than forced.
    expect(submitted.body.moved).toBe(1);
    expect(submitted.body.skipped).toBe(1);
    expect(submitted.body.group.status).toBe(PostGroupStatus.IN_REVIEW);
  });

  // ------------------------------------------------ the partial case

  it('calls a mixed result partially published, not published or failed', () => {
    // The state a single-platform model cannot express. Asserted on the pure
    // function because the interesting part is the rule, not the plumbing.
    expect(deriveGroupStatus([
      { status: PlatformPostStatus.PUBLISHED },
      { status: PlatformPostStatus.FAILED },
    ])).toBe(PostGroupStatus.PARTIALLY_PUBLISHED);

    expect(deriveGroupStatus([
      { status: PlatformPostStatus.PUBLISHED },
      { status: PlatformPostStatus.PUBLISHED },
    ])).toBe(PostGroupStatus.PUBLISHED);

    expect(deriveGroupStatus([
      { status: PlatformPostStatus.FAILED },
      { status: PlatformPostStatus.FAILED },
    ])).toBe(PostGroupStatus.FAILED);

    // Anything still moving outranks anything settled.
    expect(deriveGroupStatus([
      { status: PlatformPostStatus.PUBLISHED },
      { status: PlatformPostStatus.PUBLISHING },
    ])).toBe(PostGroupStatus.PUBLISHING);
  });

  // ------------------------------------------------------------ isolation

  it('never lets one tenant read another\'s posts', async () => {
    const { response } = await createGroup([{ platform: Platform.FACEBOOK }]);
    const other = await createTenant('social-intruder');

    const intruder = agent();
    await intruder.login(other.adminEmail);

    expect((await intruder.get(`/api/social/post-groups/${response.body.group.id}`)).status).toBe(404);
    expect((await intruder.patch(
      `/api/social/platform-posts/${response.body.group.posts[0].id}`,
      { caption: 'Not yours' },
    )).status).toBe(404);
  });

  it('refuses media belonging to another tenant', async () => {
    const other = await createTenant('social-media-intruder');
    const foreign = await prisma.media.create({
      data: {
        organizationId: other.organizationId,
        clientId: other.clientId,
        type: 'IMAGE',
        filename: 'not-yours.jpg',
        originalName: 'not-yours.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 10,
        url: '/api/media/x/file',
      },
    });

    const { response } = await createGroup([
      { platform: Platform.FACEBOOK, mediaIds: [foreign.id] },
    ]);

    expect(response.status).toBe(404);
  });

  // ------------------------------------------------------------- deletion

  it('refuses to delete a group that has already published somewhere', async () => {
    const { client, response } = await createGroup([{ platform: Platform.FACEBOOK }]);
    const post = response.body.group.posts[0];

    // Deleting our record would not remove the post from the platform; it would
    // only lose the link between the two.
    await prisma.platformPost.update({
      where: { id: post.id },
      data: { externalPostId: '1220219831177035_1', status: PlatformPostStatus.PUBLISHED },
    });

    const deleted = await client.delete(`/api/social/post-groups/${response.body.group.id}`);
    expect(deleted.status).toBe(409);
    expect(deleted.body.error.message).toMatch(/already been published/i);
  });

  // --------------------------------------------------- the old path is safe

  it('leaves the single-platform Content path completely alone', async () => {
    const before = await prisma.content.count();
    await createGroup([{ platform: Platform.FACEBOOK }, { platform: Platform.INSTAGRAM }]);

    // The new architecture is additive. A change here means something migrated
    // that nobody asked to migrate.
    expect(await prisma.content.count()).toBe(before);
  });
});

/**
 * Scheduling and publishing on the multi-platform path.
 *
 * Same rule as the single-platform pipeline: PUBLISHED is reachable only via a
 * provider's post id, and a scheduled time arriving is not evidence of anything.
 */
describe('multi-platform scheduling and publishing', () => {
  let tenant: Tenant;
  const PAGE_ID = '1220219831177035';

  beforeAll(async () => {
    await resetDatabase();
    tenant = await createTenant('social-publish');
    process.env.TOKEN_ENCRYPTION_KEY = 'Zm9yLXRlc3Rpbmctb25seS0zMi1ieXRlLWtleS0hIQ==';
  });

  beforeEach(async () => {
    await prisma.postGroup.deleteMany({ where: { clientId: tenant.clientId } });
    await prisma.integrationAccount.deleteMany({ where: { clientId: tenant.clientId } });
    await prisma.integration.deleteMany({ where: { clientId: tenant.clientId } });
  });

  const connectPage = async () => {
    const integration = await prisma.integration.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        platform: Platform.FACEBOOK,
        status: 'CONNECTED',
      },
    });
    return prisma.integrationAccount.create({
      data: {
        integrationId: integration.id,
        clientId: tenant.clientId,
        kind: 'PAGE',
        externalId: PAGE_ID,
        name: 'PawEase',
        selected: true,
        accessTokenEnc: encryptSecret('page-token'),
        tokenStatus: 'TOKEN_VALID',
      },
    });
  };

  const respond = (body: unknown, status = 200) => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    }) as never;
    return { fetchImpl, calls };
  };

  const approvedPost = async (scheduledAt?: Date) => {
    const account = await connectPage();
    const group = await prisma.postGroup.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        name: 'Publishable',
        posts: {
          create: [{
            platform: Platform.FACEBOOK,
            integrationAccountId: account.id,
            caption: 'Less mess, happier dog.',
            status: scheduledAt ? PlatformPostStatus.SCHEDULED : PlatformPostStatus.QUEUED,
            scheduledAt: scheduledAt ?? null,
          }],
        },
      },
      include: { posts: true },
    });
    return { group, post: group.posts[0]! };
  };

  it('publishes and stores the provider id', async () => {
    const { post } = await approvedPost();
    const { fetchImpl, calls } = respond({ id: `${PAGE_ID}_555` });

    const result = await publishPlatformPost({ prisma, platformPostId: post.id, fetchImpl });

    expect(result.published).toBe(true);
    expect(result.externalPostId).toBe(`${PAGE_ID}_555`);
    expect(calls[0]).toContain(`/${PAGE_ID}/feed`);

    const after = await prisma.platformPost.findUniqueOrThrow({ where: { id: post.id } });
    expect(after.status).toBe(PlatformPostStatus.PUBLISHED);
    expect(after.publishedAt).toBeTruthy();
  });

  it('never becomes published when the provider refuses', async () => {
    const { post } = await approvedPost();
    const { fetchImpl } = respond(
      { error: { message: 'requires pages_manage_posts', type: 'OAuthException', code: 200 } }, 403,
    );

    const result = await publishPlatformPost({ prisma, platformPostId: post.id, fetchImpl });

    expect(result.published).toBe(false);
    const after = await prisma.platformPost.findUniqueOrThrow({ where: { id: post.id } });
    expect(after.status).toBe(PlatformPostStatus.FAILED);
    expect(after.externalPostId).toBeNull();
    expect(after.errorMessage).toMatch(/pages_manage_posts/);
  });

  it('never publishes twice however often the worker runs', async () => {
    const { post } = await approvedPost();
    const { fetchImpl, calls } = respond({ id: `${PAGE_ID}_once` });

    await publishPlatformPost({ prisma, platformPostId: post.id, fetchImpl });
    await publishPlatformPost({ prisma, platformPostId: post.id, fetchImpl });
    await publishPlatformPost({ prisma, platformPostId: post.id, fetchImpl });

    expect(calls).toHaveLength(1);
  });

  it('the scheduler queues a due post without publishing it', async () => {
    const { post } = await approvedPost(new Date(Date.now() - 60_000));
    const { fetchImpl } = respond({ id: 'should-not-be-used' });

    // Only the sweep half: queued, not published.
    const report = await socialTick({ prisma, fetchImpl, limit: 0 });
    expect(report.published).toHaveLength(0);

    const swept = await socialTick({ prisma, fetchImpl: respond({ id: `${PAGE_ID}_sched` }).fetchImpl });
    expect(swept.queued.concat(swept.published)).toContain(post.id);
  });

  it('the group reports partially published when one platform fails', async () => {
    const account = await connectPage();
    const group = await prisma.postGroup.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        name: 'Mixed',
        posts: {
          create: [
            { platform: Platform.FACEBOOK, integrationAccountId: account.id, caption: 'a', status: PlatformPostStatus.PUBLISHED, externalPostId: 'x' },
            { platform: Platform.TIKTOK, caption: 'b', status: PlatformPostStatus.FAILED },
          ],
        },
      },
    });

    await refreshGroupStatus(prisma, group.id);

    const after = await prisma.postGroup.findUniqueOrThrow({ where: { id: group.id } });
    expect(after.status).toBe(PostGroupStatus.PARTIALLY_PUBLISHED);
  });
});

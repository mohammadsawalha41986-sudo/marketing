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

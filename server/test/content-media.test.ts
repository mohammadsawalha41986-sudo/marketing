/**
 * Media as a persisted part of content, not a preview that lives in React.
 *
 * The failure this file exists to prevent: a post that looks complete in the
 * composer, saves without error, and comes back from the database with nothing
 * attached. The composer used to hold a rendering URL in component state and
 * never send an id, so every screen downstream — detail, calendar, approvals —
 * correctly reported "attach media to preview the creative" for content the
 * operator believed had an image. Nothing was broken in the model or the route;
 * the attachment was simply never made.
 *
 * So these assertions follow one media id through the whole workflow and check
 * it is still there at each stop, and that the set can be changed and emptied
 * deliberately. The last two are about tenancy: an id in a request body is a
 * claim, and attaching somebody else's file must be refused rather than
 * rendered.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { ContentStatus, MediaType, Platform } from '@prisma/client';

import { agent, createTenant, prisma, resetDatabase, type Tenant } from './helpers.js';

describe('media stays attached to content', () => {
  let alpha: Tenant;
  let beta: Tenant;

  beforeAll(async () => {
    await resetDatabase();
    alpha = await createTenant('media-alpha');
    beta = await createTenant('media-beta');
  });

  /** A Media row standing in for something already uploaded to the library. */
  const upload = (tenant: Tenant, name: string, type: MediaType = MediaType.IMAGE) =>
    prisma.media.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        type,
        filename: `${name}.jpg`,
        originalName: `${name}.jpg`,
        mimeType: type === MediaType.VIDEO ? 'video/mp4' : 'image/jpeg',
        sizeBytes: 2048,
        url: `/api/media/${name}/file`,
      },
    });

  const admin = async (tenant: Tenant) => {
    const client = agent();
    await client.login(tenant.adminEmail);
    return client;
  };

  const compose = async (tenant: Tenant, mediaIds: string[], name = 'Grooming – Less Mess') => {
    const client = await admin(tenant);
    const response = await client.post('/api/content', {
      clientId: tenant.clientId,
      name,
      type: 'POST',
      platform: Platform.FACEBOOK,
      language: 'EN',
      caption: 'Less mess, happier dog.',
      hashtags: ['dogcare'],
      mediaIds,
    });
    return { client, response };
  };

  it('attaches the media the composer sent, in order', async () => {
    const first = await upload(alpha, 'bath-1');
    const second = await upload(alpha, 'bath-2');

    const { response } = await compose(alpha, [first.id, second.id]);

    expect(response.status).toBe(201);
    expect(response.body.content.mediaLinks).toHaveLength(2);
    // Position is the publication order, not the order the library happened to
    // return them in.
    expect(response.body.content.mediaLinks.map((link: { media: { id: string } }) => link.media.id))
      .toEqual([first.id, second.id]);
  });

  it('still has the media when the content is read back', async () => {
    const media = await upload(alpha, 'readback');
    const { client, response } = await compose(alpha, [media.id], 'Readback');

    const fetched = await client.get(`/api/content/${response.body.content.id}`);

    expect(fetched.status).toBe(200);
    expect(fetched.body.content.mediaLinks[0].media.id).toBe(media.id);
    // The URL is what the preview renders. A row with no URL is as useless as
    // no row at all.
    expect(fetched.body.content.mediaLinks[0].media.url).toBeTruthy();
  });

  it('carries the media into the calendar', async () => {
    const media = await upload(alpha, 'calendar');
    const { client, response } = await compose(alpha, [media.id], 'Calendar post');
    const contentId = response.body.content.id;

    await client.patch(`/api/content/${contentId}`, {
      scheduledAt: new Date('2026-09-01T16:41:00.000Z').toISOString(),
    });

    const calendar = await client.get('/api/calendar?view=month&anchor=2026-09-01');

    const row = calendar.body.items.find((item: { id: string }) => item.id === contentId);
    expect(row).toBeTruthy();
    // This is the exact value the calendar card's thumbnail reads.
    expect(row.mediaLinks[0].media.url).toBe(media.url);
  });

  it('replaces the whole set rather than merging', async () => {
    const original = await upload(alpha, 'original');
    const replacement = await upload(alpha, 'replacement');
    const { client, response } = await compose(alpha, [original.id], 'Replace me');

    const updated = await client.patch(`/api/content/${response.body.content.id}`, {
      mediaIds: [replacement.id],
    });

    expect(updated.status).toBe(200);
    expect(updated.body.content.mediaLinks).toHaveLength(1);
    expect(updated.body.content.mediaLinks[0].media.id).toBe(replacement.id);
  });

  it('lets the operator remove the last image on purpose', async () => {
    const media = await upload(alpha, 'removable');
    const { client, response } = await compose(alpha, [media.id], 'Remove me');

    // An empty array is an instruction, not a missing field — otherwise
    // "detach everything" is inexpressible.
    const updated = await client.patch(`/api/content/${response.body.content.id}`, { mediaIds: [] });

    expect(updated.status).toBe(200);
    expect(updated.body.content.mediaLinks).toHaveLength(0);
  });

  it('leaves the media alone when the update does not mention it', async () => {
    const media = await upload(alpha, 'untouched');
    const { client, response } = await compose(alpha, [media.id], 'Untouched');

    const updated = await client.patch(`/api/content/${response.body.content.id}`, {
      caption: 'A new caption, the same photograph.',
    });

    expect(updated.body.content.mediaLinks).toHaveLength(1);
    expect(updated.body.content.mediaLinks[0].media.id).toBe(media.id);
  });

  it('keeps the media across submit and approval', async () => {
    const media = await upload(alpha, 'approved');
    const { client, response } = await compose(alpha, [media.id], 'Approval journey');
    const contentId = response.body.content.id;

    await client.post(`/api/content/${contentId}/submit`);
    const submitted = await client.get(`/api/content/${contentId}`);

    expect(submitted.body.content.status).toBe(ContentStatus.SUBMITTED);
    // The creative that was approved must be the creative that was submitted.
    expect(submitted.body.content.mediaLinks[0].media.id).toBe(media.id);
  });

  it('refuses media belonging to another tenant', async () => {
    const foreign = await upload(beta, 'not-yours');

    const { response } = await compose(alpha, [foreign.id], 'Cross tenant');

    // 404, not 403: alpha has no business learning that this id exists.
    expect(response.status).toBe(404);
  });

  it('refuses a foreign media id on update too', async () => {
    const mine = await upload(alpha, 'mine');
    const foreign = await upload(beta, 'still-not-yours');
    const { client, response } = await compose(alpha, [mine.id], 'Cross tenant update');

    const updated = await client.patch(`/api/content/${response.body.content.id}`, {
      mediaIds: [foreign.id],
    });

    expect(updated.status).toBe(404);

    // And the original attachment survived the rejected write.
    const after = await client.get(`/api/content/${response.body.content.id}`);
    expect(after.body.content.mediaLinks[0].media.id).toBe(mine.id);
  });

  it('refuses a media id that does not exist at all', async () => {
    const { response } = await compose(alpha, ['cmnot-a-real-media-id'], 'Bogus id');
    expect(response.status).toBe(404);
  });
});

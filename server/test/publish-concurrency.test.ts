/**
 * Two workers, one post.
 *
 * The existing dedup test runs the publisher three times *in sequence*, which
 * the `externalPostId` check already handled: by the second call the id is on
 * the row. That is not the case the scheduler actually produces. Its ticks are
 * on `setInterval`, which does not wait for the previous pass, and a pass that
 * outruns its interval overlaps itself — so two callers select the same post,
 * both read it as unpublished, and both reach the provider before either has
 * written anything back.
 *
 * That window is what these tests close, and they are written to fail against
 * the read-then-write claim that used to be there: the provider is deliberately
 * slow, so both callers are inside the critical section at the same time.
 * Publishing twice means a customer's followers see the same post twice.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Platform, PlatformPostStatus, PublishingJobStatus } from '@prisma/client';

import { agent, createTenant, prisma, resetDatabase, type Tenant } from './helpers.js';
import { publishPlatformPost } from '../src/services/social/post-groups.js';
import { socialTick } from '../src/services/publishing/scheduler.js';
import { encryptSecret } from '../src/lib/crypto.js';

const PAGE_ID = '111222333444555';

describe('publishing under concurrency', () => {
  let tenant: Tenant;

  beforeAll(async () => {
    await resetDatabase();
    tenant = await createTenant('publish-concurrency');
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

  /**
   * A provider that takes its time.
   *
   * The delay is the whole point: it holds the first caller inside the publish
   * so a second caller can arrive before the first has written its result. With
   * an instant provider the race closes on its own and the test proves nothing.
   */
  const slowProvider = (body: unknown, delayMs = 120) => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      await new Promise((done) => setTimeout(done, delayMs));
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    }) as never;
    return { fetchImpl, calls };
  };

  const queuedPost = async (status: PlatformPostStatus = PlatformPostStatus.QUEUED, scheduledAt?: Date) => {
    const account = await connectPage();
    const group = await prisma.postGroup.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        name: 'Concurrent',
        posts: {
          create: [{
            platform: Platform.FACEBOOK,
            integrationAccountId: account.id,
            caption: 'Less mess, happier dog.',
            status,
            scheduledAt: scheduledAt ?? null,
          }],
        },
      },
      include: { posts: true },
    });
    return group.posts[0]!;
  };

  it('calls the provider once when two workers publish the same post at once', async () => {
    const post = await queuedPost();
    const { fetchImpl, calls } = slowProvider({ id: `${PAGE_ID}_race` });

    const [a, b] = await Promise.all([
      publishPlatformPost({ prisma, platformPostId: post.id, fetchImpl }),
      publishPlatformPost({ prisma, platformPostId: post.id, fetchImpl }),
    ]);

    // The assertion that matters: the customer's followers saw it once.
    expect(calls).toHaveLength(1);

    // Exactly one caller may claim to have published it. The other lost the
    // claim and must not report a publication it did not perform.
    expect([a.published, b.published].filter(Boolean)).toHaveLength(1);

    const after = await prisma.platformPost.findUniqueOrThrow({ where: { id: post.id } });
    expect(after.status).toBe(PlatformPostStatus.PUBLISHED);
    expect(after.externalPostId).toBe(`${PAGE_ID}_race`);
    // One publish, one attempt. A second increment means a second claim got in.
    expect(after.attemptCount).toBe(1);
  });

  it('the loser of the claim reports honestly rather than inventing a failure', async () => {
    const post = await queuedPost();
    const { fetchImpl } = slowProvider({ id: `${PAGE_ID}_honest` });

    const results = await Promise.all([
      publishPlatformPost({ prisma, platformPostId: post.id, fetchImpl }),
      publishPlatformPost({ prisma, platformPostId: post.id, fetchImpl }),
    ]);

    const loser = results.find((result) => !result.published);
    expect(loser).toBeDefined();
    // Not a provider error, not a permissions problem — nothing went wrong.
    expect(loser?.error).toMatch(/another worker/i);
  });

  it('two overlapping ticks queue a due post once between them', async () => {
    const post = await queuedPost(PlatformPostStatus.SCHEDULED, new Date(Date.now() - 60_000));
    const { fetchImpl, calls } = slowProvider({ id: `${PAGE_ID}_tick` });

    const [first, second] = await Promise.all([
      socialTick({ prisma, fetchImpl }),
      socialTick({ prisma, fetchImpl }),
    ]);

    // The post is queued by exactly one of the two passes, never both.
    expect([...first.queued, ...second.queued].filter((id) => id === post.id)).toHaveLength(1);
    // And however the two passes interleave, it reaches the provider once.
    expect(calls.length).toBeLessThanOrEqual(1);

    const after = await prisma.platformPost.findUniqueOrThrow({ where: { id: post.id } });
    expect(after.attemptCount).toBeLessThanOrEqual(1);
  });

  it('a post already published is never re-sent, whatever the caller does', async () => {
    const post = await queuedPost();
    const { fetchImpl, calls } = slowProvider({ id: `${PAGE_ID}_settled` });

    await publishPlatformPost({ prisma, platformPostId: post.id, fetchImpl });
    expect(calls).toHaveLength(1);

    // The idempotency check, still doing its own job after the claim was added.
    const again = await publishPlatformPost({ prisma, platformPostId: post.id, fetchImpl });
    expect(again.published).toBe(true);
    expect(again.externalPostId).toBe(`${PAGE_ID}_settled`);
    expect(calls).toHaveLength(1);
  });
});

/**
 * The same property on the `Content` path.
 *
 * `PublishingJob` has a unique key on (content, platform), so a *second job*
 * was already impossible. What was not impossible was two workers running the
 * *same* job — the claim there was a plain update by id, so both passed the
 * status check and both published.
 */
describe('publishing job claim', () => {
  let tenant: Tenant;

  beforeAll(async () => {
    await resetDatabase();
    tenant = await createTenant('job-claim');
    process.env.TOKEN_ENCRYPTION_KEY = 'Zm9yLXRlc3Rpbmctb25seS0zMi1ieXRlLWtleS0hIQ==';
  });

  it('only one caller can move a queued job into PUBLISHING', async () => {
    const client = agent();
    await client.login(tenant.adminEmail);

    const content = await prisma.content.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        name: 'Claim test',
        platform: Platform.FACEBOOK,
        type: 'POST',
        status: 'SCHEDULED',
        caption: 'A caption.',
      },
    });

    const job = await prisma.publishingJob.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        contentId: content.id,
        platform: Platform.FACEBOOK,
        status: PublishingJobStatus.QUEUED,
      },
    });

    /*
     * The claim itself, exercised directly.
     *
     * `runJob` needs a connected account and a live provider to get any
     * further, and none of that is what is under test here — the question is
     * whether the transition out of QUEUED is exclusive. Two conditional
     * updates racing is exactly what two workers do.
     */
    const claim = () =>
      prisma.publishingJob.updateMany({
        where: { id: job.id, status: PublishingJobStatus.QUEUED },
        data: { status: PublishingJobStatus.PUBLISHING, attempts: { increment: 1 } },
      });

    const [a, b] = await Promise.all([claim(), claim()]);

    expect(a.count + b.count).toBe(1);

    const after = await prisma.publishingJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe(PublishingJobStatus.PUBLISHING);
    expect(after.attempts).toBe(1);
  });
});

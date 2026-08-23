/**
 * Publishing to Facebook, and the many ways it must refuse to claim success.
 *
 * No real Graph call is possible from CI, so every response here is a fake with
 * the shape Meta actually returns — `{ id }` from /feed, `{ id, post_id }` from
 * /photos, and the OAuthException envelope with its numeric `code` for failures.
 * That makes these tests honest about one thing and silent about another: they
 * prove the workflow does the right thing with each answer, and they prove
 * nothing about whether Meta would give that answer. Only a real call does that.
 *
 * The assertion running through all of it: PUBLISHED is reachable only via an
 * external post id. Every failure path is checked for the absence of that
 * status, because a system that marks a post published when it is not is worse
 * than one that cannot publish at all.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AccountTokenStatus, ContentStatus, IntegrationStatus, Platform, PublishingJobStatus,
} from '@prisma/client';

import { createTenant, prisma, resetDatabase, type Tenant } from './helpers.js';
import { storage } from '../src/services/storage/index.js';
import { encryptSecret } from '../src/lib/crypto.js';
import { enqueue, runJob, checkReadiness, MAX_ATTEMPTS } from '../src/services/publishing/service.js';
import { sweepDue, drainQueue } from '../src/services/publishing/scheduler.js';
import { metaConfigDiagnostics, metaConfig } from '../src/services/integrations/meta.js';

const KEY = 'Zm9yLXRlc3Rpbmctb25seS0zMi1ieXRlLWtleS0hIQ==';

/** A fetch that answers once with whatever the test wants. */
function respondWith(body: unknown, status = 200) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = (async (url: string, init?: { body?: unknown }) => {
    calls.push({ url, body: init?.body });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }) as never;
  return { fetchImpl, calls };
}

/** Meta's error envelope, as it really arrives. */
const graphError = (code: number, message: string, subcode?: number) => ({
  error: { message, type: 'OAuthException', code, ...(subcode ? { error_subcode: subcode } : {}) },
});

describe('Facebook publishing', () => {
  let tenant: Tenant;
  let mediaId: string;

  beforeAll(async () => {
    await resetDatabase();
    tenant = await createTenant('fb-publish');
    process.env.TOKEN_ENCRYPTION_KEY = KEY;

    // A real object: the readiness check reads the bytes, and pointing at a key
    // that was never written is precisely what it exists to catch.
    const stored = await storage.save(Buffer.from('pretend-jpeg-bytes'), {
      filename: 'grooming.jpg',
      mimeType: 'image/jpeg',
      prefix: `clients/${tenant.clientId}/assets`,
    });

    const media = await prisma.media.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        type: 'IMAGE',
        filename: stored.key,
        originalName: 'grooming.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 18,
        url: '/api/media/x/file',
      },
    });
    mediaId = media.id;
  });

  beforeEach(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
    await prisma.publishingAttempt.deleteMany({});
    await prisma.publishingJob.deleteMany({});
    await prisma.integrationAccount.deleteMany({ where: { clientId: tenant.clientId } });
    await prisma.integration.deleteMany({ where: { clientId: tenant.clientId } });
  });

  /** A connected Page with a usable publishing token. */
  const connectPage = async (options: { token?: string | null; status?: AccountTokenStatus } = {}) => {
    const integration = await prisma.integration.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        platform: Platform.FACEBOOK,
        status: IntegrationStatus.CONNECTED,
      },
    });

    const token = options.token === undefined ? 'page-token-value' : options.token;
    return prisma.integrationAccount.create({
      data: {
        integrationId: integration.id,
        clientId: tenant.clientId,
        kind: 'PAGE',
        externalId: '1010101010',
        name: 'PawEase Official',
        selected: true,
        accessTokenEnc: token ? encryptSecret(token) : null,
        tokenStatus: options.status ?? (token ? AccountTokenStatus.UNKNOWN : AccountTokenStatus.REAUTH_REQUIRED),
      },
    });
  };

  const approvedContent = async (options: { withMedia?: boolean; caption?: string } = {}) =>
    prisma.content.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        name: 'PawEase Grooming – Less Mess',
        type: 'POST',
        platform: Platform.FACEBOOK,
        language: 'EN',
        caption: options.caption ?? 'Less mess, happier dog.',
        status: ContentStatus.APPROVED,
        ...(options.withMedia ? { mediaLinks: { create: [{ mediaId, position: 0 }] } } : {}),
      },
      select: { id: true },
    });

  const queueAndRun = async (contentId: string, fetchImpl: never) => {
    const queued = await enqueue({ prisma, contentId, organizationId: tenant.organizationId });
    if (!('jobId' in queued)) throw new Error(`refused: ${JSON.stringify(queued.refused.problems)}`);
    return runJob({ prisma, jobId: queued.jobId, fetchImpl });
  };

  // ------------------------------------------------------- app id validation

  it('reports the app id\'s shape without revealing it', () => {
    const diagnostics = metaConfigDiagnostics({
      META_APP_ID: '1821333942563322',
      META_CONFIG_ID: '1063587136062050',
      META_APP_SECRET: 'secret',
      META_REDIRECT_URI: 'https://example.test/api/integrations/meta/callback',
    } as NodeJS.ProcessEnv);

    expect(diagnostics.appIdNumeric).toBe(true);
    expect(diagnostics.appIdLength).toBe(16);
    expect(diagnostics.appIdEqualsConfigId).toBe(false);
    expect(diagnostics.valid).toBe(true);
    // The value itself must not be reachable through the diagnostics object.
    expect(JSON.stringify(diagnostics)).not.toContain('1821333942563322');
  });

  it('refuses a non-numeric app id and never echoes it', () => {
    const env = {
      META_APP_ID: 'https://developers.facebook.com/apps/123',
      META_CONFIG_ID: '1063587136062050',
      META_APP_SECRET: 'secret',
      META_REDIRECT_URI: 'https://example.test/api/integrations/meta/callback',
    } as NodeJS.ProcessEnv;

    expect(metaConfigDiagnostics(env).valid).toBe(false);
    try {
      metaConfig(env);
      throw new Error('should have refused');
    } catch (error) {
      expect((error as Error).message).toMatch(/META_APP_ID configuration is invalid/);
      expect((error as Error).message).not.toContain('developers.facebook.com/apps/123');
    }
  });

  it('refuses an app id that is really the configuration id', () => {
    const env = {
      META_APP_ID: '1063587136062050',
      META_CONFIG_ID: '1063587136062050',
      META_APP_SECRET: 'secret',
      META_REDIRECT_URI: 'https://example.test/api/integrations/meta/callback',
    } as NodeJS.ProcessEnv;

    expect(metaConfigDiagnostics(env).appIdEqualsConfigId).toBe(true);
    expect(() => metaConfig(env)).toThrow(/never equal/i);
  });

  it('reports missing Meta configuration as unconfigured, not invalid', () => {
    const diagnostics = metaConfigDiagnostics({} as NodeJS.ProcessEnv);
    expect(diagnostics.appIdConfigured).toBe(false);
    expect(diagnostics.valid).toBe(false);
  });

  // ------------------------------------------------------------- readiness

  it('refuses to queue when no Page is attached', async () => {
    const content = await approvedContent();
    const readiness = await checkReadiness({
      prisma, contentId: content.id, organizationId: tenant.organizationId,
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.problems.map((row) => row.problem)).toContain('NO_ACCOUNT_SELECTED');
  });

  it('refuses a Page connected before Page tokens were captured', async () => {
    // The backward-compatibility case: the row exists, looks connected, and has
    // no usable credential. It must not be assumed publishable.
    await connectPage({ token: null });
    const content = await approvedContent();

    const readiness = await checkReadiness({
      prisma, contentId: content.id, organizationId: tenant.organizationId,
    });

    expect(readiness.problems.map((row) => row.problem)).toContain('ACCOUNT_NEEDS_REAUTH');
  });

  // -------------------------------------------------------------- success

  it('publishes a text post and stores the external id', async () => {
    await connectPage();
    const content = await approvedContent();
    const { fetchImpl, calls } = respondWith({ id: '1010101010_987654321' });

    const outcome = await queueAndRun(content.id, fetchImpl);

    expect(outcome.status).toBe(PublishingJobStatus.PUBLISHED);
    expect(outcome.externalPostId).toBe('1010101010_987654321');
    expect(calls[0]?.url).toContain('/1010101010/feed');

    const after = await prisma.content.findUniqueOrThrow({ where: { id: content.id } });
    expect(after.status).toBe(ContentStatus.PUBLISHED);
    expect(after.publishedAt).toBeTruthy();
  });

  it('publishes an image post through /photos and prefers the feed story id', async () => {
    await connectPage();
    const content = await approvedContent({ withMedia: true });
    // /photos answers with the photo id *and* the feed post it created. The
    // latter is what a person can actually open.
    const { fetchImpl, calls } = respondWith({ id: '555', post_id: '1010101010_777' });

    const outcome = await queueAndRun(content.id, fetchImpl);

    expect(outcome.externalPostId).toBe('1010101010_777');
    expect(outcome.permalink).toBe('https://www.facebook.com/1010101010_777');
    expect(calls[0]?.url).toContain('/1010101010/photos');
    // The bytes are uploaded, not a URL handed over — this app serves media
    // from an authenticated endpoint Meta could never fetch.
    expect(calls[0]?.body).toBeInstanceOf(FormData);
  });

  it('never puts the page token in the stored job or attempt', async () => {
    await connectPage({ token: 'super-secret-page-token' });
    const content = await approvedContent();
    const { fetchImpl } = respondWith({ id: '1010101010_1' });

    await queueAndRun(content.id, fetchImpl);

    const job = await prisma.publishingJob.findFirstOrThrow({ where: { contentId: content.id } });
    const attempts = await prisma.publishingAttempt.findMany({ where: { jobId: job.id } });
    const serialized = JSON.stringify({ job, attempts });

    expect(serialized).not.toContain('super-secret-page-token');
  });

  // -------------------------------------------------------------- failure

  it('does not become PUBLISHED when the token is invalid', async () => {
    await connectPage();
    const content = await approvedContent();
    const { fetchImpl } = respondWith(graphError(190, 'Error validating access token'), 400);

    const outcome = await queueAndRun(content.id, fetchImpl);

    expect(outcome.status).toBe(PublishingJobStatus.FAILED);
    expect(outcome.error?.retryable).toBe(false);
    expect(outcome.externalPostId).toBeNull();

    const after = await prisma.content.findUniqueOrThrow({ where: { id: content.id } });
    expect(after.status).toBe(ContentStatus.PUBLISH_FAILED);
    expect(after.status).not.toBe(ContentStatus.PUBLISHED);
    expect(after.publishedAt).toBeNull();
  });

  it('explains a missing publishing permission in words an operator can act on', async () => {
    await connectPage();
    const content = await approvedContent();
    const { fetchImpl } = respondWith(
      graphError(200, 'If posting to a page, requires pages_manage_posts'),
      403,
    );

    const outcome = await queueAndRun(content.id, fetchImpl);

    expect(outcome.error?.retryable).toBe(false);
    expect(outcome.error?.message).toMatch(/pages_manage_posts/);
    // And Meta's own words are kept, not replaced.
    expect(outcome.error?.message).toMatch(/Meta said/);
  });

  it('treats an unknown Page as permanent, not retryable', async () => {
    await connectPage();
    const content = await approvedContent();
    const { fetchImpl } = respondWith(graphError(100, 'Unsupported get request', 33), 400);

    const outcome = await queueAndRun(content.id, fetchImpl);
    expect(outcome.error?.retryable).toBe(false);
  });

  it('refuses a 200 that carries no post id', async () => {
    await connectPage();
    const content = await approvedContent();
    // Success-shaped, but unconfirmable. Recording this as published would
    // create a post nobody can find, link to, or measure.
    const { fetchImpl } = respondWith({ success: true });

    const outcome = await queueAndRun(content.id, fetchImpl);

    expect(outcome.status).toBe(PublishingJobStatus.FAILED);
    const after = await prisma.content.findUniqueOrThrow({ where: { id: content.id } });
    expect(after.status).not.toBe(ContentStatus.PUBLISHED);
  });

  // ---------------------------------------------------------------- retry

  it('retries a rate limit and keeps the content out of PUBLISH_FAILED', async () => {
    await connectPage();
    const content = await approvedContent();
    const { fetchImpl } = respondWith(graphError(4, 'Application request limit reached'), 429);

    const outcome = await queueAndRun(content.id, fetchImpl);

    expect(outcome.status).toBe(PublishingJobStatus.QUEUED);
    expect(outcome.error?.retryable).toBe(true);

    const job = await prisma.publishingJob.findFirstOrThrow({ where: { contentId: content.id } });
    expect(job.nextAttemptAt).toBeTruthy();

    // Waiting is not failing. The operator has nothing to do yet.
    const after = await prisma.content.findUniqueOrThrow({ where: { id: content.id } });
    expect(after.status).toBe(ContentStatus.QUEUED);
  });

  it('gives up after the attempt limit rather than retrying forever', async () => {
    await connectPage();
    const content = await approvedContent();
    const { fetchImpl } = respondWith(graphError(2, 'Service temporarily unavailable'), 503);

    const queued = await enqueue({ prisma, contentId: content.id, organizationId: tenant.organizationId });
    if (!('jobId' in queued)) throw new Error('should have queued');

    let last = await runJob({ prisma, jobId: queued.jobId, fetchImpl });
    for (let i = 1; i < MAX_ATTEMPTS; i += 1) {
      last = await runJob({ prisma, jobId: queued.jobId, fetchImpl });
    }

    expect(last.status).toBe(PublishingJobStatus.FAILED);
    expect(last.error?.retryable).toBe(false);

    const job = await prisma.publishingJob.findUniqueOrThrow({ where: { id: queued.jobId } });
    expect(job.attempts).toBe(MAX_ATTEMPTS);

    const after = await prisma.content.findUniqueOrThrow({ where: { id: content.id } });
    expect(after.status).toBe(ContentStatus.PUBLISH_FAILED);
  });

  it('recovers after a transient failure and publishes on the retry', async () => {
    await connectPage();
    const content = await approvedContent();

    const failing = respondWith(graphError(2, 'Service temporarily unavailable'), 503);
    const queued = await enqueue({ prisma, contentId: content.id, organizationId: tenant.organizationId });
    if (!('jobId' in queued)) throw new Error('should have queued');
    await runJob({ prisma, jobId: queued.jobId, fetchImpl: failing.fetchImpl });

    const succeeding = respondWith({ id: '1010101010_recovered' });
    const outcome = await runJob({ prisma, jobId: queued.jobId, fetchImpl: succeeding.fetchImpl });

    expect(outcome.status).toBe(PublishingJobStatus.PUBLISHED);
    expect(outcome.externalPostId).toBe('1010101010_recovered');

    // Both tries are on the record: "worked eventually" is not "worked".
    const attempts = await prisma.publishingAttempt.findMany({ where: { jobId: queued.jobId } });
    expect(attempts).toHaveLength(2);
  });

  // --------------------------------------------------------- idempotency

  it('never publishes twice, however many times the worker runs the job', async () => {
    await connectPage();
    const content = await approvedContent();
    const { fetchImpl, calls } = respondWith({ id: '1010101010_once' });

    const queued = await enqueue({ prisma, contentId: content.id, organizationId: tenant.organizationId });
    if (!('jobId' in queued)) throw new Error('should have queued');

    await runJob({ prisma, jobId: queued.jobId, fetchImpl });
    const second = await runJob({ prisma, jobId: queued.jobId, fetchImpl });
    const third = await runJob({ prisma, jobId: queued.jobId, fetchImpl });

    // One call to Meta. The customer's followers must not see the post twice.
    expect(calls).toHaveLength(1);
    expect(second.deduplicated).toBe(true);
    expect(third.externalPostId).toBe('1010101010_once');
  });

  it('enqueueing twice reuses the one job', async () => {
    await connectPage();
    const content = await approvedContent();

    const first = await enqueue({ prisma, contentId: content.id, organizationId: tenant.organizationId });
    const second = await enqueue({ prisma, contentId: content.id, organizationId: tenant.organizationId });

    expect('jobId' in first && 'jobId' in second && first.jobId === second.jobId).toBe(true);
    expect(await prisma.publishingJob.count({ where: { contentId: content.id } })).toBe(1);
  });

  // ------------------------------------------------------------ scheduler

  it('sweeps due content into the queue without publishing it', async () => {
    await connectPage();
    const content = await prisma.content.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        name: 'Due now',
        type: 'POST',
        platform: Platform.FACEBOOK,
        language: 'EN',
        caption: 'Time to post.',
        status: ContentStatus.SCHEDULED,
        scheduledAt: new Date(Date.now() - 60_000),
      },
      select: { id: true },
    });

    const report = await sweepDue({ prisma });

    expect(report.queued).toContain(content.id);
    const after = await prisma.content.findUniqueOrThrow({ where: { id: content.id } });
    // The arrival of a scheduled time is not evidence that anything published.
    expect(after.status).toBe(ContentStatus.QUEUED);
    expect(after.publishedAt).toBeNull();
  });

  it('leaves content scheduled and explains why when it is not ready', async () => {
    // No Page attached at all.
    const content = await prisma.content.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        name: 'Not ready',
        type: 'POST',
        platform: Platform.FACEBOOK,
        language: 'EN',
        caption: 'Nowhere to go.',
        status: ContentStatus.SCHEDULED,
        scheduledAt: new Date(Date.now() - 60_000),
      },
      select: { id: true },
    });

    const report = await sweepDue({ prisma });

    expect(report.refused.some((row) => row.contentId === content.id)).toBe(true);
    const after = await prisma.content.findUniqueOrThrow({ where: { id: content.id } });
    expect(after.status).toBe(ContentStatus.SCHEDULED);
    expect(after.failureReason).toMatch(/No account is attached/i);
  });

  it('drains the queue and publishes', async () => {
    await connectPage();
    const content = await approvedContent();
    await enqueue({ prisma, contentId: content.id, organizationId: tenant.organizationId });

    const { fetchImpl } = respondWith({ id: '1010101010_drained' });
    const report = await drainQueue({ prisma, fetchImpl });

    expect(report.published).toHaveLength(1);
    const after = await prisma.content.findUniqueOrThrow({ where: { id: content.id } });
    expect(after.status).toBe(ContentStatus.PUBLISHED);
  });

  it('does not drain a job that is waiting out its backoff', async () => {
    await connectPage();
    const content = await approvedContent();
    const queued = await enqueue({ prisma, contentId: content.id, organizationId: tenant.organizationId });
    if (!('jobId' in queued)) throw new Error('should have queued');

    await prisma.publishingJob.update({
      where: { id: queued.jobId },
      data: { nextAttemptAt: new Date(Date.now() + 600_000) },
    });

    const { fetchImpl, calls } = respondWith({ id: 'should-not-happen' });
    const report = await drainQueue({ prisma, fetchImpl });

    expect(report.published).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

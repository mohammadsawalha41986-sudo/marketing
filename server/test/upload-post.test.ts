/**
 * Upload-Post: the route, the mapping, and the post that must not go out twice.
 *
 * Upload-Post is the first connection in this application that is not a
 * network. It publishes to seven of them, which means a restaurant can now
 * reach the same account two ways, and every test below exists because one of
 * those two ways could be taken wrongly:
 *
 *   isolation       a profile name derived from anything less than the client
 *                   id is one restaurant's Instagram publishing another's posts
 *
 *   mapping         three of the networks — TikTok, YouTube and X — all map to
 *                   a PROFILE-kind account, so a lookup by kind returns
 *                   whichever row the database ordered first, which is a post
 *                   published to the wrong network
 *
 *   duplicates      a direct connection and an Upload-Post profile both
 *                   carrying Instagram is two working paths to one account
 *
 *   failures        a refusal reported as a success is content marked PUBLISHED
 *                   that nobody ever saw
 *
 * The wire format asserted here — the base URL, the `Apikey` scheme, the
 * repeated `platform[]` field, the `Idempotency-Key` header, `photos[]` versus
 * `video` — is the one the official `upload-post` clients send. Every provider
 * call is a stub; nothing here publishes anything anywhere.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ContentStatus, ExternalAccountKind, IntegrationStatus, MediaType, Platform,
  PublishingJobStatus,
} from '@prisma/client';

import { createTenant, prisma, resetDatabase, type Tenant } from './helpers.js';
import {
  classifyUploadPostError,
  discoverFromProfile,
  platformForUploadPost,
  profileUsernameFor,
  routablePlatforms,
  uploadPostConfig,
  uploadPostConfigured,
  uploadPostPlatform,
  type UploadPostFetch,
} from '../src/services/integrations/upload-post.js';
import {
  beginUploadPostConnection, disconnectUploadPost, refreshUploadPostAccounts,
} from '../src/services/integrations/upload-post-flow.js';
import { resolveRoute, routeCoverage } from '../src/services/publishing/route.js';
import { publisherFor } from '../src/services/publishing/registry.js';
import { selectAccounts } from '../src/services/integrations/connect-flow.js';
import { enqueue, runJob } from '../src/services/publishing/service.js';
import { encryptSecret } from '../src/lib/crypto.js';

const KEY = 'Zm9yLXRlc3Rpbmctb25seS0zMi1ieXRlLWtleS0hIQ==';
const API_KEY = 'up-test-key-never-real';
const BASE = 'https://marketing.norivaglobal.com';

/** One recorded call, so the wire format can be asserted rather than assumed. */
interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Upload-Post's endpoints, answering from a scripted profile.
 *
 * Records every call so the tests can assert what was actually sent — the
 * authorisation scheme, the repeated platform field, the idempotency key —
 * rather than trusting that the module built them correctly.
 */
function uploadPostStub(script: {
  profiles?: Array<{ username: string; social_accounts: Record<string, unknown> }>;
  upload?: { status?: number; body: unknown };
  status?: { body: unknown };
  connectionUrl?: string;
} = {}) {
  const calls: Call[] = [];
  const profiles = script.profiles ? [...script.profiles] : [];

  const fetchImpl = (async (url: string, init?: {
    method?: string; headers?: Record<string, string>; body?: unknown;
  }) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body: init?.body,
    });

    const answer = (body: unknown, status = 200) => ({
      ok: status < 400,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });

    if (url.includes('/uploadposts/users/generate-jwt')) {
      return answer({
        success: true,
        jwt: 'jwt-not-a-real-token',
        connection_url: script.connectionUrl ?? 'https://app.upload-post.com/connect/abc123',
      });
    }
    if (url.includes('/uploadposts/users')) {
      const method = init?.method ?? 'GET';
      if (method === 'POST') {
        const parsed = JSON.parse(String(init?.body ?? '{}')) as { username: string };
        profiles.push({ username: parsed.username, social_accounts: {} });
        return answer({ success: true });
      }
      if (method === 'DELETE') {
        const parsed = JSON.parse(String(init?.body ?? '{}')) as { username: string };
        const index = profiles.findIndex((profile) => profile.username === parsed.username);
        if (index >= 0) profiles.splice(index, 1);
        return answer({ success: true });
      }
      return answer({ success: true, profiles });
    }
    if (url.includes('/uploadposts/status')) {
      return answer(script.status?.body ?? { success: true, status: 'completed', data: { platforms: [] } });
    }
    if (url.includes('/upload_photos') || url.includes('/upload_text') || url.includes('/upload')) {
      const upload = script.upload ?? {
        body: { success: true, request_id: 'req-1', data: { platforms: [{ name: 'instagram', url: 'https://instagram.com/p/xyz' }] } },
      };
      return answer(upload.body, upload.status ?? 200);
    }
    throw new Error(`No stub for ${url}`);
  }) as UploadPostFetch;

  return { fetchImpl, calls, profiles };
}

const INSTAGRAM_LINKED = {
  username: '',
  social_accounts: {
    instagram: { id: 'ig-1', username: 'pawse.kitchen', display_name: 'Pawse Kitchen' },
  },
};

/** Link Upload-Post for a tenant and attach the accounts named. */
async function connectAndAttach(input: {
  tenant: Tenant;
  socialAccounts: Record<string, unknown>;
  attach?: 'all' | string[];
}) {
  const username = profileUsernameFor(input.tenant.clientId);
  const stub = uploadPostStub({ profiles: [{ username, social_accounts: input.socialAccounts }] });

  await beginUploadPostConnection({
    prisma,
    organizationId: input.tenant.organizationId,
    clientId: input.tenant.clientId,
    returnUrl: `${BASE}/app/integrations`,
    fetchImpl: stub.fetchImpl,
  });

  const { integrationId } = await refreshUploadPostAccounts({
    prisma,
    organizationId: input.tenant.organizationId,
    clientId: input.tenant.clientId,
    fetchImpl: stub.fetchImpl,
  });

  const accounts = await prisma.integrationAccount.findMany({ where: { integrationId } });
  const chosen = input.attach === undefined || input.attach === 'all'
    ? accounts.map((account) => account.id)
    : accounts.filter((a) => input.attach!.includes(a.externalId)).map((a) => a.id);

  if (chosen.length > 0) {
    await selectAccounts({
      integrationId,
      organizationId: input.tenant.organizationId,
      accountIds: chosen,
    });
  }

  return { integrationId, stub, accounts };
}

describe('upload-post', () => {
  let alpha: Tenant;
  let beta: Tenant;
  const saved = { ...process.env };

  beforeAll(async () => {
    await resetDatabase();
    alpha = await createTenant('up-a');
    beta = await createTenant('up-b');
  });

  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
    process.env.UPLOAD_POST_API_KEY = API_KEY;
  });

  afterEach(async () => {
    for (const key of ['TOKEN_ENCRYPTION_KEY', 'UPLOAD_POST_API_KEY']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await prisma.publishingAttempt.deleteMany({});
    await prisma.publishingJob.deleteMany({});
    await prisma.integration.deleteMany({});
  });

  // ------------------------------------------------------------- the wire

  it('authorises with the Apikey scheme against the documented host', async () => {
    const stub = uploadPostStub({ profiles: [] });

    await beginUploadPostConnection({
      prisma,
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      returnUrl: `${BASE}/app/integrations`,
      fetchImpl: stub.fetchImpl,
    });

    expect(stub.calls.length).toBeGreaterThan(0);
    for (const call of stub.calls) {
      expect(call.url.startsWith('https://api.upload-post.com/api/')).toBe(true);
      // The scheme the official clients send. `Bearer` is refused by the API.
      expect(call.headers.authorization).toBe(`Apikey ${API_KEY}`);
    }
  });

  it('never puts the API key anywhere a browser could read it', async () => {
    const stub = uploadPostStub({ profiles: [] });

    const result = await beginUploadPostConnection({
      prisma,
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      returnUrl: `${BASE}/app/integrations`,
      fetchImpl: stub.fetchImpl,
    });

    // What the route hands the browser: a hosted URL and a profile name.
    expect(JSON.stringify(result)).not.toContain(API_KEY);

    const integration = await prisma.integration.findUniqueOrThrow({ where: { id: result.integrationId } });
    // Nothing of the key is stored against the connection either — there is no
    // per-client credential for this provider, by design.
    expect(JSON.stringify(integration)).not.toContain(API_KEY);
    expect(integration.accessTokenEnc).toBeNull();
  });

  it('refuses to be configured by a missing variable rather than guessing one', () => {
    delete process.env.UPLOAD_POST_API_KEY;

    expect(uploadPostConfigured()).toBe(false);
    expect(() => uploadPostConfig()).toThrowError(/UPLOAD_POST_API_KEY/);
  });

  // -------------------------------------------------------- project isolation

  it('gives every restaurant its own profile, derived from its own id', async () => {
    const a = profileUsernameFor(alpha.clientId);
    const b = profileUsernameFor(beta.clientId);

    expect(a).not.toBe(b);
    expect(a).toContain(alpha.clientId);
    // A name that could be chosen, or shared, is one restaurant's accounts
    // publishing another's posts.
    expect(b).toContain(beta.clientId);
  });

  it('keeps one restaurant\'s linked accounts off another\'s', async () => {
    await connectAndAttach({ tenant: alpha, socialAccounts: INSTAGRAM_LINKED.social_accounts });
    await connectAndAttach({
      tenant: beta,
      socialAccounts: { tiktok: { id: 'tt-9', username: 'other.brand' } },
    });

    const alphaRoute = await resolveRoute({
      prisma,
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      platform: Platform.INSTAGRAM,
    });
    const betaInstagram = await resolveRoute({
      prisma,
      organizationId: beta.organizationId,
      clientId: beta.clientId,
      platform: Platform.INSTAGRAM,
    });

    expect(alphaRoute?.target.externalId).toBe('ig-1');
    // Beta linked TikTok, not Instagram. It must resolve to nothing rather than
    // to the only Instagram account in the database.
    expect(betaInstagram).toBeNull();

    // And alpha's organisation cannot reach beta's account by asking for it.
    const crossTenant = await resolveRoute({
      prisma,
      organizationId: alpha.organizationId,
      clientId: beta.clientId,
      platform: Platform.TIKTOK,
    });
    expect(crossTenant).toBeNull();
  });

  // ---------------------------------------------------------- account mapping

  it('maps each linked network onto the platform this product models', () => {
    expect(uploadPostPlatform(Platform.INSTAGRAM)).toBe('instagram');
    expect(uploadPostPlatform(Platform.GOOGLE_BUSINESS)).toBe('google_business');
    expect(platformForUploadPost('tiktok')).toBe(Platform.TIKTOK);
    expect(platformForUploadPost('x')).toBe(Platform.X);

    // Networks Upload-Post does not publish to, or that are not organic
    // surfaces. A guessed mapping here is a post sent nowhere.
    expect(uploadPostPlatform(Platform.SNAPCHAT)).toBeNull();
    expect(uploadPostPlatform(Platform.GOOGLE_ADS)).toBeNull();
    expect(platformForUploadPost('discord')).toBeNull();
  });

  it('discovers a linked account per network and records how to address it', () => {
    const { accounts } = discoverFromProfile({
      username: 'noriva-x',
      socialAccounts: {
        instagram: { id: 'ig-1', username: 'pawse', display_name: 'Pawse Kitchen' },
        tiktok: { id: 'tt-1', username: 'pawse.tiktok' },
        // A network this product does not model. Skipped, not invented.
        discord: { id: 'dc-1', username: 'pawse' },
      },
      createdAt: null,
    });

    expect(accounts).toHaveLength(2);

    const instagram = accounts.find((a) => a.externalId === 'ig-1');
    expect(instagram?.kind).toBe('INSTAGRAM');
    expect(instagram?.name).toBe('Pawse Kitchen');
    // The two facts the route is resolved from. Without both, a post is
    // addressed to the wrong profile or the wrong network.
    expect(instagram?.metadata).toMatchObject({
      uploadPostProfile: 'noriva-x',
      uploadPostPlatform: 'instagram',
    });
    // No credential is invented for an account that has none.
    expect(instagram?.accessToken).toBeUndefined();
  });

  it('tells apart three networks that share one account kind', async () => {
    // TikTok, YouTube and X are all PROFILE-kind. Resolving by kind would
    // return whichever row the database ordered first — a post published to the
    // wrong network, which is worse than not publishing.
    const { integrationId } = await connectAndAttach({
      tenant: alpha,
      socialAccounts: {
        tiktok: { id: 'tt-1', username: 'pawse.tiktok' },
        youtube: { id: 'yt-1', username: 'PawseKitchen' },
        x: { id: 'x-1', username: 'pawse' },
      },
    });

    const rows = await prisma.integrationAccount.findMany({ where: { integrationId } });
    expect(rows.every((row) => row.kind === ExternalAccountKind.PROFILE)).toBe(true);

    for (const [platform, externalId] of [
      [Platform.TIKTOK, 'tt-1'],
      [Platform.YOUTUBE, 'yt-1'],
      [Platform.X, 'x-1'],
    ] as const) {
      const resolved = await resolveRoute({
        prisma,
        organizationId: alpha.organizationId,
        clientId: alpha.clientId,
        platform,
      });
      expect(resolved?.route).toBe('UPLOAD_POST');
      expect(resolved?.target.externalId).toBe(externalId);
    }
  });

  it('reports a linked account it cannot identify instead of dropping it', () => {
    const { accounts, refusals } = discoverFromProfile({
      username: 'noriva-x',
      // Linked, but described in a shape with no identifier in it.
      socialAccounts: { instagram: { connected: true } },
      createdAt: null,
    });

    expect(accounts).toHaveLength(0);
    expect(refusals?.[0]?.externalId).toBe('instagram');
    expect(refusals?.[0]?.message).toMatch(/without an identifier/i);
  });

  it('attaches nothing the operator did not choose', async () => {
    const { integrationId } = await connectAndAttach({
      tenant: alpha,
      socialAccounts: {
        instagram: { id: 'ig-1', username: 'pawse' },
        tiktok: { id: 'tt-1', username: 'pawse.tiktok' },
      },
      attach: ['ig-1'],
    });

    const rows = await prisma.integrationAccount.findMany({ where: { integrationId } });
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.selected).map((row) => row.externalId)).toEqual(['ig-1']);

    // The unattached network resolves to nothing: discovery is not attachment.
    const tiktok = await resolveRoute({
      prisma,
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      platform: Platform.TIKTOK,
    });
    expect(tiktok).toBeNull();
  });

  it('does not re-attach a network the operator removed', async () => {
    const socialAccounts = { instagram: { id: 'ig-1', username: 'pawse' } };
    const { integrationId } = await connectAndAttach({ tenant: alpha, socialAccounts, attach: [] });

    const stub = uploadPostStub({
      profiles: [{ username: profileUsernameFor(alpha.clientId), social_accounts: socialAccounts }],
    });
    await refreshUploadPostAccounts({
      prisma,
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      fetchImpl: stub.fetchImpl,
    });

    const rows = await prisma.integrationAccount.findMany({ where: { integrationId } });
    expect(rows.some((row) => row.selected)).toBe(false);
  });

  // ------------------------------------------------------ duplicate prevention

  it('publishes through the direct connection when a restaurant has both', async () => {
    await connectAndAttach({ tenant: alpha, socialAccounts: INSTAGRAM_LINKED.social_accounts });

    // The same restaurant also connects Instagram directly.
    const direct = await prisma.integration.create({
      data: {
        organizationId: alpha.organizationId,
        clientId: alpha.clientId,
        platform: Platform.INSTAGRAM,
        status: IntegrationStatus.CONNECTED,
      },
      select: { id: true },
    });
    await prisma.integrationAccount.create({
      data: {
        integrationId: direct.id,
        clientId: alpha.clientId,
        kind: ExternalAccountKind.INSTAGRAM,
        externalId: 'ig-direct',
        name: 'Pawse Kitchen (direct)',
        selected: true,
        accessTokenEnc: encryptSecret('direct-token'),
        tokenStatus: 'TOKEN_VALID',
      },
    });

    const resolved = await resolveRoute({
      prisma,
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      platform: Platform.INSTAGRAM,
    });

    /*
     * One route, and it is the direct one. This is the whole duplicate
     * guarantee: both connections exist and are attached, and the resolver
     * still returns exactly one target — so there is only ever one post.
     */
    expect(resolved?.route).toBe('DIRECT');
    expect(resolved?.target.externalId).toBe('ig-direct');
  });

  it('falls back to Upload-Post only where nothing direct is attached', async () => {
    await connectAndAttach({
      tenant: alpha,
      socialAccounts: {
        instagram: { id: 'ig-1', username: 'pawse' },
        tiktok: { id: 'tt-1', username: 'pawse.tiktok' },
      },
    });

    const direct = await prisma.integration.create({
      data: {
        organizationId: alpha.organizationId,
        clientId: alpha.clientId,
        platform: Platform.INSTAGRAM,
        status: IntegrationStatus.CONNECTED,
      },
      select: { id: true },
    });
    await prisma.integrationAccount.create({
      data: {
        integrationId: direct.id,
        clientId: alpha.clientId,
        kind: ExternalAccountKind.INSTAGRAM,
        externalId: 'ig-direct',
        name: 'Direct',
        selected: true,
        accessTokenEnc: encryptSecret('direct-token'),
        tokenStatus: 'TOKEN_VALID',
      },
    });

    const coverage = await routeCoverage({
      prisma,
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      platforms: [Platform.INSTAGRAM, Platform.TIKTOK, Platform.YOUTUBE],
    });

    expect(coverage).toEqual([
      { platform: Platform.INSTAGRAM, route: 'DIRECT', accountName: 'Direct' },
      { platform: Platform.TIKTOK, route: 'UPLOAD_POST', accountName: 'pawse.tiktok' },
      // Linked to neither. Reported as uncovered rather than silently absent.
      { platform: Platform.YOUTUBE, route: null, accountName: null },
    ]);
  });

  // ------------------------------------------------------------- publishing

  it('publishes a caption and an image, and records the provider\'s own id', async () => {
    const { content, stub } = await publishThroughUploadPost({
      tenant: alpha,
      upload: {
        body: {
          success: true,
          request_id: 'req-77',
          data: { platforms: [{ name: 'instagram', url: 'https://instagram.com/p/xyz' }] },
        },
      },
    });

    const job = await prisma.publishingJob.findFirstOrThrow({ where: { contentId: content.id } });
    expect(job.status).toBe(PublishingJobStatus.PUBLISHED);
    // Upload-Post's id, never one we made up.
    expect(job.externalPostId).toBe('req-77');
    expect(job.permalink).toBe('https://instagram.com/p/xyz');

    const published = await prisma.content.findUniqueOrThrow({ where: { id: content.id } });
    expect(published.status).toBe(ContentStatus.PUBLISHED);

    // The wire format, as the official clients send it.
    const upload = stub.calls.find((call) => call.url.includes('/upload_photos'));
    expect(upload).toBeDefined();
    expect(upload!.method).toBe('POST');
    // A stable key, so a retry collapses into this post rather than duplicating it.
    expect(upload!.headers['idempotency-key']).toBe(job.id);

    const form = upload!.body as FormData;
    expect(form.get('user')).toBe(profileUsernameFor(alpha.clientId));
    // Repeated, not comma-joined: a joined value reads as one platform named "a,b".
    expect(form.getAll('platform[]')).toEqual(['instagram']);
    expect(form.get('title')).toContain('Fresh mezze');
    expect(form.getAll('photos[]')).toHaveLength(1);
    // The bytes, so no public copy of a customer's creative is made.
    expect(form.get('photos[]')).toBeInstanceOf(File);
  });

  it('sends a video to the video endpoint, for reels and shorts', async () => {
    const { stub } = await publishThroughUploadPost({
      tenant: alpha,
      mediaType: MediaType.VIDEO,
      upload: {
        body: {
          success: true,
          request_id: 'req-88',
          data: { platforms: [{ name: 'instagram', url: 'https://instagram.com/reel/abc' }] },
        },
      },
    });

    // `/upload` with a `video` part, never `/upload_photos` with a video in it.
    const upload = stub.calls.find((call) => call.url.endsWith('/api/upload'));
    expect(upload).toBeDefined();
    const form = upload!.body as FormData;
    expect(form.get('video')).toBeInstanceOf(File);
    expect(form.getAll('photos[]')).toHaveLength(0);
  });

  it('waits for an accepted upload to become a real post', async () => {
    const { content } = await publishThroughUploadPost({
      tenant: alpha,
      // Accepted for asynchronous processing: no per-network result yet.
      upload: { body: { success: true, request_id: 'req-99' } },
      status: {
        body: {
          success: true,
          status: 'completed',
          data: { platforms: [{ name: 'instagram', url: 'https://instagram.com/p/late' }] },
        },
      },
    });

    const job = await prisma.publishingJob.findFirstOrThrow({ where: { contentId: content.id } });
    /*
     * An acknowledgement is not a publication. The job is PUBLISHED only
     * because the status endpoint returned a result for this network.
     */
    expect(job.status).toBe(PublishingJobStatus.PUBLISHED);
    expect(job.permalink).toBe('https://instagram.com/p/late');
  });

  // -------------------------------------------------------------- scheduling

  it('publishes a scheduled post through the calendar the operator already uses', async () => {
    /*
     * NORIVA's own scheduler owns *when*, and deliberately so. Upload-Post can
     * be handed a `scheduled_date`, and handing it one would mean two
     * schedulers for one post — this application marking content PUBLISHED on
     * the strength of an acknowledgement that nothing had published yet. So the
     * post is swept at its due time and sent then, and `scheduled_date` is
     * never on the wire. This asserts both halves.
     */
    const { sweepDue, drainQueue } = await import('../src/services/publishing/scheduler.js');

    const { content, connectStub } = await scheduleThroughUploadPost({
      tenant: alpha,
      // Due a minute ago: the sweep should take it.
      scheduledAt: new Date(Date.now() - 60_000),
    });

    const swept = await sweepDue({ prisma, now: new Date() });
    expect(swept.queued).toContain(content.id);

    const stub = uploadPostStub({
      profiles: [{
        username: profileUsernameFor(alpha.clientId),
        social_accounts: { instagram: { id: 'ig-1', username: 'pawse' } },
      }],
      upload: {
        body: {
          success: true,
          request_id: 'req-sched',
          data: { platforms: [{ name: 'instagram', url: 'https://instagram.com/p/sched' }] },
        },
      },
    });

    await drainQueue({ prisma, fetchImpl: stub.fetchImpl as never, now: new Date() });

    const job = await prisma.publishingJob.findFirstOrThrow({ where: { contentId: content.id } });
    expect(job.status).toBe(PublishingJobStatus.PUBLISHED);
    expect(job.externalPostId).toBe('req-sched');

    const upload = stub.calls.find((call) => call.url.includes('/upload_photos'));
    const form = upload!.body as FormData;
    // The schedule was ours to keep. Sending it to Upload-Post as well would be
    // a second scheduler for one post.
    expect(form.get('scheduled_date')).toBeNull();
    expect(connectStub.calls.length).toBeGreaterThan(0);
  });

  it('does not publish a scheduled post before it is due', async () => {
    const { sweepDue } = await import('../src/services/publishing/scheduler.js');

    const { content } = await scheduleThroughUploadPost({
      tenant: alpha,
      scheduledAt: new Date(Date.now() + 60 * 60_000),
    });

    const swept = await sweepDue({ prisma, now: new Date() });
    expect(swept.queued).not.toContain(content.id);

    const job = await prisma.publishingJob.findFirst({ where: { contentId: content.id } });
    // The arrival of a scheduled time is what queues a post. Nothing before it.
    expect(job).toBeNull();
  });

  // ---------------------------------------------------------------- failures

  it('fails the post when the network refuses it, rather than marking it published', async () => {
    const { content } = await publishThroughUploadPost({
      tenant: alpha,
      upload: {
        body: {
          // The envelope succeeded; the network did not. Reporting this as a
          // publication is the exact lie the whole subsystem exists to prevent.
          success: true,
          request_id: 'req-bad',
          data: { platforms: [{ name: 'instagram', error: 'The media aspect ratio is not supported.' }] },
        },
      },
    });

    const job = await prisma.publishingJob.findFirstOrThrow({ where: { contentId: content.id } });
    expect(job.status).not.toBe(PublishingJobStatus.PUBLISHED);
    expect(job.externalPostId).toBeNull();
    expect(job.errorMessage).toBeTruthy();

    const failed = await prisma.content.findUniqueOrThrow({ where: { id: content.id } });
    expect(failed.status).not.toBe(ContentStatus.PUBLISHED);
  });

  it('never echoes the API key into a stored failure', async () => {
    const { content } = await publishThroughUploadPost({
      tenant: alpha,
      upload: { status: 401, body: { success: false, message: 'Invalid API key' } },
    });

    const job = await prisma.publishingJob.findFirstOrThrow({ where: { contentId: content.id } });
    expect(job.errorMessage).toBeTruthy();
    expect(job.errorMessage).not.toContain(API_KEY);
    // A revoked key is the deployment's problem; the message must say so rather
    // than sending the operator to reconnect this restaurant.
    expect(job.errorMessage).toMatch(/API key/i);

    const attempts = await prisma.publishingAttempt.findMany({ where: { jobId: job.id } });
    for (const attempt of attempts) {
      expect(JSON.stringify(attempt)).not.toContain(API_KEY);
    }
  });

  it('separates a failure worth retrying from one that needs a person', () => {
    // Retryable: the request would very likely succeed in a minute.
    expect(classifyUploadPostError('Too many requests', 429)).toBe('RATE_LIMITED');
    expect(classifyUploadPostError('Bad gateway', 502)).toBe('PROVIDER_UNAVAILABLE');

    // Permanent until a human changes something. Retrying these burns rate
    // limit and buries the real cause.
    expect(classifyUploadPostError('Invalid API key', 401)).toBe('INVALID_KEY');
    expect(classifyUploadPostError('Profile not found', 404)).toBe('PROFILE_NOT_FOUND');
    expect(classifyUploadPostError('Account is not linked', 400)).toBe('ACCOUNT_NOT_LINKED');
    expect(classifyUploadPostError('The video duration is too long', 400)).toBe('INVALID_MEDIA');
  });

  it('refuses to publish without an idempotency key rather than risk a duplicate', async () => {
    const publisher = publisherFor(Platform.INSTAGRAM, 'UPLOAD_POST');
    const stub = uploadPostStub();

    const result = await publisher!.publish({
      caption: 'Hello',
      media: [],
      account: {
        externalId: 'ig-1',
        name: 'Pawse',
        accessToken: '',
        metadata: { uploadPostProfile: 'noriva-x', uploadPostPlatform: 'instagram' },
      },
      fetchImpl: stub.fetchImpl as never,
      // No idempotencyKey. A generated one would differ on every attempt, which
      // is precisely the duplicate it exists to prevent.
    });

    expect(result.success).toBe(false);
    expect(stub.calls).toHaveLength(0);
  });

  it('refuses an account addressed to a different network than the post', async () => {
    const publisher = publisherFor(Platform.INSTAGRAM, 'UPLOAD_POST');
    const stub = uploadPostStub();

    const result = await publisher!.publish({
      caption: 'Hello',
      media: [],
      account: {
        externalId: 'tt-1',
        name: 'Pawse TikTok',
        accessToken: '',
        // A TikTok account handed to the Instagram publisher. Nothing is sent.
        metadata: { uploadPostProfile: 'noriva-x', uploadPostPlatform: 'tiktok' },
      },
      fetchImpl: stub.fetchImpl as never,
      idempotencyKey: 'post-1',
    });

    expect(result.success).toBe(false);
    expect(stub.calls).toHaveLength(0);
  });

  // ------------------------------------------------------------- disconnect

  it('detaches every account on disconnect, and keeps the profile by default', async () => {
    const { integrationId } = await connectAndAttach({
      tenant: alpha,
      socialAccounts: INSTAGRAM_LINKED.social_accounts,
    });

    const stub = uploadPostStub({
      profiles: [{ username: profileUsernameFor(alpha.clientId), social_accounts: {} }],
    });
    const result = await disconnectUploadPost({
      prisma,
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      fetchImpl: stub.fetchImpl,
    });

    expect(result.disconnected).toBe(true);
    expect(result.profileDeleted).toBe(false);
    // No delete was sent: the profile is kept so reconnecting does not mean
    // linking every network again.
    expect(stub.calls.some((call) => call.method === 'DELETE')).toBe(false);

    const integration = await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } });
    expect(integration.status).toBe(IntegrationStatus.DISCONNECTED);

    // Nothing may publish through a disconnected route.
    const resolved = await resolveRoute({
      prisma,
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      platform: Platform.INSTAGRAM,
    });
    expect(resolved).toBeNull();
  });

  it('deletes the remote profile when the operator asks for it', async () => {
    await connectAndAttach({ tenant: alpha, socialAccounts: INSTAGRAM_LINKED.social_accounts });

    const stub = uploadPostStub({
      profiles: [{ username: profileUsernameFor(alpha.clientId), social_accounts: {} }],
    });
    const result = await disconnectUploadPost({
      prisma,
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      deleteRemoteProfile: true,
      fetchImpl: stub.fetchImpl,
    });

    expect(result.profileDeleted).toBe(true);
    expect(stub.profiles).toHaveLength(0);
  });

  // ------------------------------------------- the composer's own workflow

  it('publishes a composed post with no account pinned, through the resolved route', async () => {
    /*
     * The workflow an operator actually uses. The composer asks which platforms
     * a post goes to and never which account — so every post it creates has
     * `integrationAccountId: null`, and until the route was resolved at publish
     * time such a post could not go out at all, for any provider. This drives
     * the real path: create the group, attach media, publish, read the result.
     */
    const { createGroup, publishPlatformPost } = await import('../src/services/social/post-groups.js');

    await connectAndAttach({ tenant: alpha, socialAccounts: INSTAGRAM_LINKED.social_accounts });
    const media = await testMedia(alpha, MediaType.IMAGE);

    const group = await createGroup({
      prisma,
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      createdById: alpha.adminId,
      name: 'Composed post',
      shared: { caption: 'Fresh mezze daily', mediaIds: [media.id] },
      // Exactly what the composer sends: a platform, and no account.
      platforms: [{ platform: Platform.INSTAGRAM }],
    });

    const post = await prisma.platformPost.findFirstOrThrow({ where: { postGroupId: group.id } });
    expect(post.integrationAccountId).toBeNull();

    const stub = uploadPostStub({
      profiles: [{
        username: profileUsernameFor(alpha.clientId),
        social_accounts: INSTAGRAM_LINKED.social_accounts,
      }],
      upload: {
        body: {
          success: true,
          request_id: 'req-composed',
          data: { platforms: [{ name: 'instagram', url: 'https://instagram.com/p/composed' }] },
        },
      },
    });

    await approveAndQueue(alpha, post.id);

    const result = await publishPlatformPost({
      prisma,
      platformPostId: post.id,
      fetchImpl: stub.fetchImpl as never,
    });

    expect(result.published).toBe(true);
    expect(result.externalPostId).toBe('req-composed');

    const published = await prisma.platformPost.findUniqueOrThrow({ where: { id: post.id } });
    expect(published.status).toBe('PUBLISHED');
    // The connection it went out through is now on the row, so the record says
    // what published it and the next attempt does not resolve again.
    expect(published.integrationAccountId).not.toBeNull();
    expect(published.externalPostId).toBe('req-composed');
  });

  it('keeps a pinned account rather than re-resolving it', async () => {
    const { createGroup, publishPlatformPost } = await import('../src/services/social/post-groups.js');

    const { integrationId } = await connectAndAttach({
      tenant: alpha,
      socialAccounts: INSTAGRAM_LINKED.social_accounts,
    });
    const pinned = await prisma.integrationAccount.findFirstOrThrow({ where: { integrationId } });
    const media = await testMedia(alpha, MediaType.IMAGE);

    const group = await createGroup({
      prisma,
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      createdById: alpha.adminId,
      name: 'Pinned post',
      shared: { caption: 'Fresh mezze daily', mediaIds: [media.id] },
      platforms: [{ platform: Platform.INSTAGRAM, integrationAccountId: pinned.id }],
    });

    const post = await prisma.platformPost.findFirstOrThrow({ where: { postGroupId: group.id } });
    const stub = uploadPostStub({
      profiles: [{
        username: profileUsernameFor(alpha.clientId),
        social_accounts: INSTAGRAM_LINKED.social_accounts,
      }],
      upload: {
        body: {
          success: true,
          request_id: 'req-pinned',
          data: { platforms: [{ name: 'instagram', url: 'https://instagram.com/p/pinned' }] },
        },
      },
    });

    await approveAndQueue(alpha, post.id);
    await publishPlatformPost({ prisma, platformPostId: post.id, fetchImpl: stub.fetchImpl as never });

    const published = await prisma.platformPost.findUniqueOrThrow({ where: { id: post.id } });
    expect(published.integrationAccountId).toBe(pinned.id);
  });

  it('refuses a composed post for a network nothing is connected for', async () => {
    const { createGroup, publishPlatformPost } = await import('../src/services/social/post-groups.js');

    // Instagram linked; nothing for LinkedIn.
    await connectAndAttach({ tenant: alpha, socialAccounts: INSTAGRAM_LINKED.social_accounts });
    const media = await testMedia(alpha, MediaType.IMAGE);

    const group = await createGroup({
      prisma,
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      createdById: alpha.adminId,
      name: 'Unconnected network',
      shared: { caption: 'Fresh mezze daily', mediaIds: [media.id] },
      platforms: [{ platform: Platform.LINKEDIN }],
    });

    const post = await prisma.platformPost.findFirstOrThrow({ where: { postGroupId: group.id } });
    const stub = uploadPostStub();

    const result = await publishPlatformPost({
      prisma,
      platformPostId: post.id,
      fetchImpl: stub.fetchImpl as never,
    });

    expect(result.published).toBe(false);
    // Named for what is missing — a connection — not for a token that was never
    // going to exist. And nothing was sent.
    expect(result.error).toMatch(/no LINKEDIN account is connected/i);
    expect(stub.calls).toHaveLength(0);
  });

  it('does not publish a composed post twice when a retry follows a success', async () => {
    const { createGroup, publishPlatformPost } = await import('../src/services/social/post-groups.js');

    await connectAndAttach({ tenant: alpha, socialAccounts: INSTAGRAM_LINKED.social_accounts });
    const media = await testMedia(alpha, MediaType.IMAGE);

    const group = await createGroup({
      prisma,
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      createdById: alpha.adminId,
      name: 'Retried post',
      shared: { caption: 'Fresh mezze daily', mediaIds: [media.id] },
      platforms: [{ platform: Platform.INSTAGRAM }],
    });
    const post = await prisma.platformPost.findFirstOrThrow({ where: { postGroupId: group.id } });

    const stub = uploadPostStub({
      profiles: [{
        username: profileUsernameFor(alpha.clientId),
        social_accounts: INSTAGRAM_LINKED.social_accounts,
      }],
      upload: {
        body: {
          success: true,
          request_id: 'req-once',
          data: { platforms: [{ name: 'instagram', url: 'https://instagram.com/p/once' }] },
        },
      },
    });

    await approveAndQueue(alpha, post.id);

    await publishPlatformPost({ prisma, platformPostId: post.id, fetchImpl: stub.fetchImpl as never });
    const uploadsAfterFirst = stub.calls.filter((call) => call.url.includes('/upload_photos')).length;

    await publishPlatformPost({ prisma, platformPostId: post.id, fetchImpl: stub.fetchImpl as never });
    const uploadsAfterSecond = stub.calls.filter((call) => call.url.includes('/upload_photos')).length;

    expect(uploadsAfterFirst).toBe(1);
    // The second call sends nothing: the post already carries an external id,
    // so it is recognised as published before anything reaches the provider.
    expect(uploadsAfterSecond).toBe(1);
  });

  it('sends the same idempotency key on every attempt at one post', async () => {
    const { createGroup, publishPlatformPost } = await import('../src/services/social/post-groups.js');

    await connectAndAttach({ tenant: alpha, socialAccounts: INSTAGRAM_LINKED.social_accounts });
    const media = await testMedia(alpha, MediaType.IMAGE);

    const group = await createGroup({
      prisma,
      organizationId: alpha.organizationId,
      clientId: alpha.clientId,
      createdById: alpha.adminId,
      name: 'Flaky post',
      shared: { caption: 'Fresh mezze daily', mediaIds: [media.id] },
      platforms: [{ platform: Platform.INSTAGRAM }],
    });
    const post = await prisma.platformPost.findFirstOrThrow({ where: { postGroupId: group.id } });

    const profiles = [{
      username: profileUsernameFor(alpha.clientId),
      social_accounts: INSTAGRAM_LINKED.social_accounts,
    }];

    await approveAndQueue(alpha, post.id);

    // A retryable failure, then a success — the shape a real retry takes.
    const first = uploadPostStub({ profiles, upload: { status: 503, body: { success: false, message: 'Service unavailable' } } });
    await publishPlatformPost({ prisma, platformPostId: post.id, fetchImpl: first.fetchImpl as never });

    // A retryable failure leaves the post back in QUEUED, ready for the next
    // drain — so the retry is simply the next attempt, with no step between.

    const second = uploadPostStub({
      profiles,
      upload: {
        body: {
          success: true,
          request_id: 'req-retried',
          data: { platforms: [{ name: 'instagram', url: 'https://instagram.com/p/retried' }] },
        },
      },
    });
    await publishPlatformPost({ prisma, platformPostId: post.id, fetchImpl: second.fetchImpl as never });

    const key = (calls: typeof first.calls) =>
      calls.find((call) => call.url.includes('/upload_photos'))?.headers['idempotency-key'];

    /*
     * Identical across attempts, and equal to the post's own id. This is what
     * makes the retry safe at the provider: Upload-Post collapses the two into
     * one post rather than publishing the second.
     */
    expect(key(first.calls)).toBe(post.id);
    expect(key(second.calls)).toBe(post.id);
  });

  // ------------------------------------------------ existing routes untouched

  it('leaves every direct provider resolving exactly as it did', async () => {
    // Upload-Post is reachable only by asking for it. A caller that does not is
    // asking the question it always asked, and must get the same answer.
    expect(publisherFor(Platform.FACEBOOK)?.label).toBe('Facebook Page');
    expect(publisherFor(Platform.INSTAGRAM)?.label).toBe('Instagram Professional');
    expect(publisherFor(Platform.TIKTOK)?.label).toBe('TikTok');

    expect(publisherFor(Platform.INSTAGRAM, 'UPLOAD_POST')?.label).toBe('Upload-Post');
    // Not a destination Upload-Post reaches, so there is no routed publisher.
    expect(publisherFor(Platform.SNAPCHAT, 'UPLOAD_POST')).toBeNull();
  });

  it('routes only to the networks it can actually reach', () => {
    const platforms = routablePlatforms();
    expect(platforms).toContain(Platform.INSTAGRAM);
    expect(platforms).toContain(Platform.GOOGLE_BUSINESS);
    expect(platforms).not.toContain(Platform.SNAPCHAT);
    expect(platforms).not.toContain(Platform.GOOGLE_ADS);
    expect(platforms).not.toContain(Platform.UPLOAD_POST);
  });
});

/**
 * Drive one post all the way through: connect, attach, author, publish.
 *
 * The whole path rather than the publisher alone, because the questions that
 * matter — is the job PUBLISHED, is the content PUBLISHED, what id was recorded
 * — are the service's answers, and a publisher tested in isolation proves none
 * of them.
 */
async function publishThroughUploadPost(input: {
  tenant: Tenant;
  mediaType?: MediaType;
  upload?: { status?: number; body: unknown };
  status?: { body: unknown };
}) {
  const username = profileUsernameFor(input.tenant.clientId);
  const socialAccounts = { instagram: { id: 'ig-1', username: 'pawse', display_name: 'Pawse Kitchen' } };

  const connectStub = uploadPostStub({ profiles: [{ username, social_accounts: socialAccounts }] });
  await beginUploadPostConnection({
    prisma,
    organizationId: input.tenant.organizationId,
    clientId: input.tenant.clientId,
    returnUrl: `${BASE}/app/integrations`,
    fetchImpl: connectStub.fetchImpl,
  });
  const { integrationId } = await refreshUploadPostAccounts({
    prisma,
    organizationId: input.tenant.organizationId,
    clientId: input.tenant.clientId,
    fetchImpl: connectStub.fetchImpl,
  });
  const accounts = await prisma.integrationAccount.findMany({ where: { integrationId } });
  await selectAccounts({
    integrationId,
    organizationId: input.tenant.organizationId,
    accountIds: accounts.map((account) => account.id),
  });

  const type = input.mediaType ?? MediaType.IMAGE;
  const originalName = type === MediaType.VIDEO ? 'reel.mp4' : 'dish.jpg';
  const mimeType = type === MediaType.VIDEO ? 'video/mp4' : 'image/jpeg';

  /*
   * Real bytes in real storage. `checkReadiness` reads the object as well as
   * the row — a Media row whose object has gone is indistinguishable from a
   * healthy one until something tries to read it — so a fabricated key would
   * be refused before anything reached the publisher.
   */
  const { storage } = await import('../src/services/storage/index.js');
  const stored = await storage.save(Buffer.from('not-real-media'), {
    filename: originalName,
    mimeType,
    prefix: `clients/${input.tenant.clientId}/assets`,
  });

  const media = await prisma.media.create({
    data: {
      organizationId: input.tenant.organizationId,
      clientId: input.tenant.clientId,
      type,
      filename: stored.key,
      originalName,
      mimeType,
      sizeBytes: stored.sizeBytes,
      url: stored.url,
    },
    select: { id: true },
  });

  const content = await prisma.content.create({
    data: {
      organizationId: input.tenant.organizationId,
      clientId: input.tenant.clientId,
      name: 'Upload-Post test',
      platform: Platform.INSTAGRAM,
      headline: 'Open now',
      caption: 'Fresh mezze daily',
      status: ContentStatus.APPROVED,
      mediaLinks: { create: [{ mediaId: media.id, position: 0 }] },
    },
    select: { id: true },
  });

  const queued = await enqueue({
    prisma,
    contentId: content.id,
    organizationId: input.tenant.organizationId,
  });
  if (!('jobId' in queued)) {
    throw new Error(`Refused: ${queued.refused.problems.map((p) => p.problem).join(', ')}`);
  }

  const stub = uploadPostStub({
    profiles: [{ username, social_accounts: socialAccounts }],
    upload: input.upload,
    status: input.status,
  });

  await runJob({ prisma, jobId: queued.jobId, fetchImpl: stub.fetchImpl as never });

  return { content, stub, integrationId };
}

/**
 * A scheduled post on an Upload-Post-routed network, ready for the sweep.
 *
 * Shares the connect-and-attach half with `publishThroughUploadPost` but stops
 * at SCHEDULED rather than queueing, because what these tests are about is the
 * scheduler deciding when — which is the workflow the calendar already drives.
 */
async function scheduleThroughUploadPost(input: { tenant: Tenant; scheduledAt: Date }) {
  const username = profileUsernameFor(input.tenant.clientId);
  const socialAccounts = { instagram: { id: 'ig-1', username: 'pawse', display_name: 'Pawse Kitchen' } };

  const connectStub = uploadPostStub({ profiles: [{ username, social_accounts: socialAccounts }] });
  await beginUploadPostConnection({
    prisma,
    organizationId: input.tenant.organizationId,
    clientId: input.tenant.clientId,
    returnUrl: `${BASE}/app/integrations`,
    fetchImpl: connectStub.fetchImpl,
  });
  const { integrationId } = await refreshUploadPostAccounts({
    prisma,
    organizationId: input.tenant.organizationId,
    clientId: input.tenant.clientId,
    fetchImpl: connectStub.fetchImpl,
  });
  const accounts = await prisma.integrationAccount.findMany({ where: { integrationId } });
  await selectAccounts({
    integrationId,
    organizationId: input.tenant.organizationId,
    accountIds: accounts.map((account) => account.id),
  });

  const { storage } = await import('../src/services/storage/index.js');
  const stored = await storage.save(Buffer.from('not-real-media'), {
    filename: 'dish.jpg',
    mimeType: 'image/jpeg',
    prefix: `clients/${input.tenant.clientId}/assets`,
  });

  const media = await prisma.media.create({
    data: {
      organizationId: input.tenant.organizationId,
      clientId: input.tenant.clientId,
      type: MediaType.IMAGE,
      filename: stored.key,
      originalName: 'dish.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: stored.sizeBytes,
      url: stored.url,
    },
    select: { id: true },
  });

  const content = await prisma.content.create({
    data: {
      organizationId: input.tenant.organizationId,
      clientId: input.tenant.clientId,
      name: 'Upload-Post scheduled',
      platform: Platform.INSTAGRAM,
      headline: 'Open now',
      caption: 'Fresh mezze daily',
      status: ContentStatus.SCHEDULED,
      scheduledAt: input.scheduledAt,
      mediaLinks: { create: [{ mediaId: media.id, position: 0 }] },
    },
    select: { id: true },
  });

  return { content, connectStub, integrationId };
}

/** One stored image or video for a tenant, with real bytes behind it. */
async function testMedia(tenant: Tenant, type: MediaType) {
  const originalName = type === MediaType.VIDEO ? 'reel.mp4' : 'dish.jpg';
  const mimeType = type === MediaType.VIDEO ? 'video/mp4' : 'image/jpeg';

  const { storage } = await import('../src/services/storage/index.js');
  const stored = await storage.save(Buffer.from('not-real-media'), {
    filename: originalName,
    mimeType,
    prefix: `clients/${tenant.clientId}/assets`,
  });

  return prisma.media.create({
    data: {
      organizationId: tenant.organizationId,
      clientId: tenant.clientId,
      type,
      filename: stored.key,
      originalName,
      mimeType,
      sizeBytes: stored.sizeBytes,
      url: stored.url,
    },
    select: { id: true },
  });
}

/**
 * Walk one composed post through the real workflow to the point of publishing.
 *
 * DRAFT → IN_REVIEW → APPROVED → QUEUED, through `transition`, which is the
 * same path the composer's own buttons take. Jumping straight to QUEUED would
 * be a shortcut past the human approval gate that the state table exists to
 * enforce — and a test that took it would not be testing the workflow.
 */
async function approveAndQueue(tenant: Tenant, platformPostId: string) {
  const { transition } = await import('../src/services/social/post-groups.js');

  for (const to of ['IN_REVIEW', 'APPROVED', 'QUEUED'] as const) {
    await transition({
      prisma,
      organizationId: tenant.organizationId,
      platformPostId,
      to: to as never,
    });
  }
}

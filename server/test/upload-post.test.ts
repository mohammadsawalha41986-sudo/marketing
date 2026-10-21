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
  UPLOAD_POST_EXPLANATION,
  UploadPostError,
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
  /** The whole generate-jwt body, for asserting a shape rather than a value. */
  jwtBody?: unknown;
  /** The whole GET /uploadposts/users body, for the same reason. */
  usersBody?: unknown;
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
      if (script.jwtBody !== undefined) return answer(script.jwtBody);
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
      if (script.usersBody !== undefined) return answer(script.usersBody);
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

  // ------------------------------------------- the production connect failure

  it('never answers a Connect with media language, whatever the upstream said', async () => {
    /*
     * The exact production symptom, reproduced.
     *
     * Upload-Post's gateway answered `GET /uploadposts/users` with an nginx 502
     * HTML page. The message built from it read "Upload-Post profiles: …", and
     * the classifier matched media words as loose substrings — so "profiles"
     * contained "file" and the operator pressing Connect was told to check a
     * video's format, size and duration.
     *
     * Every 4xx and 5xx is swept, because the guarantee is not "this one status
     * is fixed" but "a connect call cannot produce a media verdict".
     */
    const { UploadPostError } = await import('../src/services/integrations/upload-post.js');

    for (const status of [400, 401, 403, 404, 409, 422, 429, 500, 502, 503]) {
      for (const jsonBody of [true, false]) {
        for (const stage of ['LIST_PROFILES', 'CREATE_PROFILE', 'GENERATE_LINK'] as const) {
          const error = new UploadPostError(
            status,
            `Upload-Post profiles: Upload-Post returned HTTP ${status} with a non-JSON body. `
              + '502 Bad Gateway 502 Bad Gateway nginx/1.22.1',
            { stage, jsonBody },
          );

          expect(error.connectFailure).not.toBe('INVALID_MEDIA');
          const said = error.connectExplanation;
          expect(said).not.toMatch(/\bmedia\b|\bvideo\b|\bduration\b|aspect|\bformat\b, size/i);
          expect(said).not.toMatch(/will be retried|\bthe post\b/i);
          expect(said.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('calls an nginx 502 an outage on their side, not a rejected request', async () => {
    // Exactly what production returned: a gateway page, not the API answering.
    const { UploadPostError } = await import('../src/services/integrations/upload-post.js');
    const error = new UploadPostError(
      502,
      'Upload-Post profiles: Upload-Post returned HTTP 502 with a non-JSON body. 502 Bad Gateway nginx/1.22.1',
      { stage: 'LIST_PROFILES', jsonBody: false, endpoint: '/uploadposts/users' },
    );

    expect(error.connectFailure).toBe('PROVIDER_UNAVAILABLE');
    expect(error.connectExplanation).toMatch(/gateway/i);
    expect(error.connectExplanation).toMatch(/nothing was connected/i);
    expect(error.endpoint).toBe('/uploadposts/users');
  });

  it('names the connect stage that failed rather than guessing from prose', async () => {
    const { UploadPostError } = await import('../src/services/integrations/upload-post.js');

    // A real 4xx from the API itself, per step.
    const create = new UploadPostError(400, 'quota exceeded', { stage: 'CREATE_PROFILE', jsonBody: true });
    expect(create.connectFailure).toBe('PROFILE_CREATE_FAILED');

    const link = new UploadPostError(400, 'bad request', { stage: 'GENERATE_LINK', jsonBody: true });
    expect(link.connectFailure).toBe('LINK_GENERATION_FAILED');

    const missing = new UploadPostError(404, 'not found', { stage: 'LIST_PROFILES', jsonBody: true });
    expect(missing.connectFailure).toBe('PROFILE_NOT_FOUND');

    // Authentication is the deployment's problem at any stage.
    for (const stage of ['LIST_PROFILES', 'CREATE_PROFILE', 'GENERATE_LINK'] as const) {
      expect(new UploadPostError(401, 'nope', { stage, jsonBody: true }).connectFailure).toBe('INVALID_KEY');
    }

    // A readable body that is not JSON, under 500: something answered in their
    // place, and that is not a verdict about what we sent.
    const odd = new UploadPostError(404, 'html', { stage: 'LIST_PROFILES', jsonBody: false });
    expect(odd.connectFailure).toBe('INVALID_PROVIDER_RESPONSE');
  });

  it('does not let "profiles" read as a file', () => {
    // The substring that caused it. Publishing keeps its media classification,
    // but only for whole words.
    expect(classifyUploadPostError('Upload-Post profiles: something failed', 500))
      .not.toBe('INVALID_MEDIA');
    expect(classifyUploadPostError('the video duration is too long', 400)).toBe('INVALID_MEDIA');
    expect(classifyUploadPostError('unsupported image format', 400)).toBe('INVALID_MEDIA');
  });

  it('reports a Connect failure in Connect language, never a post\'s', async () => {
    /*
     * The exact production symptom. Pressing Connect answered:
     *
     *   "Upload-Post is temporarily unavailable. The post will be retried."
     *
     * — a sentence about a post, on a screen where no post exists and nothing
     * will be retried. The wording came from the publishing map, which was the
     * only one there was.
     */
    const { UploadPostError } = await import('../src/services/integrations/upload-post.js');
    const error = new UploadPostError(503, 'Service Unavailable', {
      stage: 'LIST_PROFILES', jsonBody: true,
    });

    expect(error.failure).toBe('PROVIDER_UNAVAILABLE');
    // Publishing keeps its own wording, which is correct where a post exists.
    expect(error.explanation).toMatch(/post will be retried/i);
    /*
     * Connect must not borrow it. Matched against publishing *language* rather
     * than the word "post", which the provider's own name contains.
     */
    expect(error.connectExplanation).not.toMatch(/\bthe post\b|will be retried|publish/i);
    expect(error.connectExplanation).toMatch(/nothing was connected/i);
  });

  it('surfaces a 5xx on each connect call as a Connect error naming no post', async () => {
    /*
     * One case per call in the connect chain, because the production evidence
     * could not say which of the three had failed — the server logged nothing.
     * Each must fail as a connection problem, and none may talk about posts.
     */
    const username = profileUsernameFor(alpha.clientId);

    for (const failing of ['list', 'create', 'jwt'] as const) {
      const fetchImpl = (async (url: string, init?: { method?: string }) => {
        const method = init?.method ?? 'GET';
        const down = (failing === 'list' && url.includes('/uploadposts/users') && method === 'GET')
          || (failing === 'create' && url.includes('/uploadposts/users') && method === 'POST')
          || (failing === 'jwt' && url.includes('generate-jwt'));

        if (down) {
          return {
            ok: false,
            status: 503,
            headers: { get: () => 'text/html' },
            json: async () => ({}),
            text: async () => '<html><body>Service Unavailable</body></html>',
          };
        }
        // The list answers empty so the flow proceeds to create, then to jwt.
        if (url.includes('generate-jwt')) {
          return {
            ok: true, status: 200, headers: { get: () => 'application/json' },
            json: async () => ({ success: true, connection_url: 'https://app.upload-post.com/c/x' }),
            text: async () => JSON.stringify({ success: true, connection_url: 'https://app.upload-post.com/c/x' }),
          };
        }
        const body = { success: true, profiles: failing === 'jwt' ? [{ username, social_accounts: {} }] : [] };
        return {
          ok: true, status: 200, headers: { get: () => 'application/json' },
          json: async () => body,
          text: async () => JSON.stringify(body),
        };
      }) as UploadPostFetch;

      await expect(beginUploadPostConnection({
        prisma,
        organizationId: alpha.organizationId,
        clientId: alpha.clientId,
        returnUrl: `${BASE}/app/integrations`,
        fetchImpl,
      })).rejects.toThrow();

      const integration = await prisma.integration.findFirstOrThrow({
        where: { clientId: alpha.clientId, platform: Platform.UPLOAD_POST },
      });

      // Parked in ERROR with a sentence about connecting, not about a post.
      expect(integration.status).toBe(IntegrationStatus.ERROR);
      expect(integration.lastError).toBeTruthy();
      expect(integration.lastError).not.toMatch(/post will be retried/i);
      expect(integration.lastError).not.toContain(API_KEY);
    }
  });

  it('records which call failed, with its status and content type, and no key', async () => {
    /*
     * The absence of this is why the production failure could not be diagnosed:
     * the browser showed a sentence and the server recorded nothing, so nobody
     * could say which of three calls had failed or what it answered.
     */
    const lines: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };

    try {
      const fetchImpl = (async () => ({
        ok: false,
        status: 502,
        headers: { get: () => 'text/html; charset=utf-8' },
        json: async () => ({}),
        text: async () => '<html><head><title>502 Bad Gateway</title></head></html>',
      })) as UploadPostFetch;

      await expect(beginUploadPostConnection({
        prisma,
        organizationId: alpha.organizationId,
        clientId: alpha.clientId,
        returnUrl: `${BASE}/app/integrations`,
        fetchImpl,
      })).rejects.toThrow();
    } finally {
      console.error = realError;
    }

    const line = lines.find((entry) => entry.includes('[upload-post]'));
    expect(line).toBeDefined();
    // Which call, what it answered, and what kind of thing answered.
    expect(line).toContain('/uploadposts/users');
    expect(line).toContain('HTTP 502');
    expect(line).toContain('content-type=text/html; charset=utf-8');
    expect(line).toMatch(/502 Bad Gateway/);
    // And never the credential, in any field.
    expect(line).not.toContain(API_KEY);
    expect(line!.toLowerCase()).not.toContain('authorization');
    expect(line!.toLowerCase()).not.toContain('apikey');
  });

  it('scrubs the key from a provider message that echoes it back', async () => {
    const lines: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };

    try {
      const fetchImpl = (async () => {
        // An upstream that echoes the request — including the credential.
        const body = { success: false, message: `rejected request with key ${API_KEY}` };
        return {
          ok: false, status: 400, headers: { get: () => 'application/json' },
          json: async () => body,
          text: async () => JSON.stringify(body),
        };
      }) as UploadPostFetch;

      await expect(beginUploadPostConnection({
        prisma,
        organizationId: alpha.organizationId,
        clientId: alpha.clientId,
        returnUrl: `${BASE}/app/integrations`,
        fetchImpl,
      })).rejects.toThrow();
    } finally {
      console.error = realError;
    }

    const line = lines.find((entry) => entry.includes('[upload-post]'));
    expect(line).toBeDefined();
    expect(line).not.toContain(API_KEY);
    expect(line).toContain('[redacted]');
  });

  it('sends only the authorization header, and no invented source header', async () => {
    /*
     * The one respect in which this client's requests differed from a
     * known-good one while production answered a consistent 5xx. Both official
     * clients send `X-Upload-Post-Source` with a value from their own set to
     * attribute an SDK; we are not one of theirs, so there is no correct value
     * to send and this sends none.
     */
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
      const names = Object.keys(call.headers).map((name) => name.toLowerCase());
      expect(names).toContain('authorization');
      expect(names).not.toContain('x-upload-post-source');
    }
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

  // ------------------------------------------------- a plan, not a broken link

  it('calls a plan restriction what it is, not a disconnected account', async () => {
    /*
     * Straight from production. TikTok was linked, working and visible in
     * Upload-Post; publishing answered:
     *
     *   POST /upload_photos → HTTP 403 application/json
     *   "TikTok uploads are not available on the Free plan. Please upgrade to
     *    a paid plan."
     *
     * The bare `status === 403` rule classified that as ACCOUNT_NOT_LINKED, so
     * the operator was told the account was "no longer linked to the
     * restaurant's Upload-Post profile" and went looking for a disconnection
     * that had never happened. The provider said "plan"; nothing said "link".
     */
    const failure = classifyUploadPostError(
      'TikTok uploads are not available on the Free plan. Please upgrade to a paid plan.',
      403,
    );

    expect(failure).toBe('PLAN_RESTRICTED');
    expect(failure).not.toBe('ACCOUNT_NOT_LINKED');
    expect(UPLOAD_POST_EXPLANATION[failure]).toMatch(/plan/i);
    expect(UPLOAD_POST_EXPLANATION[failure]).not.toMatch(/no longer linked|link it again/i);
  });

  it('fails the post permanently on a plan restriction rather than retrying it', async () => {
    /*
     * A plan does not change because a job ran again. Retrying would spin the
     * post through the whole backoff to the same 403, and the state machine
     * would keep it alive as though it were on its way.
     */
    const { content } = await publishThroughUploadPost({
      tenant: alpha,
      upload: {
        status: 403,
        body: {
          success: false,
          message: 'TikTok uploads are not available on the Free plan. Please upgrade to a paid plan.',
        },
      },
    });

    const job = await prisma.publishingJob.findFirstOrThrow({ where: { contentId: content.id } });
    expect(job.status).not.toBe(PublishingJobStatus.PUBLISHED);
    expect(job.externalPostId).toBeNull();
    expect(job.errorMessage).toMatch(/plan/i);
    expect(job.errorMessage).not.toMatch(/no longer linked/i);
    // Permanent: a plan does not change because a job ran again.
    expect(job.status).not.toBe(PublishingJobStatus.QUEUED);
  });

  it('still says a link is broken when the provider says a link is broken', async () => {
    // The repair must not swallow the real case: a genuinely unlinked account
    // is still ACCOUNT_NOT_LINKED, and still tells the operator to relink.
    expect(classifyUploadPostError('This account is not linked to the profile', 403))
      .toBe('ACCOUNT_NOT_LINKED');
  });

  // ------------------------------- a 2xx that did not carry what Connect needed

  /** Connect for `alpha`, against a scripted Upload-Post. */
  const connectWith = (script: Parameters<typeof uploadPostStub>[0]) => {
    const stub = uploadPostStub(script);
    return {
      stub,
      run: () => beginUploadPostConnection({
        prisma,
        organizationId: alpha.organizationId,
        clientId: alpha.clientId,
        returnUrl: `${BASE}/app/integrations`,
        fetchImpl: stub.fetchImpl,
      }),
    };
  };

  it('reads the linking URL from the field the official client documents', async () => {
    const username = profileUsernameFor(alpha.clientId);
    const { run } = connectWith({
      profiles: [{ username, social_accounts: {} }],
      // `{ success, jwt?, connection_url? }` — the shape upload-post@2.14.0 types.
      jwtBody: { success: true, jwt: 'jwt-not-a-real-token', connection_url: 'https://app.upload-post.com/c/abc' },
    });

    await expect(run()).resolves.toMatchObject({ redirectTo: 'https://app.upload-post.com/c/abc' });
  });

  it('reads it from a data envelope, or from the "url" spelling', async () => {
    /*
     * Two shapes rather than a search: the flat body and a `data` envelope, and
     * `connection_url` or `url` within each. Deterministic, and the most a
     * response may vary before it is reported as unreadable instead of guessed
     * at.
     */
    const username = profileUsernameFor(alpha.clientId);

    for (const body of [
      { success: true, data: { connection_url: 'https://app.upload-post.com/c/env' } },
      { success: true, url: 'https://app.upload-post.com/c/env' },
      { success: true, data: { url: 'https://app.upload-post.com/c/env' } },
      { success: true, access_url: 'https://app.upload-post.com/c/env' },
    ]) {
      const { run } = connectWith({ profiles: [{ username, social_accounts: {} }], jwtBody: body });
      await expect(run()).resolves.toMatchObject({ redirectTo: 'https://app.upload-post.com/c/env' });
    }
  });

  it('reports a 2xx with no linking URL as unreadable, naming the stage', async () => {
    /*
     * The live defect, pinned.
     *
     * generate-jwt answered 200 with JSON that carried no `connection_url`. The
     * throw carried no stage, so the connect verdict fell through to
     * INVALID_REQUEST — "Upload-Post rejected the connection request" — about a
     * call Upload-Post had accepted, and `readJson` logged nothing because
     * nothing had failed at the HTTP level. The operator saw a refusal that had
     * not happened, and the server had no record of the attempt at all.
     */
    const username = profileUsernameFor(alpha.clientId);
    const { run } = connectWith({
      profiles: [{ username, social_accounts: {} }],
      jwtBody: { success: true, jwt: 'jwt-not-a-real-token' },
    });

    const error = await run().catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(UploadPostError);
    const failure = error as UploadPostError;

    expect(failure.stage).toBe('GENERATE_LINK');
    expect(failure.connectFailure).toBe('INVALID_PROVIDER_RESPONSE');
    expect(failure.connectExplanation).not.toMatch(/rejected the connection request/);
    // Never the publishing verdict, and never a post.
    expect(failure.connectFailure).not.toBe('INVALID_MEDIA');
    expect(failure.connectExplanation).not.toMatch(/\bthe post\b|will be retried|publish/i);
  });

  it('logs the shape of an unusable 2xx, and nothing that is in it', async () => {
    const username = profileUsernameFor(alpha.clientId);
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };

    try {
      const { run } = connectWith({
        profiles: [{ username, social_accounts: {} }],
        jwtBody: { success: true, jwt: 'jwt-not-a-real-token', expires_at: '2026-01-01' },
      });
      await run().catch(() => undefined);
    } finally {
      console.error = original;
    }

    const line = logged.find((entry) => entry.includes('[upload-post]'));
    expect(line).toBeDefined();

    // Enough to diagnose without another deploy: the stage, the call, the
    // status, the content type, what was missing, and the key names present.
    expect(line).toContain('GENERATE_LINK');
    expect(line).toContain('POST /uploadposts/users/generate-jwt');
    expect(line).toContain('HTTP 200');
    expect(line).toContain('missing=connection_url');
    expect(line).toContain('jwt:string');
    expect(line).toContain('expires_at:string');

    // And none of the values behind those names.
    expect(line).not.toContain('jwt-not-a-real-token');
    expect(line).not.toContain(API_KEY);
    expect(line).not.toMatch(/Apikey|authorization/i);
    expect(line).not.toContain('2026-01-01');
  });

  it('refuses a linking URL that is not an Upload-Post https address', async () => {
    /*
     * This response redirects a browser. A field that changed meaning — or a
     * provider account that was tampered with — must not become an open
     * redirect, so the destination is checked before it is handed over.
     */
    const username = profileUsernameFor(alpha.clientId);

    for (const url of [
      'https://evil.example.com/c/abc',
      'http://app.upload-post.com/c/abc',
      'https://upload-post.com.evil.example/c/abc',
      'javascript:alert(1)',
    ]) {
      const { run } = connectWith({
        profiles: [{ username, social_accounts: {} }],
        jwtBody: { success: true, connection_url: url },
      });

      const error = await run().catch((thrown: unknown) => thrown) as UploadPostError;
      expect(error).toBeInstanceOf(UploadPostError);
      expect(error.connectFailure).toBe('INVALID_PROVIDER_RESPONSE');
    }
  });

  it('accepts Upload-Post\'s own hosts, including one it has not moved to yet', async () => {
    const username = profileUsernameFor(alpha.clientId);

    for (const url of ['https://app.upload-post.com/c/a', 'https://upload-post.com/c/a', 'https://www.upload-post.com/c/a']) {
      const { run } = connectWith({
        profiles: [{ username, social_accounts: {} }],
        jwtBody: { success: true, connection_url: url },
      });
      await expect(run()).resolves.toMatchObject({ redirectTo: url });
    }
  });

  it('reports a profile list with no profiles array rather than creating a duplicate', async () => {
    /*
     * The same class of defect one stage earlier. Reading "no profiles" out of a
     * body this code cannot parse would send Connect on to create a profile the
     * restaurant may already have — and would lose the accounts linked to it.
     */
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };

    let error: unknown;
    let stub: ReturnType<typeof uploadPostStub>;
    try {
      const connect = connectWith({ usersBody: { success: true, items: [] } });
      stub = connect.stub;
      error = await connect.run().catch((thrown: unknown) => thrown);
    } finally {
      console.error = original;
    }

    expect(error).toBeInstanceOf(UploadPostError);
    expect((error as UploadPostError).stage).toBe('LIST_PROFILES');
    expect((error as UploadPostError).connectFailure).toBe('INVALID_PROVIDER_RESPONSE');
    // No profile was created off the back of a body that could not be read.
    expect(stub!.calls.some((call) => call.method === 'POST' && call.url.includes('/uploadposts/users') && !call.url.includes('generate-jwt'))).toBe(false);
    expect(logged.some((entry) => entry.includes('LIST_PROFILES') && entry.includes('missing=profiles'))).toBe(true);
  });

  it('creates the profile when there is none, then asks for the link', async () => {
    const { stub, run } = connectWith({ profiles: [] });
    await expect(run()).resolves.toMatchObject({ profile: profileUsernameFor(alpha.clientId) });

    const paths = stub.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`);
    expect(paths).toEqual([
      'GET /api/uploadposts/users',
      'POST /api/uploadposts/users',
      'GET /api/uploadposts/users',
      'POST /api/uploadposts/users/generate-jwt',
    ]);
  });

  it('never answers any Connect stage with a publishing verdict', async () => {
    /*
     * The invariant, over every failure this flow can produce rather than the
     * one that was reported: no stage may return INVALID_MEDIA, and no stage
     * may speak about a post.
     */
    const username = profileUsernameFor(alpha.clientId);
    const scripts: Array<Parameters<typeof uploadPostStub>[0]> = [
      { profiles: [{ username, social_accounts: {} }], jwtBody: { success: true } },
      { profiles: [{ username, social_accounts: {} }], jwtBody: { success: true, connection_url: 'https://evil.example.com/x' } },
      { usersBody: { success: true, items: [] } },
      { usersBody: { success: true, profiles: [], media: 'video files exceed the duration' } },
    ];

    for (const script of scripts) {
      const { run } = connectWith(script);
      const error = await run().catch((thrown: unknown) => thrown);
      if (!(error instanceof UploadPostError)) continue;
      expect(error.connectFailure).not.toBe('INVALID_MEDIA');
      expect(error.connectExplanation).not.toMatch(/media|video|duration/i);
      expect(error.connectExplanation).not.toMatch(/\bthe post\b|will be retried/i);
    }
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

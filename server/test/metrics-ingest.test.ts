/**
 * Organic metric ingestion — the producer for Phase 14.
 *
 * The property under test throughout is a negative one: **an absence must never
 * become a zero.** Phase 14 can only distinguish "the platform said 0" from
 * "nobody ever asked" if the thing writing the numbers preserves that
 * difference, and the cheapest possible bug here — defaulting a missing field
 * to 0 — would silently destroy the whole four-state design while making every
 * dashboard look healthier.
 *
 * So most of what follows checks what is *not* written: no zero for an omitted
 * metric, no total when a term is missing, no wiped measurements after a failed
 * re-read, and no publish error invented on a post that published perfectly.
 */

import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { Platform } from '@prisma/client';

import { createTenant, prisma, resetDatabase, type Tenant } from './helpers.js';
import { encryptSecret } from '../src/lib/crypto.js';
import {
  facebookMetricsFetcher,
  ingestMetricsTick,
  instagramMetricsFetcher,
  metricsFetcherFor,
  tiktokMetricsFetcher,
} from '../src/services/social/metrics-ingest.js';
import { postGroupAnalytics } from '../src/services/social/analytics.js';
import type { FetchLike } from '../src/services/publishing/contract.js';

const KEY = 'Zm9yLXRlc3Rpbmctb25seS0zMi1ieXRlLWtleS0hIQ==';

function stub(routes: Array<{ match: string; body: unknown; status?: number }>): FetchLike {
  return (async (url: string) => {
    const route = routes.find((entry) => url.includes(entry.match));
    if (!route) throw new Error(`No stub for ${url}`);
    return {
      ok: (route.status ?? 200) < 400,
      status: route.status ?? 200,
      json: async () => route.body,
      text: async () => JSON.stringify(route.body),
    };
  }) as FetchLike;
}

/** Facebook's two responses: the summary counts, then the insight metrics. */
function facebookStub(overrides: { counts?: unknown; insights?: unknown; status?: number } = {}) {
  return stub([
    {
      match: '/insights',
      body: overrides.insights ?? {
        data: [
          { name: 'post_impressions', values: [{ value: 1200 }] },
          { name: 'post_impressions_unique', values: [{ value: 950 }] },
          { name: 'post_clicks', values: [{ value: 0 }] },
        ],
      },
      status: overrides.status,
    },
    {
      match: 'graph.facebook.com',
      body: overrides.counts ?? {
        likes: { summary: { total_count: 42 } },
        comments: { summary: { total_count: 7 } },
        shares: { count: 3 },
      },
      status: overrides.status,
    },
  ]);
}

describe('organic metric ingestion', () => {
  let alpha: Tenant;
  let accountId: string;
  const saved = { ...process.env };

  beforeAll(async () => {
    await resetDatabase();
    alpha = await createTenant('ingest');

    process.env.TOKEN_ENCRYPTION_KEY = KEY;
    const integration = await prisma.integration.create({
      data: {
        organizationId: alpha.organizationId,
        clientId: alpha.clientId,
        platform: Platform.FACEBOOK,
        status: 'CONNECTED',
      },
    });
    const account = await prisma.integrationAccount.create({
      data: {
        integrationId: integration.id,
        clientId: alpha.clientId,
        kind: 'PAGE',
        externalId: 'page-100',
        name: 'Pawse',
        selected: true,
        accessTokenEnc: encryptSecret('PAGE-TOKEN'),
      },
    });
    accountId = account.id;
  });

  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
  });
  afterEach(() => {
    if (saved.TOKEN_ENCRYPTION_KEY === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = saved.TOKEN_ENCRYPTION_KEY;
  });

  /** A published post with a real external id, ready to be read. */
  async function seedPost(input: {
    platform?: Platform;
    externalPostId?: string | null;
    status?: 'PUBLISHED' | 'DRAFT';
    config?: Record<string, unknown>;
    publishedAt?: Date;
    withAccount?: boolean;
  } = {}) {
    const group = await prisma.postGroup.create({
      data: {
        organizationId: alpha.organizationId,
        clientId: alpha.clientId,
        name: `fixture ${Math.random().toString(36).slice(2, 8)}`,
        status: 'PUBLISHED',
      },
    });

    return prisma.platformPost.create({
      data: {
        postGroupId: group.id,
        platform: input.platform ?? Platform.FACEBOOK,
        caption: 'seeded',
        status: input.status ?? 'PUBLISHED',
        publishedAt: input.publishedAt ?? new Date(),
        externalPostId: input.externalPostId === undefined ? 'post-1' : input.externalPostId,
        config: input.config ?? {},
        integrationAccountId: input.withAccount === false ? null : accountId,
      },
    });
  }

  const configOf = async (id: string) => {
    const row = await prisma.platformPost.findUniqueOrThrow({ where: { id } });
    return (row.config ?? {}) as Record<string, unknown>;
  };

  // ---------------------------------------------------- the absence rule

  it('writes null, not zero, for a metric the platform did not return', async () => {
    const post = await seedPost();

    await ingestMetricsTick({ prisma, fetchImpl: facebookStub(), now: new Date() });

    const metrics = (await configOf(post.id)).metrics as Record<string, number | null>;

    // Returned and genuinely zero: a measurement, and it must survive as one.
    expect(metrics.clicks).toBe(0);
    // Never asked for and never returned. The whole point of the phase.
    expect(metrics.saves ?? null).toBeNull();
    expect(metrics.likes).toBe(42);
    expect(metrics.reach).toBe(950);
  });

  it('refuses to total engagements when a component is missing', async () => {
    const post = await seedPost({ externalPostId: 'post-partial' });

    await ingestMetricsTick({
      prisma,
      fetchImpl: facebookStub({
        // Shares absent: a post nobody shared still reports `shares.count`, so
        // an omission here means the field was not readable, not that it was 0.
        counts: { likes: { summary: { total_count: 10 } }, comments: { summary: { total_count: 2 } } },
      }),
      now: new Date(),
    });

    const metrics = (await configOf(post.id)).metrics as Record<string, number | null>;
    expect(metrics.likes).toBe(10);
    expect(metrics.shares).toBeNull();
    // A total that silently dropped a term would read as complete and be wrong.
    expect(metrics.engagements).toBeNull();
  });

  it('feeds Phase 14 states without Phase 14 being changed', async () => {
    const post = await seedPost({ externalPostId: 'post-states' });
    await ingestMetricsTick({ prisma, fetchImpl: facebookStub(), now: new Date() });

    const row = await prisma.platformPost.findUniqueOrThrow({ where: { id: post.id } });
    const analytics = await postGroupAnalytics(row.postGroupId, alpha.organizationId);
    const metrics = analytics!.posts[0]!.metrics;

    // A real zero reads as ZERO with the value kept.
    expect(metrics.clicks).toEqual({ value: 0, state: 'ZERO' });
    expect(metrics.likes).toEqual({ value: 42, state: 'ZERO' });
    // Facebook has no saves metric at all — Phase 14's own determination.
    expect(metrics.saves.state).toBe('UNAVAILABLE');
    expect(metrics.saves.value).toBeNull();
  });

  // --------------------------------------------------------- idempotency

  it('does not read the same post twice inside the interval', async () => {
    const post = await seedPost({ externalPostId: 'post-idem' });
    const now = new Date();

    const first = await ingestMetricsTick({ prisma, fetchImpl: facebookStub(), now });
    expect(first.updated).toContain(post.id);

    // A tick a minute later must find nothing to do.
    const second = await ingestMetricsTick({
      prisma,
      fetchImpl: facebookStub(),
      now: new Date(now.getTime() + 60_000),
    });
    expect(second.updated).not.toContain(post.id);
    expect(second.attempted).toBe(0);
  });

  it('produces the same stored metrics when it does run again', async () => {
    const post = await seedPost({ externalPostId: 'post-repeat' });
    const now = new Date();

    await ingestMetricsTick({ prisma, fetchImpl: facebookStub(), now });
    const first = (await configOf(post.id)).metrics;

    // Seven hours later, past the floor.
    await ingestMetricsTick({
      prisma,
      fetchImpl: facebookStub(),
      now: new Date(now.getTime() + 7 * 60 * 60 * 1000),
    });
    const second = (await configOf(post.id)).metrics;

    expect(second).toEqual(first);
  });

  it('keeps settings that were already on the post', async () => {
    // config carries the operator's publish choices as well as our scratchpad;
    // replacing it wholesale would discard what a post was published with.
    const post = await seedPost({
      externalPostId: 'post-config',
      config: { privacyLevel: 'PUBLIC_TO_EVERYONE', title: 'Launch' },
    });

    await ingestMetricsTick({ prisma, fetchImpl: facebookStub(), now: new Date() });

    const config = await configOf(post.id);
    expect(config.privacyLevel).toBe('PUBLIC_TO_EVERYONE');
    expect(config.title).toBe('Launch');
    expect(config.metrics).toBeTruthy();
  });

  // -------------------------------------------------------- provider errors

  it('records a failure in config and never as a publish error', async () => {
    const post = await seedPost({ externalPostId: 'post-403' });

    await ingestMetricsTick({
      prisma,
      fetchImpl: facebookStub({ counts: { error: { message: 'no permission', code: 10 } }, status: 403 }),
      now: new Date(),
    });

    const row = await prisma.platformPost.findUniqueOrThrow({ where: { id: post.id } });
    const config = (row.config ?? {}) as Record<string, unknown>;

    expect((config.metricsError as { kind: string }).kind).toBe('MISSING_PERMISSION');
    /*
     * The post published perfectly. Writing an insights failure into
     * errorMessage would make it read as a failed publication in the UI and
     * would flip every one of its metrics to PROVIDER_ERROR in Phase 14.
     */
    expect(row.errorMessage).toBeNull();
    expect(row.status).toBe('PUBLISHED');
  });

  it('does not discard measurements it already has when a later read fails', async () => {
    const post = await seedPost({ externalPostId: 'post-keep' });
    const now = new Date();

    await ingestMetricsTick({ prisma, fetchImpl: facebookStub(), now });
    const before = (await configOf(post.id)).metrics;

    await ingestMetricsTick({
      prisma,
      fetchImpl: facebookStub({ counts: { error: { message: 'boom', code: 1 } }, status: 500 }),
      now: new Date(now.getTime() + 7 * 60 * 60 * 1000),
    });

    const after = await configOf(post.id);
    // Real numbers, measured earlier, are not thrown away by a bad morning.
    expect(after.metrics).toEqual(before);
    expect((after.metricsError as { kind: string }).kind).toBe('PROVIDER_UNAVAILABLE');
  });

  it('stops asking a platform for the rest of the tick once rate limited', async () => {
    const now = new Date();
    for (let index = 0; index < 3; index += 1) {
      await seedPost({ externalPostId: `post-rate-${index}` });
    }

    const report = await ingestMetricsTick({
      prisma,
      fetchImpl: facebookStub({ counts: { error: { message: 'slow down', code: 4 } }, status: 400 }),
      now,
    });

    expect(report.backedOff).toContain(Platform.FACEBOOK);
    // One refusal is enough; the rest would earn the same and deepen it.
    expect(report.attempted).toBe(1);
    expect(report.failed[0]!.kind).toBe('RATE_LIMITED');
  });

  it('waits out the back-off it set for itself', async () => {
    const post = await seedPost({ externalPostId: 'post-backoff' });
    const now = new Date();

    await ingestMetricsTick({
      prisma,
      fetchImpl: facebookStub({ counts: { error: { message: 'nope', code: 190 } }, status: 401 }),
      now,
    });
    expect((await configOf(post.id)).metricsRetryAfter).toBeTruthy();

    // An invalid token will not fix itself in ten minutes.
    const next = await ingestMetricsTick({
      prisma,
      fetchImpl: facebookStub(),
      now: new Date(now.getTime() + 10 * 60_000),
    });
    expect(next.updated).not.toContain(post.id);
  });

  // ------------------------------------------------------------ selection

  it('ignores posts that were never published or carry no external id', async () => {
    const draft = await seedPost({ status: 'DRAFT', externalPostId: null });
    const orphan = await seedPost({ externalPostId: null });
    const tokenless = await seedPost({ externalPostId: 'post-no-token', withAccount: false });

    const report = await ingestMetricsTick({ prisma, fetchImpl: facebookStub(), now: new Date() });

    for (const id of [draft.id, orphan.id, tokenless.id]) {
      expect(report.updated).not.toContain(id);
      expect((await configOf(id)).metrics).toBeUndefined();
    }
  });

  it('has no fetcher for platforms whose metrics API is not connected', () => {
    /*
     * Absent rather than stubbed. A stub that succeeded with nothing in it
     * would write a complete-looking object of nulls and make "never asked"
     * indistinguishable from "asked and got nothing".
     */
    expect(metricsFetcherFor(Platform.YOUTUBE)).toBeNull();
    expect(metricsFetcherFor(Platform.LINKEDIN)).toBeNull();
    expect(metricsFetcherFor(Platform.GOOGLE_BUSINESS)).toBeNull();
    expect(metricsFetcherFor(Platform.FACEBOOK)).toBeTruthy();
  });

  // ------------------------------------------------------ fetchers, direct

  it('maps Instagram saves from its own field name', async () => {
    const result = await instagramMetricsFetcher.fetch({
      externalPostId: 'ig-1',
      accessToken: 'T',
      fetchImpl: stub([
        {
          match: '/insights',
          body: {
            data: [
              { name: 'reach', values: [{ value: 500 }] },
              { name: 'likes', values: [{ value: 20 }] },
              { name: 'comments', values: [{ value: 4 }] },
              { name: 'shares', values: [{ value: 1 }] },
              // Instagram calls it `saved`; Phase 14 calls it `saves`.
              { name: 'saved', values: [{ value: 9 }] },
            ],
          },
        },
      ]),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metrics.saves).toBe(9);
    expect(result.metrics.engagements).toBe(34);
    // Not in the response, so not fabricated.
    expect(result.metrics.impressions ?? null).toBeNull();
  });

  it('does not report TikTok views as reach', async () => {
    const result = await tiktokMetricsFetcher.fetch({
      externalPostId: 'video-1',
      accessToken: 'T',
      fetchImpl: stub([
        {
          match: 'video/query',
          body: {
            data: { videos: [{ id: 'video-1', like_count: 100, comment_count: 5, share_count: 2, view_count: 9000 }] },
          },
        },
      ]),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metrics.impressions).toBe(9000);
    // A view count is not a unique-viewer count; reporting it as both would
    // present one measurement as two.
    expect(result.metrics.reach ?? null).toBeNull();
    expect(result.metrics.engagements).toBe(107);
  });

  it('treats a TikTok video missing from its own answer as gone, not as a transport failure', async () => {
    const result = await tiktokMetricsFetcher.fetch({
      externalPostId: 'video-deleted',
      accessToken: 'T',
      fetchImpl: stub([{ match: 'video/query', body: { data: { videos: [] } } }]),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('NOT_FOUND');
  });

  it('keeps the counts it did get when only the insights call is refused', async () => {
    // Losing real like and comment counts because a separate insights call was
    // refused would leave them unfetched for no reason.
    const result = await facebookMetricsFetcher.fetch({
      externalPostId: 'post-1',
      accessToken: 'T',
      fetchImpl: stub([
        { match: '/insights', body: { error: { message: 'no insights', code: 10 } }, status: 403 },
        {
          match: 'graph.facebook.com',
          body: {
            likes: { summary: { total_count: 5 } },
            comments: { summary: { total_count: 1 } },
            shares: { count: 0 },
          },
        },
      ]),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metrics.likes).toBe(5);
    expect(result.metrics.shares).toBe(0);
    expect(result.metrics.engagements).toBe(6);
    expect(result.metrics.impressions ?? null).toBeNull();
  });
});

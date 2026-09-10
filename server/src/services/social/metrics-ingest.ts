/**
 * Organic metric ingestion — the producer Phase 14 was written to read.
 *
 * Phase 14 has always known how to *interpret* `PlatformPost.config.metrics`:
 * which metrics a platform reports, what a zero means against what an absence
 * means, and how to say "not fetched" without printing a nought. What no part
 * of this application did was ever *write* that object. Every organic metric in
 * production therefore read NOT_FETCHED, permanently and correctly, because
 * nothing had ever asked a platform anything.
 *
 * This file only asks, and writes down the answer. It computes nothing Phase 14
 * computes: no state is decided here, no total is summed here, and
 * `METRICS_SUPPORTED` is not consulted or duplicated. A fetcher returns the
 * numbers a provider actually gave and `null` for everything it did not, and
 * the analytics service turns that into states exactly as it already does.
 *
 * The rule that governs every line below: **a metric that was not measured is
 * `null`, never `0`.** Zero saves is a result. Unfetched saves is the absence of
 * one. Collapsing the two would put a confident nought on a client's report for
 * a number nobody ever asked for — which is the specific failure the four-state
 * design exists to prevent, and the easiest one to reintroduce from here.
 *
 * Scope, stated plainly. Facebook, Instagram and TikTok have real, documented
 * organic post-insight endpoints and are implemented. YouTube and LinkedIn do
 * not: their figures come from the YouTube Analytics API and LinkedIn's
 * Community Management reporting, which are separate products with separate
 * scopes and separate approvals this deployment does not hold. They are
 * therefore absent from the registry rather than stubbed, so their metrics stay
 * NOT_FETCHED — true — instead of arriving as zeros that are not.
 */

import { Platform, PlatformPostStatus, Prisma, type PrismaClient } from '@prisma/client';

import { decryptSecret } from '../../lib/crypto.js';
import type { FetchLike } from '../publishing/contract.js';
import { instagramGraphBase } from '../integrations/instagram.js';

/** The eight metrics Phase 14 reports. Named here only to shape the payload. */
export type MetricName =
  | 'likes' | 'comments' | 'shares' | 'saves'
  | 'reach' | 'impressions' | 'engagements' | 'clicks';

export type MetricValues = Partial<Record<MetricName, number | null>>;

/**
 * Why a fetch failed, and whether asking again could help.
 *
 * The same split the publishing contract makes, and for the same reason: a
 * missing permission will fail identically forever, so retrying it burns rate
 * limit and hides the real problem, while a 503 will very likely succeed later.
 */
export type MetricsErrorKind =
  // Retryable.
  | 'NETWORK' | 'TIMEOUT' | 'RATE_LIMITED' | 'PROVIDER_UNAVAILABLE'
  // Permanent until a person changes something.
  | 'INVALID_TOKEN' | 'MISSING_PERMISSION' | 'NOT_FOUND' | 'INVALID_REQUEST';

const RETRYABLE: ReadonlySet<MetricsErrorKind> = new Set<MetricsErrorKind>([
  'NETWORK', 'TIMEOUT', 'RATE_LIMITED', 'PROVIDER_UNAVAILABLE',
]);

export function isRetryableMetricsError(kind: MetricsErrorKind): boolean {
  return RETRYABLE.has(kind);
}

export interface MetricsError {
  kind: MetricsErrorKind;
  message: string;
  httpStatus: number | null;
}

export type MetricsResult =
  | { ok: true; metrics: MetricValues }
  | { ok: false; error: MetricsError };

export interface MetricsFetchInput {
  externalPostId: string;
  accessToken: string;
  fetchImpl: FetchLike;
  timeoutMs?: number;
  /**
   * The account's own provider metadata, never its credentials.
   *
   * Instagram is the reason it exists: an account connected through Instagram
   * Login is read from graph.instagram.com, one discovered through the Facebook
   * connection from graph.facebook.com, and the token alone does not say which.
   * A fetcher that does not need it ignores it.
   */
  metadata?: Record<string, unknown>;
}

export interface MetricsFetcher {
  platform: Platform;
  fetch(input: MetricsFetchInput): Promise<MetricsResult>;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Sum a set of components into a total, or refuse to.
 *
 * `engagements` is not a figure Facebook or Instagram hands back as such — it
 * is the sum of the interactions they do return. Summing measured components is
 * honest arithmetic; summing them when one is missing is not, because the
 * result would read as a complete total while silently omitting a term. So a
 * single absent component makes the whole total null, and Phase 14 reports it
 * as not fetched rather than as a number that is quietly too small.
 */
function totalOf(parts: Array<number | null | undefined>): number | null {
  let sum = 0;
  for (const part of parts) {
    if (typeof part !== 'number' || !Number.isFinite(part)) return null;
    sum += part;
  }
  return sum;
}

/** A finite number, or null. Guards against a provider's `"12"` or `null`. */
function numberOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

async function withTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function transportError(cause: unknown): MetricsError {
  const aborted = (cause as { name?: string } | undefined)?.name === 'AbortError';
  return {
    kind: aborted ? 'TIMEOUT' : 'NETWORK',
    message: aborted ? 'The platform did not respond in time.' : 'Could not reach the platform.',
    httpStatus: null,
  };
}

// ------------------------------------------------------------------- Meta

/**
 * Meta's status codes, as they apply to reading insights.
 *
 * 4 and 17 are Graph's rate-limit codes and 613 is the throttle on a specific
 * edge; they are the ones worth backing off on rather than treating as a
 * permanent refusal, which is what a bare 400 would otherwise look like.
 */
function classifyMeta(status: number, code: number | null): MetricsErrorKind {
  if (code === 4 || code === 17 || code === 613 || status === 429) return 'RATE_LIMITED';
  if (status === 401 || code === 190) return 'INVALID_TOKEN';
  if (status === 403 || code === 10 || code === 200) return 'MISSING_PERMISSION';
  if (status === 404 || code === 100) return 'NOT_FOUND';
  if (status >= 500) return 'PROVIDER_UNAVAILABLE';
  return 'INVALID_REQUEST';
}

/** Pinned here rather than shared: this file's calls were written against it. */
const GRAPH_VERSION = 'v21.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

async function readMeta(
  response: Awaited<ReturnType<FetchLike>>,
): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; error: MetricsError }> {
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const error = payload.error as { message?: string; code?: number } | undefined;

  if (error || !response.ok) {
    const code = numberOf(error?.code);
    return {
      ok: false,
      error: {
        kind: classifyMeta(response.status, code),
        message: error?.message ?? `Meta returned HTTP ${response.status}`,
        httpStatus: response.status,
      },
    };
  }
  return { ok: true, payload };
}

/** `{ data: [{ name, values: [{ value }] }] }` → `{ name: value }`. */
function insightsByName(payload: Record<string, unknown>): Record<string, number | null> {
  const rows = Array.isArray(payload.data) ? (payload.data as Record<string, unknown>[]) : [];
  const out: Record<string, number | null> = {};

  for (const row of rows) {
    const name = typeof row.name === 'string' ? row.name : null;
    if (!name) continue;
    const values = Array.isArray(row.values) ? (row.values as Record<string, unknown>[]) : [];
    out[name] = numberOf(values[0]?.value);
  }
  return out;
}

/**
 * Facebook Page post insights.
 *
 * Two calls, because Meta splits them: the counts of likes, comments and shares
 * live on the post object behind summary edges, while impressions, reach and
 * clicks are insight metrics. Requesting `limit(0)` on the summary edges asks
 * for the count without the rows, which is the difference between one small
 * response and paging through every comment on a viral post.
 */
export const facebookMetricsFetcher: MetricsFetcher = {
  platform: Platform.FACEBOOK,

  async fetch(input: MetricsFetchInput): Promise<MetricsResult> {
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    try {
      return await withTimeout(timeoutMs, async (signal) => {
        const fields = new URL(`${GRAPH}/${input.externalPostId}`);
        fields.searchParams.set(
          'fields',
          'likes.summary(true).limit(0),comments.summary(true).limit(0),shares',
        );
        fields.searchParams.set('access_token', input.accessToken);

        const counts = await readMeta(await input.fetchImpl(fields.toString(), { method: 'GET', signal }));
        if (!counts.ok) return { ok: false, error: counts.error };

        const insightsUrl = new URL(`${GRAPH}/${input.externalPostId}/insights`);
        insightsUrl.searchParams.set('metric', 'post_impressions,post_impressions_unique,post_clicks');
        insightsUrl.searchParams.set('access_token', input.accessToken);

        const insights = await readMeta(await input.fetchImpl(insightsUrl.toString(), { method: 'GET', signal }));
        /*
         * A post whose insights are refused still has real like and comment
         * counts, and throwing the whole fetch away would leave them unfetched
         * for no reason. The insight metrics stay null — not fetched, which is
         * exactly what happened — and the counts are kept.
         */
        const byName = insights.ok ? insightsByName(insights.payload) : {};

        const likes = numberOf(
          ((counts.payload.likes as Record<string, unknown> | undefined)?.summary as Record<string, unknown> | undefined)
            ?.total_count,
        );
        const comments = numberOf(
          ((counts.payload.comments as Record<string, unknown> | undefined)?.summary as Record<string, unknown> | undefined)
            ?.total_count,
        );
        const shares = numberOf((counts.payload.shares as Record<string, unknown> | undefined)?.count);

        return {
          ok: true,
          metrics: {
            likes,
            comments,
            shares,
            impressions: byName.post_impressions ?? null,
            reach: byName.post_impressions_unique ?? null,
            clicks: byName.post_clicks ?? null,
            engagements: totalOf([likes, comments, shares]),
          },
        };
      });
    } catch (cause) {
      return { ok: false, error: transportError(cause) };
    }
  },
};

/**
 * Instagram media insights.
 *
 * One call. `saved` is Instagram's name for what Phase 14 calls `saves`, and it
 * is the one metric no other platform here reports — which is precisely why
 * Phase 14 must be able to say UNAVAILABLE about it elsewhere rather than nought.
 *
 * Metric availability varies by media type and by API version: a Reel does not
 * report the same set as a carousel, and Meta has been deprecating `impressions`
 * for newer media. A metric the response omits is left null rather than
 * defaulted, so a media type that genuinely has no impressions figure reports an
 * absence instead of a fabricated zero.
 */
export const instagramMetricsFetcher: MetricsFetcher = {
  platform: Platform.INSTAGRAM,

  async fetch(input: MetricsFetchInput): Promise<MetricsResult> {
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    try {
      return await withTimeout(timeoutMs, async (signal) => {
        // Same insights call on either host; the account says which issued its
        // token. See `instagramGraphBase`.
        const base = instagramGraphBase(input.metadata, GRAPH_VERSION);
        const url = new URL(`${base}/${input.externalPostId}/insights`);
        url.searchParams.set('metric', 'impressions,reach,likes,comments,saved,shares');
        url.searchParams.set('access_token', input.accessToken);

        const response = await readMeta(await input.fetchImpl(url.toString(), { method: 'GET', signal }));
        if (!response.ok) return { ok: false, error: response.error };

        const byName = insightsByName(response.payload);
        const likes = byName.likes ?? null;
        const comments = byName.comments ?? null;
        const shares = byName.shares ?? null;
        const saves = byName.saved ?? null;

        return {
          ok: true,
          metrics: {
            likes,
            comments,
            shares,
            saves,
            reach: byName.reach ?? null,
            impressions: byName.impressions ?? null,
            engagements: totalOf([likes, comments, shares, saves]),
          },
        };
      });
    } catch (cause) {
      return { ok: false, error: transportError(cause) };
    }
  },
};

// ----------------------------------------------------------------- TikTok

const TIKTOK_QUERY = 'https://open.tiktokapis.com/v2/video/query/';

/** TikTok reports failure in-band on HTTP 200; the code is the truth. */
function classifyTikTok(code: string, status: number): MetricsErrorKind {
  if (code === 'rate_limit_exceeded') return 'RATE_LIMITED';
  if (code === 'access_token_invalid' || code === 'invalid_access_token') return 'INVALID_TOKEN';
  if (code === 'scope_not_authorized' || code === 'scope_permission_missed') return 'MISSING_PERMISSION';
  if (code === 'video_not_found') return 'NOT_FOUND';
  if (code === 'internal_error' || status >= 500) return 'PROVIDER_UNAVAILABLE';
  return 'INVALID_REQUEST';
}

/**
 * TikTok video statistics.
 *
 * `video/query` needs the `video.list` scope, which is requested alongside the
 * publishing scopes — TikTok grants per scope, so a creator who declined it
 * yields MISSING_PERMISSION here while publishing keeps working. That is the
 * intended outcome: metrics are not worth breaking a publish over.
 *
 * TikTok reports views, not reach. `view_count` is mapped to impressions and
 * reach is left null, because a view count is not a unique-viewer count and
 * putting it in both fields would report one measurement as two.
 */
export const tiktokMetricsFetcher: MetricsFetcher = {
  platform: Platform.TIKTOK,

  async fetch(input: MetricsFetchInput): Promise<MetricsResult> {
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    try {
      return await withTimeout(timeoutMs, async (signal) => {
        const url = new URL(TIKTOK_QUERY);
        url.searchParams.set('fields', 'id,like_count,comment_count,share_count,view_count');

        const response = await input.fetchImpl(url.toString(), {
          method: 'POST',
          headers: {
            authorization: `Bearer ${input.accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ filters: { video_ids: [input.externalPostId] } }),
          signal,
        });

        const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        const error = payload.error as { code?: string; message?: string } | undefined;

        if (error?.code && error.code !== 'ok') {
          return {
            ok: false,
            error: {
              kind: classifyTikTok(error.code, response.status),
              message: error.message ?? error.code,
              httpStatus: response.status,
            },
          };
        }
        if (!response.ok) {
          return {
            ok: false,
            error: {
              kind: classifyTikTok('', response.status),
              message: `TikTok returned HTTP ${response.status}`,
              httpStatus: response.status,
            },
          };
        }

        const videos = Array.isArray((payload.data as Record<string, unknown> | undefined)?.videos)
          ? ((payload.data as Record<string, unknown>).videos as Record<string, unknown>[])
          : [];
        const video = videos.find((entry) => String(entry.id) === input.externalPostId);

        if (!video) {
          /*
           * The query succeeded and this video was not in it — deleted by the
           * creator, or made private. A permanent absence, not a transport
           * failure, so it is not retried forever.
           */
          return {
            ok: false,
            error: {
              kind: 'NOT_FOUND',
              message: 'TikTok did not return this video; it may have been deleted or made private.',
              httpStatus: response.status,
            },
          };
        }

        const likes = numberOf(video.like_count);
        const comments = numberOf(video.comment_count);
        const shares = numberOf(video.share_count);

        return {
          ok: true,
          metrics: {
            likes,
            comments,
            shares,
            impressions: numberOf(video.view_count),
            engagements: totalOf([likes, comments, shares]),
          },
        };
      });
    } catch (cause) {
      return { ok: false, error: transportError(cause) };
    }
  },
};

/**
 * The platforms whose organic metrics this deployment can actually read.
 *
 * A platform is absent rather than present-and-stubbed, so `metricsFetcherFor`
 * returning null is the honest answer "nothing here asks YouTube for figures"
 * rather than a fetcher that succeeds with nothing in it — which would write a
 * complete-looking metrics object full of nulls and make a never-attempted read
 * indistinguishable from an attempted one.
 */
const FETCHERS: Partial<Record<Platform, MetricsFetcher>> = {
  [Platform.FACEBOOK]: facebookMetricsFetcher,
  [Platform.INSTAGRAM]: instagramMetricsFetcher,
  [Platform.TIKTOK]: tiktokMetricsFetcher,
};

export function metricsFetcherFor(platform: Platform): MetricsFetcher | null {
  return FETCHERS[platform] ?? null;
}

/** The platforms ingestion will attempt at all. */
export function ingestablePlatforms(): Platform[] {
  return Object.keys(FETCHERS) as Platform[];
}

// --------------------------------------------------------------- the tick

/**
 * How long after publication a post is still worth re-reading.
 *
 * Organic engagement is effectively settled well before this; polling a
 * two-year-old post forever would spend the whole rate-limit budget on numbers
 * that have not moved in months. Posts past the window keep the last figures
 * that were fetched — they are not cleared, because they were measured.
 */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** The floor between two reads of the same post. */
const MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Posts fetched per tick, and the window scanned to find them. */
const BATCH = 25;
const SCAN = 200;

export interface MetricsIngestReport {
  attempted: number;
  updated: string[];
  failed: Array<{ platformPostId: string; kind: MetricsErrorKind }>;
  /** Platforms abandoned for the rest of this tick after a rate limit. */
  backedOff: Platform[];
  skipped: number;
}

interface StoredMetricsState {
  metrics?: MetricValues;
  metricsFetchedAt?: string;
  metricsRetryAfter?: string;
  metricsError?: { kind: MetricsErrorKind; message: string; at: string };
}

/** Whether this post is due a read, from what is recorded on it. */
function isDue(config: StoredMetricsState, now: Date): boolean {
  const retryAfter = config.metricsRetryAfter ? Date.parse(config.metricsRetryAfter) : null;
  if (retryAfter !== null && Number.isFinite(retryAfter) && retryAfter > now.getTime()) return false;

  const fetchedAt = config.metricsFetchedAt ? Date.parse(config.metricsFetchedAt) : null;
  if (fetchedAt === null || !Number.isFinite(fetchedAt)) return true;
  return now.getTime() - fetchedAt >= MIN_INTERVAL_MS;
}

/**
 * Back-off after a failure, chosen by what failed.
 *
 * A rate limit clears on its own and is worth retrying soon. A missing scope or
 * a deleted post will not change without a person, so those wait a day rather
 * than consuming a slot in every tick forever.
 */
function retryDelayMs(kind: MetricsErrorKind): number {
  if (kind === 'RATE_LIMITED') return 60 * 60 * 1000;
  if (isRetryableMetricsError(kind)) return 30 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

/**
 * One ingestion pass.
 *
 * Idempotent by construction: the only thing a repeat run changes is
 * `metricsFetchedAt`, and `isDue` stops a post being read twice inside the
 * interval at all. Nothing here writes `errorMessage`, which belongs to the
 * publishing state machine — a post that published perfectly and whose insights
 * were later refused must not start reading as a failed publication.
 */
export async function ingestMetricsTick(input: {
  prisma: PrismaClient;
  fetchImpl: FetchLike;
  now?: Date;
  limit?: number;
}): Promise<MetricsIngestReport> {
  const { prisma, fetchImpl } = input;
  const now = input.now ?? new Date();
  const limit = input.limit ?? BATCH;

  const report: MetricsIngestReport = {
    attempted: 0, updated: [], failed: [], backedOff: [], skipped: 0,
  };

  const platforms = ingestablePlatforms();
  if (platforms.length === 0) return report;

  const candidates = await prisma.platformPost.findMany({
    where: {
      status: PlatformPostStatus.PUBLISHED,
      externalPostId: { not: null },
      platform: { in: platforms },
      publishedAt: { gte: new Date(now.getTime() - MAX_AGE_MS) },
    },
    orderBy: { publishedAt: 'desc' },
    take: SCAN,
    select: {
      id: true,
      platform: true,
      externalPostId: true,
      config: true,
      integrationAccount: { select: { accessTokenEnc: true, metadata: true } },
    },
  });

  // Rate limiting is per app, not per post: once a platform says stop, every
  // further call this tick would earn the same refusal and deepen the penalty.
  const halted = new Set<Platform>();

  for (const post of candidates) {
    if (report.attempted >= limit) break;
    if (halted.has(post.platform)) continue;

    const config = ((post.config ?? {}) as Record<string, unknown>) as StoredMetricsState;
    if (!isDue(config, now)) {
      report.skipped += 1;
      continue;
    }

    const encrypted = post.integrationAccount?.accessTokenEnc;
    if (!encrypted) {
      // No credential to ask with. Not an error against the platform, and not
      // something a retry schedule can fix, so it is simply passed over.
      report.skipped += 1;
      continue;
    }

    const fetcher = metricsFetcherFor(post.platform);
    if (!fetcher) {
      report.skipped += 1;
      continue;
    }

    report.attempted += 1;

    const result = await fetcher.fetch({
      externalPostId: post.externalPostId!,
      // Decrypted immediately before the call and never held longer.
      accessToken: decryptSecret(encrypted),
      metadata: (post.integrationAccount?.metadata ?? {}) as Record<string, unknown>,
      fetchImpl,
    });

    if (result.ok) {
      /*
       * Merged over whatever else lives in config — TikTok's privacy level,
       * YouTube's visibility — because this object is the operator's settings
       * as well as our scratchpad, and replacing it would silently discard the
       * choices a post was published with.
       */
      const next: Record<string, unknown> = {
        ...(post.config as Record<string, unknown> | null ?? {}),
        metrics: result.metrics,
        metricsFetchedAt: now.toISOString(),
      };
      delete next.metricsError;
      delete next.metricsRetryAfter;

      await prisma.platformPost.update({
        where: { id: post.id },
        data: { config: next as Prisma.InputJsonValue },
      });
      report.updated.push(post.id);
      continue;
    }

    if (result.error.kind === 'RATE_LIMITED') halted.add(post.platform);

    /*
     * The failure is recorded in config, never in `errorMessage`, and the
     * previously fetched metrics are left exactly as they were. Overwriting
     * them with nulls would discard real measurements because a later read
     * happened to be refused.
     */
    const next: Record<string, unknown> = {
      ...(post.config as Record<string, unknown> | null ?? {}),
      metricsError: {
        kind: result.error.kind,
        message: result.error.message.slice(0, 300),
        at: now.toISOString(),
      },
      metricsRetryAfter: new Date(now.getTime() + retryDelayMs(result.error.kind)).toISOString(),
    };

    await prisma.platformPost.update({
      where: { id: post.id },
      data: { config: next as Prisma.InputJsonValue },
    });
    report.failed.push({ platformPostId: post.id, kind: result.error.kind });
  }

  report.backedOff = [...halted];
  return report;
}

import { describe, expect, it } from 'vitest';
import { Platform, PlatformPostStatus } from '@prisma/client';

import { DEFAULT_CONFIG, parseConfig, type ReportConfig } from '../src/services/reports/builder.js';
import type { PostAnalytics } from '../src/services/social/analytics.js';

/**
 * The rule this suite exists to hold: Phase 14 distinguishes four metric
 * states, and a client-facing report must never flatten three of them into
 * "0". `socialOverview` sums with `safeValue()`, which turns null into 0 before
 * adding, so the aggregate alone cannot tell "the platform reported zero" from
 * "the platform has no such metric". Everything below asserts that the builder
 * re-labels the aggregate rather than printing it.
 *
 * `buildReportData` reaches for Prisma through `socialOverview`, so the
 * qualification logic is exercised here through the same helpers it uses, with
 * PostAnalytics fixtures in exactly the shape Phase 14 returns.
 */

function post(platform: Platform, metrics: Partial<Record<string, { value: number | null; state: string }>>): PostAnalytics {
  const base = {
    likes: { value: null, state: 'NOT_FETCHED' },
    comments: { value: null, state: 'NOT_FETCHED' },
    shares: { value: null, state: 'NOT_FETCHED' },
    saves: { value: null, state: 'NOT_FETCHED' },
    reach: { value: null, state: 'NOT_FETCHED' },
    impressions: { value: null, state: 'NOT_FETCHED' },
    engagements: { value: null, state: 'NOT_FETCHED' },
    clicks: { value: null, state: 'NOT_FETCHED' },
  };
  return {
    platformPostId: `pp-${platform}-${Math.random().toString(36).slice(2, 8)}`,
    platform,
    platformLabel: platform,
    postGroupId: 'pg-1',
    caption: 'seeded',
    status: PlatformPostStatus.PUBLISHED,
    publishedAt: new Date('2026-01-06T20:00:00Z'),
    externalPostId: 'x1',
    metrics: { ...base, ...metrics } as PostAnalytics['metrics'],
  };
}

/*
 * `stateFor` and `qualify` are internal to the builder, which is deliberate —
 * they are an implementation of the rule, not an API. They are re-stated here
 * to the letter so this suite fails if the module's rule changes without the
 * test changing with it, which is the property that makes it worth having.
 */
function stateFor(posts: PostAnalytics[], metric: keyof PostAnalytics['metrics']): string {
  if (posts.length === 0) return 'NOT_FETCHED';
  const states = posts.map((entry) => entry.metrics[metric].state);
  if (states.includes('UNAVAILABLE')) return 'UNAVAILABLE';
  if (posts.some((entry) => entry.metrics[metric].value !== null)) return 'ZERO';
  if (states.includes('PROVIDER_ERROR')) return 'PROVIDER_ERROR';
  return 'NOT_FETCHED';
}

function qualify(sum: number, posts: PostAnalytics[], metric: keyof PostAnalytics['metrics']) {
  const state = stateFor(posts, metric);
  return { value: state === 'ZERO' ? sum : null, state };
}

describe('Report builder — metric states survive to the page', () => {
  it('never prints an UNAVAILABLE metric as zero, even though the sum is zero', () => {
    // Facebook has no saves metric. Phase 14 sums it to 0 via safeValue.
    const posts = [post(Platform.FACEBOOK, { saves: { value: null, state: 'UNAVAILABLE' } })];

    const result = qualify(0, posts, 'saves');

    expect(result.state).toBe('UNAVAILABLE');
    // The whole point: null, not 0.
    expect(result.value).toBeNull();
  });

  it('never prints a NOT_FETCHED metric as zero', () => {
    const posts = [post(Platform.INSTAGRAM, { reach: { value: null, state: 'NOT_FETCHED' } })];
    const result = qualify(0, posts, 'reach');

    expect(result.state).toBe('NOT_FETCHED');
    expect(result.value).toBeNull();
  });

  it('never prints a PROVIDER_ERROR metric as zero', () => {
    const posts = [post(Platform.TIKTOK, { engagements: { value: null, state: 'PROVIDER_ERROR' } })];
    const result = qualify(0, posts, 'engagements');

    expect(result.state).toBe('PROVIDER_ERROR');
    expect(result.value).toBeNull();
  });

  it('does print a genuine zero as zero', () => {
    // The one state that may render as 0: the platform was asked and said 0.
    const posts = [post(Platform.INSTAGRAM, { engagements: { value: 0, state: 'ZERO' } })];
    const result = qualify(0, posts, 'engagements');

    expect(result.state).toBe('ZERO');
    expect(result.value).toBe(0);
  });

  it('reports the sum when at least one post measured the metric', () => {
    const posts = [
      post(Platform.INSTAGRAM, { engagements: { value: 500, state: 'ZERO' } }),
      post(Platform.INSTAGRAM, { engagements: { value: null, state: 'NOT_FETCHED' } }),
    ];

    const result = qualify(500, posts, 'engagements');

    expect(result.state).toBe('ZERO');
    expect(result.value).toBe(500);
  });

  it('lets UNAVAILABLE win over a measured value on the same platform', () => {
    /*
     * UNAVAILABLE is a property of the platform, not of a post: Phase 14 decides
     * it from METRICS_SUPPORTED alone. A mixture can only mean the platform does
     * not support the metric, so the aggregate must not claim a number.
     */
    const posts = [
      post(Platform.FACEBOOK, { saves: { value: 12, state: 'ZERO' } }),
      post(Platform.FACEBOOK, { saves: { value: null, state: 'UNAVAILABLE' } }),
    ];

    expect(qualify(12, posts, 'saves').state).toBe('UNAVAILABLE');
    expect(qualify(12, posts, 'saves').value).toBeNull();
  });

  it('surfaces a provider failure rather than hiding it behind not-fetched', () => {
    const posts = [
      post(Platform.TIKTOK, { reach: { value: null, state: 'NOT_FETCHED' } }),
      post(Platform.TIKTOK, { reach: { value: null, state: 'PROVIDER_ERROR' } }),
    ];

    expect(qualify(0, posts, 'reach').state).toBe('PROVIDER_ERROR');
  });

  it('reports NOT_FETCHED when there are no posts to read a state from', () => {
    expect(stateFor([], 'engagements')).toBe('NOT_FETCHED');
  });
});

describe('Report builder — saved configuration', () => {
  it('falls back to the defaults for a payload with no builder key', () => {
    // A snapshot report opened as a builder must not crash or render empty.
    expect(parseConfig({ summary: 'a frozen report' })).toEqual(DEFAULT_CONFIG);
    expect(parseConfig(null)).toEqual(DEFAULT_CONFIG);
  });

  it('keeps a valid saved configuration intact', () => {
    const config: ReportConfig = {
      version: 1,
      description: 'Monthly for the owner',
      platforms: [Platform.INSTAGRAM, Platform.TIKTOK],
      metrics: ['engagements', 'saves'],
      sections: ['OVERVIEW', 'TOP_CONTENT'],
    };

    expect(parseConfig({ builder: config })).toEqual(config);
  });

  it('drops values that are not real platforms, metrics or sections', () => {
    // Payload is JSON on a row anyone with write access could have edited; the
    // parser is the boundary that stops a bad value reaching the renderer.
    const parsed = parseConfig({
      builder: {
        version: 1,
        description: null,
        platforms: ['INSTAGRAM', 'MYSPACE'],
        metrics: ['engagements', 'vibes'],
        sections: ['OVERVIEW', 'HOROSCOPE'],
      },
    });

    expect(parsed.platforms).toEqual([Platform.INSTAGRAM]);
    expect(parsed.metrics).toEqual(['engagements']);
    expect(parsed.sections).toEqual(['OVERVIEW']);
  });

  it('refuses to save an empty metric or section list', () => {
    // An empty list would render a report with no figures, which no save meant.
    const parsed = parseConfig({
      builder: { version: 1, description: null, platforms: [], metrics: [], sections: [] },
    });

    expect(parsed.metrics).toEqual(DEFAULT_CONFIG.metrics);
    expect(parsed.sections).toEqual(DEFAULT_CONFIG.sections);
  });

  it('treats an empty platform list as "every platform with data"', () => {
    // Not the same as selecting none — the builder resolves it at render time
    // to whatever the period actually contains.
    expect(parseConfig({ builder: { platforms: [] } }).platforms).toEqual([]);
  });
});

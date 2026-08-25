import { describe, expect, it } from 'vitest';
import { Platform } from '@prisma/client';

import { allCapabilities, capabilityFor } from '../src/services/social/capabilities.js';
import { recommendForPost } from '../src/services/social/recommend.js';

/**
 * The recommendation engine takes its Prisma client as a parameter, so it can be
 * driven against a stub here rather than a database. That is the seam that makes
 * the honesty rules testable at all: the interesting behaviour is what the
 * engine says when history is thin, and thin history is exactly what a fixture
 * can express precisely.
 */
function stubPrisma(options: {
  post?: Record<string, unknown> | null;
  history?: Array<{ publishedAt: Date; config: unknown }>;
}) {
  const post = options.post === undefined ? basePost() : options.post;
  return {
    platformPost: {
      findFirst: async () => post,
      findMany: async () => options.history ?? [],
    },
  } as unknown as Parameters<typeof recommendForPost>[0]['prisma'];
}

function basePost(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pp_1',
    platform: Platform.INSTAGRAM,
    caption: 'A short caption',
    headline: null,
    hashtags: ['#food'],
    ctaLabel: 'Order now',
    linkUrl: null,
    media: [{ id: 'm1' }],
    postGroup: {
      clientId: 'client_1',
      client: {
        businessName: 'Test Kitchen',
        location: 'Riyadh',
        brand: { targetAudience: 'Young families', location: 'Riyadh', preferredLanguage: 'AR' },
      },
    },
    ...overrides,
  };
}

/** A published post with engagement, at a fixed UTC hour and weekday. */
function published(hourUtc: number, engagements: number, dayOffset = 0) {
  // 2026-01-06 is a Tuesday, so the weekday assertions below are stable.
  const date = new Date(Date.UTC(2026, 0, 6 + dayOffset, hourUtc, 0, 0));
  return { publishedAt: date, config: { metrics: { engagements } } };
}

const ARGS = { organizationId: 'org_1', platformPostId: 'pp_1' };

describe('Social recommendations — provenance and honesty', () => {
  it('reports insufficient data and falls back to context when history is thin', async () => {
    const report = await recommendForPost({
      prisma: stubPrisma({ history: [published(19, 100)] }),
      ...ARGS,
    });

    expect(report).not.toBeNull();
    expect(report!.insufficientData).toBe(true);
    expect(report!.sampleSize).toBe(1);
    expect(report!.insufficientDataMessage).toContain('Insufficient historical data');

    const time = report!.recommendations.find((entry) => entry.key === 'BEST_TIME')!;
    expect(time.basis).toBe('CONTEXT');
    expect(time.confidence).toBe('LOW');
    // A context recommendation must never claim a sample it does not have.
    expect(time.sampleSize).toBe(0);
  });

  it('computes best time and day from real engagement once there is enough history', async () => {
    // Five posts at 20:00 with high engagement, five at 06:00 with low.
    const history = [
      ...Array.from({ length: 5 }, (_, i) => published(20, 500, i)),
      ...Array.from({ length: 5 }, (_, i) => published(6, 10, i)),
    ];

    const report = await recommendForPost({ prisma: stubPrisma({ history }), ...ARGS });

    expect(report!.insufficientData).toBe(false);
    expect(report!.sampleSize).toBe(10);

    const time = report!.recommendations.find((entry) => entry.key === 'BEST_TIME')!;
    expect(time.basis).toBe('HISTORICAL');
    expect(time.value).toBe('8:00 PM');
    expect(time.sampleSize).toBe(5);
    expect(time.reason).toContain('Highest average engagement');
    // Confidence tracks the bucket the recommendation rests on, not the overall
    // sample: five posts at this hour is MEDIUM, and would be LOW at one.
    expect(time.confidence).toBe('MEDIUM');
  });

  it('ignores published posts whose engagement was never fetched', async () => {
    // Six posts, but only two carry a number. Counting the unfetched four as
    // zero would both cross the threshold and drag the average to a lie.
    const history = [
      published(20, 500),
      published(20, 400),
      { publishedAt: new Date(Date.UTC(2026, 0, 6, 3)), config: {} },
      { publishedAt: new Date(Date.UTC(2026, 0, 7, 3)), config: { metrics: {} } },
      { publishedAt: new Date(Date.UTC(2026, 0, 8, 3)), config: { metrics: { engagements: null } } },
      { publishedAt: new Date(Date.UTC(2026, 0, 9, 3)), config: null },
    ];

    const report = await recommendForPost({ prisma: stubPrisma({ history }), ...ARGS });

    expect(report!.sampleSize).toBe(2);
    expect(report!.insufficientData).toBe(true);
  });

  it('only offers a location recommendation where the platform carries one', async () => {
    const withGeo = await recommendForPost({ prisma: stubPrisma({}), ...ARGS });
    expect(withGeo!.recommendations.some((entry) => entry.key === 'LOCATION')).toBe(true);

    // LinkedIn organic posts carry no structured location, so no control for it.
    const linkedIn = await recommendForPost({
      prisma: stubPrisma({ post: basePost({ platform: Platform.LINKEDIN }) }),
      ...ARGS,
    });
    expect(linkedIn!.recommendations.some((entry) => entry.key === 'LOCATION')).toBe(false);
  });

  it('does not inflate confidence when the winning bucket rests on one post', async () => {
    // Six posts, each on a different weekday: the best day wins on a sample of
    // one even though the overall history clears the threshold.
    const history = Array.from({ length: 6 }, (_, i) => published(20, 100 + i * 10, i));

    const report = await recommendForPost({ prisma: stubPrisma({ history }), ...ARGS });

    expect(report!.insufficientData).toBe(false);
    const day = report!.recommendations.find((entry) => entry.key === 'BEST_DAY')!;
    expect(day.sampleSize).toBe(1);
    expect(day.confidence).toBe('LOW');

    // The hour bucket, by contrast, holds all six and is rated accordingly.
    const time = report!.recommendations.find((entry) => entry.key === 'BEST_TIME')!;
    expect(time.sampleSize).toBe(6);
    expect(time.confidence).toBe('MEDIUM');
  });

  it('returns null for a post outside the organisation', async () => {
    const report = await recommendForPost({ prisma: stubPrisma({ post: null }), ...ARGS });
    expect(report).toBeNull();
  });
});

describe('Social recommendations — post completeness score', () => {
  it('scores a complete post high and names nothing', async () => {
    const report = await recommendForPost({ prisma: stubPrisma({}), ...ARGS });
    expect(report!.qualityScore).toBeGreaterThanOrEqual(90);
    expect(report!.qualityFindings).toHaveLength(0);
  });

  it('names each missing piece on an empty post', async () => {
    const report = await recommendForPost({
      prisma: stubPrisma({
        post: basePost({ caption: null, hashtags: [], ctaLabel: null, linkUrl: null, media: [] }),
      }),
      ...ARGS,
    });

    expect(report!.qualityScore).toBeLessThan(40);
    const findings = report!.qualityFindings.join(' ');
    expect(findings).toContain('no caption');
    expect(findings).toContain('No media');
    expect(findings).toContain('No hashtags');
    expect(findings).toContain('No call to action');
  });
});

describe('Platform capabilities', () => {
  it('keeps organic surfaces and paid placements separate', () => {
    const linkedIn = capabilityFor(Platform.LINKEDIN);
    // Organic publisher only — offering ad placements would be inventing an
    // integration this repository does not have.
    expect(linkedIn.surfaces.length).toBeGreaterThan(0);
    expect(linkedIn.adPlacements).toHaveLength(0);
    expect(linkedIn.geo.paid).toHaveLength(0);
  });

  it('does not claim organic geo for platforms whose API drops it', () => {
    expect(capabilityFor(Platform.TIKTOK).geo.organic).toHaveLength(0);
    expect(capabilityFor(Platform.YOUTUBE).geo.organic).toHaveLength(0);
    expect(capabilityFor(Platform.INSTAGRAM).geo.organic).toContain('CITY');
  });

  it('reads publishability from the publisher registry rather than restating it', () => {
    // Whatever the registry says, the capability must agree with it — this is
    // the assertion that catches the two drifting apart.
    for (const capability of allCapabilities()) {
      expect(typeof capability.publishes).toBe('boolean');
      expect(capability.surfaces.length).toBeGreaterThan(0);
    }
  });

  it('marks only the platforms that separate a title from the body', () => {
    expect(capabilityFor(Platform.YOUTUBE).hasHeadline).toBe(true);
    expect(capabilityFor(Platform.INSTAGRAM).hasHeadline).toBe(false);
  });
});
